package anchor

import io.ktor.client.HttpClient
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.api.createClientPlugin
import io.ktor.client.plugins.timeout
import io.ktor.client.request.bearerAuth
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.forms.MultiPartFormDataContent
import io.ktor.client.request.forms.formData
import io.ktor.client.request.parameter
import io.ktor.client.request.patch
import io.ktor.client.request.post
import io.ktor.client.request.prepareGet
import io.ktor.client.request.request
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsChannel
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.Headers
import io.ktor.http.HttpMethod
import io.ktor.http.HttpHeaders
import io.ktor.http.URLProtocol
import io.ktor.http.Url
import io.ktor.http.contentType
import io.ktor.http.encodeURLPathPart
import io.ktor.http.encodeURLParameter
import io.ktor.http.isSuccess
import io.ktor.http.content.ChannelWriterContent
import io.ktor.utils.io.readAvailable
import io.ktor.utils.io.readFully
import io.ktor.utils.io.readLineStrict
import io.ktor.utils.io.writeFully
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.long
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import kotlin.time.Instant
import kotlin.time.Clock

internal class AnchorSession(
    val origin: String,
    val userId: String,
    var accessToken: String,
    var refreshToken: String?,
) {
    val tokenLock = Mutex()
    val expired = MutableStateFlow(false)
}

internal class AnchorHttpFailure(val status: Int, val code: String? = null) : Exception("HTTP $status") {
    val outboxScopeChanged: Boolean get() = status == 409 && code == "OUTBOX_SCOPE_CHANGED"
}

private const val outboxScopeHeader = "X-Anchor-Outbox-Scope"
private const val syncScopeHeader = "X-Anchor-Sync-Scope"

internal sealed interface AnchorSignIn {
    class Complete(val session: AnchorSession) : AnchorSignIn
    class Challenge(val origin: String, val token: String) : AnchorSignIn
    class Enrollment(val origin: String, val token: String) : AnchorSignIn
    class BrowserPasskey(val origin: String, val setup: Boolean) : AnchorSignIn
    data object PendingApproval : AnchorSignIn
}

internal class EnrollmentResult(val session: AnchorSession, val recoveryCodes: List<String>)
internal class AuthenticatorStatus(val available: Boolean, val enabled: Boolean, val remaining: Int, val policy: String)
internal data class AccountProfile(val name: String, val email: String, val hasPassword: Boolean, val picture: String?)
internal data class AnchorOidcConfiguration(val provider: String, val passwordAllowed: Boolean)

internal enum class SharePermission(val wire: String, val label: String) {
    Viewer("viewer", "Can view"), Editor("editor", "Can edit");
}

internal data class NoteContact(val id: String, val name: String, val email: String)
internal data class NoteShare(val id: String, val contact: NoteContact, val permission: SharePermission)
internal data class NoteCopy(val id: String, val undoSequence: String?)

internal class AnchorApi(
    private val sessionStore: SessionStore,
    private val serverHeaderStore: SessionStore,
    private val eraseLocalAccount: suspend (String, String) -> Unit,
) {
    private val serverHeaders = MutableStateFlow<Map<Url, Map<String, String>>>(emptyMap())
    private val http = HttpClient {
        followRedirects = false
        install(HttpTimeout) { requestTimeoutMillis = 15_000 }
        install(createClientPlugin("AnchorServerHeaders") {
            onRequest { request, _ ->
                headersFor(request.url.build()).forEach { (name, value) ->
                    if (request.headers[name] == null) request.headers.append(name, value)
                }
            }
        })
    }

    fun close() = http.close()

    private fun Url.sameServer(other: Url): Boolean =
        protocol == other.protocol && host.equals(other.host, ignoreCase = true) && port == other.port

    private fun headersFor(url: Url): Map<String, String> =
        serverHeaders.value.entries.firstOrNull { it.key.sameServer(url) }?.value.orEmpty()

    fun headersFor(server: String): Map<String, String> = headersFor(Url(origin(server)))

    suspend fun restoreServerHeaders() {
        val bytes = serverHeaderStore.read() ?: return
        serverHeaders.value = Json.parseToJsonElement(bytes.decodeToString(throwOnInvalidSequence = true)).jsonObject
            .map { (server, fields) ->
                Url(origin(server)) to validateServerHeaders(
                    fields.jsonObject.map { (name, value) -> ServerHeader(name, value.jsonPrimitive.content) },
                )
            }.toMap()
    }

    suspend fun saveServerHeaders(server: String, headers: Map<String, String>) {
        val url = Url(origin(server))
        val validated = validateServerHeaders(headers.map { (name, value) -> ServerHeader(name, value) })
        val retained = serverHeaders.value.filterKeys { !it.sameServer(url) }
        val next = if (validated.isEmpty()) retained else retained + (url to validated)
        val record = buildJsonObject {
            for ((base, fields) in next) put(base.toString(), buildJsonObject {
                for ((name, value) in fields) put(name, value)
            })
        }
        serverHeaderStore.write(record.toString().encodeToByteArray())
        serverHeaders.value = next
    }

    private suspend fun storedAccountRecord(): JsonObject? =
        sessionStore.read()?.let { Json.parseToJsonElement(it.decodeToString(throwOnInvalidSequence = true)).jsonObject }

    private suspend fun finishErasure(record: JsonObject): Boolean {
        if (record["eraseDeletedAccount"]?.jsonPrimitive?.booleanOrNull != true) return false
        val storedOrigin = record.getValue("origin").jsonPrimitive.content
        val userId = record.getValue("userId").jsonPrimitive.content
        check(storedOrigin == origin(storedOrigin) && userId.isNotBlank())
        eraseLocalAccount(storedOrigin, userId)
        sessionStore.clear()
        return true
    }

    suspend fun restoreSession(): AnchorSession? {
        val record = storedAccountRecord() ?: return null
        if (finishErasure(record)) return null
        if ("oidcVerifier" in record) return null
        val storedOrigin = record.getValue("origin").jsonPrimitive.content
        val userId = record.getValue("userId").jsonPrimitive.content
        val access = record.getValue("access_token").jsonPrimitive.content
        val refresh = record.getValue("refresh_token").jsonPrimitive.content
        check(storedOrigin == origin(storedOrigin) && userId.isNotBlank() && access.isNotBlank() && refresh.isNotBlank())
        return AnchorSession(storedOrigin, userId, access, refresh)
    }

    private suspend fun store(session: AnchorSession, access: String, refresh: String?) {
        // A new sign-in must not overwrite an interrupted erasure.
        val previous = try {
            storedAccountRecord()
        } catch (_: IllegalArgumentException) {
            null
        }
        previous?.let { finishErasure(it) }
        if (refresh == null) {
            sessionStore.clear()
        } else {
            val record = buildJsonObject {
                put("origin", session.origin)
                put("userId", session.userId)
                put("access_token", access)
                put("refresh_token", refresh)
            }
            sessionStore.write(record.toString().encodeToByteArray())
        }
    }

    suspend fun signOut(session: AnchorSession): Boolean {
        val refresh = session.tokenLock.withLock {
            sessionStore.clear()
            session.accessToken = ""
            session.refreshToken.also { session.refreshToken = null }
        } ?: return true

        return try {
            val response = http.post(session.origin + "/api/auth/logout") {
                timeout { requestTimeoutMillis = 5_000 }
                contentType(ContentType.Application.Json)
                setBody(buildJsonObject { put("refreshToken", refresh) }.toString())
            }
            response.status.isSuccess() || response.status.value == 401
        } catch (error: kotlinx.coroutines.CancellationException) {
            throw error
        } catch (_: Exception) {
            false
        }
    }

    suspend fun signIn(server: String, email: String, password: String): AnchorSignIn {
        val body = buildJsonObject {
            put("email", email.trim())
            put("password", password)
        }
        val base = origin(server)
        val response = postResponse(base, "/api/auth/login", body = body)
        val payload = response.authBody()
        if (response.status.value == 403) {
            enrollmentChallenge(base, payload)?.let { return it }
            if ((payload?.get("passkeyRequired") as? JsonPrimitive)?.booleanOrNull == true) {
                return AnchorSignIn.BrowserPasskey(base, setup = false)
            }
        }
        if (response.status.value == 401 &&
            (payload?.get("twoFactorRequired") as? JsonPrimitive)?.booleanOrNull == true
        ) {
            val challenge = (payload["challenge"] as? JsonPrimitive)?.takeIf { it.isString }?.content
            if (!challenge.isNullOrBlank() && challenge.length <= 200)
                return AnchorSignIn.Challenge(base, challenge)
        }
        return AnchorSignIn.Complete(finishSignIn(base, response, payload))
    }

    suspend fun oidcConfiguration(server: String): AnchorOidcConfiguration? {
        val response = http.get(origin(server) + "/api/auth/oidc/config")
        val body = response.authBody()
        checkAuthResponse(response, body)
        if (body?.get("enabled")?.jsonPrimitive?.booleanOrNull != true) return null
        val provider = body["providerName"]?.jsonPrimitive?.contentOrNull.orEmpty().ifBlank { "your provider" }
        return AnchorOidcConfiguration(provider, body["disableInternalAuth"]?.jsonPrimitive?.booleanOrNull != true)
    }

    private suspend fun pendingOidc(): JsonObject? {
        val record = storedAccountRecord() ?: return null
        if ("oidcVerifier" !in record) return null
        if (record.getValue("expiresAt").jsonPrimitive.long > Clock.System.now().toEpochMilliseconds()) return record
        sessionStore.clear()
        return null
    }

    suspend fun pendingOidcOrigin(): String? =
        pendingOidc()?.getValue("origin")?.jsonPrimitive?.content?.let(::origin)

    suspend fun startOidc(server: String): String {
        val base = origin(server)
        val proof = createOidcProof()
        val record = buildJsonObject {
            put("origin", base)
            put("oidcVerifier", proof.verifier)
            put("expiresAt", Clock.System.now().toEpochMilliseconds() + 10 * 60_000)
        }
        storedAccountRecord()?.let { finishErasure(it) }
        sessionStore.write(record.toString().encodeToByteArray())
        return base + "/api/auth/oidc/initiate?mobile_challenge=" + proof.challenge
    }

    suspend fun cancelOidc() {
        if (pendingOidc() != null) sessionStore.clear()
    }

    suspend fun completeOidc(url: String): AnchorSession? {
        val record = pendingOidc() ?: return null
        val code = url.removePrefix("$composeOidcReturn?code=")
        if (!Regex("^[a-f0-9]{64}$").matches(code) || !url.startsWith("$composeOidcReturn?code="))
            throw AnchorHttpFailure(400, "INVALID_LOGIN_CODE")
        val base = origin(record.getValue("origin").jsonPrimitive.content)
        val response = postResponse(base, "/api/auth/oidc/exchange/compose", body = buildJsonObject {
            put("code", code)
            put("verifier", record.getValue("oidcVerifier").jsonPrimitive.content)
        })
        return finishSignIn(base, response, response.authBody())
    }

    suspend fun registrationMode(server: String): String {
        val response = http.get(origin(server) + "/api/auth/registration-mode")
        val payload = response.authBody()
        checkAuthResponse(response, payload)
        return checkNotNull(payload).getValue("mode").jsonPrimitive.content
    }

    suspend fun register(server: String, name: String, email: String, password: String): AnchorSignIn {
        val base = origin(server)
        val response = postResponse(base, "/api/auth/register", body = buildJsonObject {
            put("name", name.trim())
            put("email", email.trim())
            put("password", password)
        })
        val payload = response.authBody()
        checkAuthResponse(response, payload)
        enrollmentChallenge(base, payload)?.let { return it }
        val user = payload?.get("user") as? JsonObject
        if (user?.get("status")?.jsonPrimitive?.content == "pending") return AnchorSignIn.PendingApproval
        return AnchorSignIn.Complete(finishSignIn(base, response, payload))
    }

    private fun enrollmentChallenge(base: String, payload: JsonObject?): AnchorSignIn? {
        if ((payload?.get("twoFactorSetupRequired") as? JsonPrimitive)?.booleanOrNull != true) return null
        val methods = payload["methods"] as? JsonObject
        val token = (payload["challenge"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        if (token.isNullOrBlank() || token.length > 200) return null
        return when {
            (methods?.get("totp") as? JsonPrimitive)?.booleanOrNull == true ->
                AnchorSignIn.Enrollment(base, token)
            (methods?.get("passkey") as? JsonPrimitive)?.booleanOrNull == true ->
                AnchorSignIn.BrowserPasskey(base, setup = true)
            else -> null
        }
    }

    suspend fun verifySignIn(challenge: AnchorSignIn.Challenge, code: String, recovery: Boolean): AnchorSession {
        val response = postResponse(challenge.origin, "/api/auth/login/2fa", body = buildJsonObject {
            put("challenge", challenge.token)
            put(if (recovery) "recoveryCode" else "code", code)
        })
        return finishSignIn(challenge.origin, response, response.authBody())
    }

    suspend fun setupEnrollment(enrollment: AnchorSignIn.Enrollment): String {
        val response = postResponse(enrollment.origin, "/api/auth/enroll/totp/setup", body = buildJsonObject {
            put("challenge", enrollment.token)
        })
        val payload = response.authBody()
        checkAuthResponse(response, payload)
        return checkNotNull(payload?.get("secret") as? JsonPrimitive).content
            .also { check(it.isNotBlank()) }
    }

    suspend fun confirmEnrollment(enrollment: AnchorSignIn.Enrollment, code: String): EnrollmentResult {
        val response = postResponse(enrollment.origin, "/api/auth/enroll/totp/enable", body = buildJsonObject {
            put("challenge", enrollment.token)
            put("code", code)
        })
        val payload = response.authBody()
        checkAuthResponse(response, payload)
        val codes = checkNotNull(payload).getValue("recoveryCodes").jsonArray.map { it.jsonPrimitive.content }
        check(codes.isNotEmpty() && codes.all { it.isNotBlank() })
        return EnrollmentResult(finishSignIn(enrollment.origin, response, payload, persist = false), codes)
    }

    suspend fun acceptEnrollment(result: EnrollmentResult) =
        store(result.session, result.session.accessToken, result.session.refreshToken)

    suspend fun accountProfile(session: AnchorSession): AccountProfile = withAccountToken(session) { token ->
        accountProfile(http.get(session.origin + "/api/auth/me") { bearerAuth(token) }, session)
    }

    suspend fun updateProfile(session: AnchorSession, name: String): String = withAccountToken(session) { token ->
        val response = http.patch(session.origin + "/api/auth/profile") {
            bearerAuth(token)
            contentType(ContentType.Application.Json)
            setBody(buildJsonObject { put("name", name) }.toString())
        }
        accountProfile(response, session).name
    }

    private suspend fun accountProfile(response: HttpResponse, session: AnchorSession): AccountProfile {
        val payload = response.authBody()
        checkAuthResponse(response, payload)
        val account = checkNotNull(payload)
        check(account.getValue("id").jsonPrimitive.content == session.userId)
        return AccountProfile(
            account["name"]?.jsonPrimitive?.contentOrNull.orEmpty(),
            account.getValue("email").jsonPrimitive.content,
            account["hasPassword"]?.jsonPrimitive?.booleanOrNull ?: false,
            account["profileImage"]?.jsonPrimitive?.contentOrNull,
        )
    }

    suspend fun uploadProfileImage(session: AnchorSession, file: PickedAttachment): String {
        require(file.mimeType in profileImageTypes && file.bytes.size in 1..maxProfileImageBytes)
        val name = "avatar." + file.mimeType.substringAfter('/')
        return withAccountToken(session) { token ->
            val response = http.post(session.origin + "/api/auth/profile/image") {
                bearerAuth(token)
                setBody(MultiPartFormDataContent(formData {
                    append("image", file.bytes, Headers.build {
                        append(HttpHeaders.ContentType, file.mimeType)
                        append(HttpHeaders.ContentDisposition, "filename=\"$name\"")
                    })
                }))
            }
            checkNotNull(accountProfile(response, session).picture)
        }
    }

    suspend fun removeProfileImage(session: AnchorSession) {
        withAccountToken(session) { token ->
            val response = http.delete(session.origin + "/api/auth/profile/image") { bearerAuth(token) }
            check(accountProfile(response, session).picture == null)
        }
    }

    suspend fun downloadProfileImage(session: AnchorSession, path: String): ByteArray {
        val prefix = "/uploads/profiles/"
        val location = if (path.startsWith(prefix)) {
            val filename = path.removePrefix(prefix)
            require(filename.isNotBlank() && filename !in listOf(".", "..") && '/' !in filename && '\\' !in filename)
            session.origin + prefix + filename.encodeURLParameter()
        } else {
            val external = Url(path)
            require(external.protocol == URLProtocol.HTTPS && external.host.isNotBlank() && external.user == null && external.password == null)
            external.toString()
        }
        return http.prepareGet(location).execute { response ->
            if (!response.status.isSuccess()) throw AnchorHttpFailure(response.status.value)
            val type = response.headers[HttpHeaders.ContentType]?.substringBefore(';')
            check(type in profileImageTypes || type == "image/gif")
            val channel = response.bodyAsChannel()
            val bytes = ByteArray(maxProfileImageBytes + 1)
            var length = 0
            while (length < bytes.size) {
                val read = channel.readAvailable(bytes, length, bytes.size - length)
                if (read == -1) break
                length += read
            }
            check(length in 1..maxProfileImageBytes)
            bytes.copyOf(length)
        }
    }

    suspend fun changePassword(session: AnchorSession, current: String, replacement: String) {
        withAccountToken(session) { token ->
            val response = postResponse(session.origin, "/api/auth/change-password", token, buildJsonObject {
                put("currentPassword", current)
                put("newPassword", replacement)
            })
            checkAuthResponse(response, response.authBody())
        }
    }

    suspend fun deleteAccount(session: AnchorSession, password: String?) {
        withAccountToken(session) { token ->
            val response = postResponse(session.origin, "/api/auth/delete-account", token, buildJsonObject {
                password?.let { put("password", it) }
            })
            checkAuthResponse(response, response.authBody())
        }
    }

    suspend fun forgetDeletedAccount(session: AnchorSession) {
        val marker = buildJsonObject {
            put("origin", session.origin)
            put("userId", session.userId)
            put("eraseDeletedAccount", true)
        }
        val markerSaved = runCatching { sessionStore.write(marker.toString().encodeToByteArray()) }.isSuccess
        try {
            finishErasure(marker)
        } catch (error: Exception) {
            if (!markerSaved) sessionStore.clear()
            throw error
        }
    }

    suspend fun authenticatorStatus(session: AnchorSession): AuthenticatorStatus = withAccountToken(session) { token ->
        val response = http.get(session.origin + "/api/auth/2fa") { bearerAuth(token) }
        val payload = response.authBody()
        checkAuthResponse(response, payload)
        val status = checkNotNull(payload)
        val totp = status.getValue("totp").jsonObject
        AuthenticatorStatus(
            status.getValue("available").jsonObject.getValue("totp").jsonPrimitive.boolean,
            totp.getValue("enabled").jsonPrimitive.boolean,
            totp.getValue("recoveryCodesRemaining").jsonPrimitive.content.toInt(),
            status.getValue("policy").jsonPrimitive.content,
        )
    }

    suspend fun setupAuthenticator(session: AnchorSession, current: String?, recovery: Boolean): String =
        withAccountToken(session) { token ->
            factorRequest(session.origin, token, "setup", buildJsonObject {
                if (current != null) put(if (recovery) "recoveryCode" else "code", current)
            }).getValue("secret").jsonPrimitive.content
        }

    suspend fun enableAuthenticator(session: AnchorSession, code: String): List<String> =
        withAccountToken(session) { token ->
            val result = factorRequest(session.origin, token, "enable", buildJsonObject { put("code", code) })
            val access = result.getValue("access_token").jsonPrimitive.content
            val refresh = result.getValue("refresh_token").jsonPrimitive.content
            check(access.isNotBlank() && refresh.isNotBlank())
            store(session, access, refresh)
            session.accessToken = access
            session.refreshToken = refresh
            recoveryCodes(result)
        }

    suspend fun regenerateRecoveryCodes(session: AnchorSession, password: String, code: String): List<String> =
        withAccountToken(session) { token ->
            recoveryCodes(factorRequest(session.origin, token, "recovery-codes", buildJsonObject {
                put("password", password)
                put("code", code)
            }))
        }

    suspend fun disableAuthenticator(session: AnchorSession, password: String, code: String, recovery: Boolean) {
        withAccountToken(session) { token ->
            factorRequest(session.origin, token, "disable", buildJsonObject {
                put("password", password)
                put(if (recovery) "recoveryCode" else "code", code)
            })
        }
    }

    private suspend fun <T> withAccountToken(session: AnchorSession, action: suspend (String) -> T): T {
        convexToken(session)
        return session.tokenLock.withLock {
            if (session.accessToken.isBlank()) throw AnchorHttpFailure(401)
            action(session.accessToken)
        }
    }

    private suspend fun factorRequest(base: String, token: String, operation: String, body: JsonObject): JsonObject {
        val response = postResponse(base, "/api/auth/2fa/" + operation, token, body)
        val payload = response.authBody()
        checkAuthResponse(response, payload)
        return checkNotNull(payload)
    }

    private fun recoveryCodes(payload: JsonObject): List<String> =
        payload.getValue("recoveryCodes").jsonArray.map { it.jsonPrimitive.content }
            .also { codes -> check(codes.isNotEmpty() && codes.all { it.isNotBlank() }) }

    private suspend fun HttpResponse.authBody(): JsonObject? {
        val text = bodyAsText()
        return runCatching { Json.parseToJsonElement(text) as? JsonObject }.getOrNull()
    }

    private fun checkAuthResponse(response: HttpResponse, payload: JsonObject?) {
        if (!response.status.isSuccess())
            throw AnchorHttpFailure(response.status.value, (payload?.get("code") as? JsonPrimitive)?.contentOrNull)
    }

    private suspend fun finishSignIn(
        base: String, response: HttpResponse, payload: JsonObject?, persist: Boolean = true,
    ): AnchorSession {
        checkAuthResponse(response, payload)
        val session = checkNotNull(payload)
        val userId = session.getValue("user").jsonObject.getValue("id").jsonPrimitive.content
        val access = session.getValue("access_token").jsonPrimitive.content
        check(userId.isNotBlank() && access.isNotBlank())
        return AnchorSession(
            origin = base,
            userId = userId,
            accessToken = access,
            refreshToken = session["refresh_token"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() },
        ).also { if (persist) store(it, it.accessToken, it.refreshToken) }
    }

    suspend fun createNote(session: AnchorSession, draft: PendingNote): String {
        require(draft.origin == session.origin && draft.userId == session.userId)
        val base = session.origin
        val convexToken = outboxToken(session, draft.outboxScope)
        val content = draft.deltaContent ?: draft.content.takeIf { it.isNotEmpty() }?.let { text ->
            buildJsonObject {
                put("ops", JsonArray(listOf(buildJsonObject {
                    put("insert", if (text.endsWith('\n')) text else "$text\n")
                })))
            }.toString()
        }
        val note = post(base, "/api/compose/notes", convexToken, buildJsonObject {
            put("id", draft.id)
            put("title", draft.title)
            content?.let { put("content", it) }
            draft.backgroundChange?.let { put("background", it) }
        }, draft.outboxScope)
        val storedTitle = note.getValue("title").jsonPrimitive.content
        check(storedTitle == draft.title && note.getValue("id").jsonPrimitive.content == draft.id &&
            note.getValue("content").jsonPrimitive.contentOrNull == content &&
            (draft.backgroundChange == null || note["background"]?.jsonPrimitive?.contentOrNull == draft.backgroundChange))
        return storedTitle
    }

    private fun revisionPath(noteId: String, revisionId: String? = null): String {
        val path = "/api/notes/${noteId.encodeURLPathPart()}/revisions"
        return if (revisionId == null) path else "$path/${revisionId.encodeURLPathPart()}"
    }

    suspend fun sendNoteEdit(session: AnchorSession, draft: PendingNote): Boolean {
        return when (pushSyncChange(session, draft.syncNoteChange(), draft.outboxScope)) {
            "applied" -> true
            "conflict", "denied" -> false
            else -> throw AnchorHttpFailure(503)
        }
    }

    suspend fun copyNote(session: AnchorSession, note: CachedNote): NoteCopy {
        require(note.origin == session.origin && note.userId == session.userId && note.folder != NoteFolder.Trash)
        return withAccountToken(session) { token ->
            val response = post(session.origin, "/api/notes/${note.id.encodeURLPathPart()}/duplicate?undo=true", token)
            NoteCopy(response.getValue("id").jsonPrimitive.content, response["undoSequence"]?.jsonPrimitive?.contentOrNull)
        }
    }

    suspend fun undoNoteCopy(session: AnchorSession, copy: NoteCopy) {
        val sequence = requireNotNull(copy.undoSequence?.toLongOrNull()).also { require(it > 0) }
        withAccountToken(session) { token ->
            val response = postResponse(
                session.origin, "/api/notes/${copy.id.encodeURLPathPart()}/duplicate/undo?baseSequence=$sequence", token,
            )
            checkAuthResponse(response, response.authBody())
        }
    }

    suspend fun changeNoteFolder(session: AnchorSession, note: CachedNote, destination: NoteFolder?) {
        require(note.origin == session.origin && note.userId == session.userId && note.folder != destination)
        if (note.folder == NoteFolder.Trash || destination == NoteFolder.Trash) require(note.isOwner)
        if (destination == null) require(note.folder == NoteFolder.Trash)
        if (note.folder == NoteFolder.Trash) require(destination == null || destination == NoteFolder.Notes)

        if (note.folder == NoteFolder.Trash || destination == NoteFolder.Trash) {
            val status = pushSyncChange(session, buildJsonObject {
                put("type", "note")
                put("id", note.id)
                put("title", note.title)
                put("baseVersion", note.version)
                put("state", when (destination) {
                    null -> "deleted"
                    NoteFolder.Trash -> "trashed"
                    else -> "active"
                })
            })
            requireAppliedChange(status)
            return
        }

        val path = session.origin + "/api/notes/" + note.id.encodeURLPathPart()
        val token = convexToken(session)
        val response = http.patch(path) {
            bearerAuth(token)
            contentType(ContentType.Application.Json)
            setBody(buildJsonObject { put("isArchived", destination == NoteFolder.Archive) }.toString())
        }
        if (!response.status.isSuccess()) throw AnchorHttpFailure(response.status.value)
    }

    suspend fun leaveSharedNote(session: AnchorSession, note: CachedNote) {
        require(note.origin == session.origin && note.userId == session.userId && !note.isOwner)
        val token = convexToken(session)
        val response = http.delete(session.origin + "/api/notes/" + note.id.encodeURLPathPart()) {
            bearerAuth(token)
        }
        if (!response.status.isSuccess()) throw response.failure()
    }

    suspend fun moveNote(
        session: AnchorSession, notes: List<CachedNote>, noteId: String, step: Int, otherGroup: List<CachedNote>,
    ) {
        fun snapshot(group: List<CachedNote>) = JsonArray(group.map { note ->
            require(note.origin == session.origin && note.userId == session.userId)
            buildJsonObject {
                put("id", note.id)
                put("position", note.position?.let(::JsonPrimitive) ?: JsonNull)
            }
        })
        post(session.origin, "/api/compose/notes/order", convexToken(session), buildJsonObject {
            put("noteId", noteId)
            put("step", step)
            if (otherGroup.isEmpty()) put("notes", snapshot(notes))
            else put("groups", buildJsonObject {
                put("moved", snapshot(notes))
                put("other", snapshot(otherGroup))
            })
        })
    }

    suspend fun setNotePin(session: AnchorSession, note: CachedNote, isPinned: Boolean) {
        require(note.origin == session.origin && note.userId == session.userId && note.folder == NoteFolder.Notes)
        requireAppliedChange(pushSyncChange(session, buildJsonObject {
            put("type", "pin")
            put("id", note.id)
            put("isPinned", isPinned)
        }))
    }

    suspend fun updateReminder(session: AnchorSession, note: CachedNote, at: String?, repeat: ReminderRepeat) {
        require(note.origin == session.origin && note.userId == session.userId && note.folder != NoteFolder.Trash)
        requireAppliedChange(pushSyncChange(session, buildJsonObject {
            put("type", "reminder")
            put("id", note.id)
            put("remindAt", at?.let(::JsonPrimitive) ?: JsonNull)
            if (at != null) put("recurrence", repeat.wire)
            note.reminderVersion?.let { put("baseVersion", it) }
        }))
    }

    suspend fun createTag(session: AnchorSession, name: String) {
        post(session.origin, "/api/tags", convexToken(session), buildJsonObject { put("name", name) })
    }

    suspend fun renameTag(session: AnchorSession, tag: CachedTag, name: String) {
        require(tag.origin == session.origin && tag.userId == session.userId)
        val token = convexToken(session)
        val response = http.patch(session.origin + "/api/tags/" + tag.id.encodeURLPathPart()) {
            bearerAuth(token)
            contentType(ContentType.Application.Json)
            setBody(buildJsonObject {
                put("name", name)
                put("baseVersion", tag.version)
            }.toString())
        }
        checkAuthResponse(response, response.authBody())
    }

    suspend fun deleteTag(session: AnchorSession, tag: CachedTag) {
        require(tag.origin == session.origin && tag.userId == session.userId)
        requireAppliedChange(pushSyncChange(session, buildJsonObject {
            put("type", "tag")
            put("id", tag.id)
            put("name", tag.name)
            put("baseVersion", tag.version)
            put("isDeleted", true)
        }))
    }

    suspend fun assignTag(session: AnchorSession, note: CachedNote, tag: CachedTag, assigned: Boolean) {
        require(note.origin == session.origin && note.userId == session.userId && note.folder != NoteFolder.Trash)
        require(tag.origin == session.origin && tag.userId == session.userId)
        val token = convexToken(session)
        val response = http.patch(session.origin + "/api/notes/" + note.id.encodeURLPathPart()) {
            bearerAuth(token)
            contentType(ContentType.Application.Json)
            setBody(buildJsonObject {
                put("tagAssignment", buildJsonObject {
                    put("id", tag.id)
                    put("assigned", assigned)
                })
            }.toString())
        }
        val receipt = response.authBody()
        checkAuthResponse(response, receipt)
        val actual = checkNotNull(receipt).getValue("tagIds").jsonArray.any { it.jsonPrimitive.content == tag.id }
        check(actual == assigned)
    }

    private fun requireAppliedChange(status: String) {
        when (status) {
            "applied" -> Unit
            "conflict" -> throw AnchorHttpFailure(409)
            "denied" -> throw AnchorHttpFailure(403)
            else -> throw AnchorHttpFailure(503)
        }
    }

    suspend fun findShareContacts(session: AnchorSession, query: String): List<NoteContact> {
        if (query.length == 1) return emptyList()
        val path = if (query.isEmpty()) "/api/users/recent-contacts" else "/api/users/search"
        return shareRequest(session, path, query = query.takeIf { it.isNotEmpty() })
            .jsonArray.map { readNoteContact(it.jsonObject) }
    }

    suspend fun noteShares(session: AnchorSession, note: CachedNote): List<NoteShare> =
        shareRequest(session, sharePath(session, note)).jsonArray.map {
            val share = it.jsonObject
            NoteShare(
                share.getValue("id").jsonPrimitive.content,
                readNoteContact(share.getValue("sharedWithUser").jsonObject),
                SharePermission.entries.single { permission ->
                    permission.wire == share.getValue("permission").jsonPrimitive.content
                },
            )
        }

    suspend fun grantNoteShare(session: AnchorSession, note: CachedNote, contact: NoteContact, permission: SharePermission) {
        require(contact.id != session.userId)
        shareRequest(session, sharePath(session, note), HttpMethod.Post, buildJsonObject {
            put("sharedWithUserId", contact.id)
            put("permission", permission.wire)
        })
    }

    suspend fun changeNoteShare(session: AnchorSession, note: CachedNote, share: NoteShare, permission: SharePermission) {
        shareRequest(session, sharePath(session, note, share), HttpMethod.Patch, buildJsonObject {
            put("permission", permission.wire)
        })
    }

    suspend fun revokeNoteShare(session: AnchorSession, note: CachedNote, share: NoteShare) {
        val receipt = shareRequest(session, sharePath(session, note, share), HttpMethod.Delete).jsonObject
        check(receipt.getValue("success").jsonPrimitive.boolean)
    }

    private fun sharePath(session: AnchorSession, note: CachedNote, share: NoteShare? = null): String {
        require(note.origin == session.origin && note.userId == session.userId && note.isOwner && note.folder != NoteFolder.Trash)
        val path = "/api/notes/${note.id.encodeURLPathPart()}/shares"
        return share?.let { "$path/${it.id.encodeURLPathPart()}" } ?: path
    }

    private fun readNoteContact(raw: JsonObject) = NoteContact(
        raw.getValue("id").jsonPrimitive.content,
        raw.getValue("name").jsonPrimitive.content,
        raw.getValue("email").jsonPrimitive.content,
    )

    private suspend fun shareRequest(
        session: AnchorSession,
        path: String,
        requestMethod: HttpMethod = HttpMethod.Get,
        body: JsonObject? = null,
        query: String? = null,
    ): JsonElement {
        val token = convexToken(session)
        val response = http.request(session.origin + path) {
            method = requestMethod
            bearerAuth(token)
            query?.let { parameter("q", it) }
            body?.let {
                contentType(ContentType.Application.Json)
                setBody(it.toString())
            }
        }
        if (!response.status.isSuccess()) checkAuthResponse(response, response.authBody())
        return Json.parseToJsonElement(response.bodyAsText())
    }

    suspend fun pushSyncChange(session: AnchorSession, change: JsonObject, outboxScope: String? = null): String {
        val result = post(session.origin, "/api/compose/sync", outboxToken(session, outboxScope), buildJsonObject {
            put("limit", 1)
            put("changes", JsonArray(listOf(change)))
        }, outboxScope).getValue("results").jsonArray.single().jsonObject
        check(result["type"] == change["type"] && result["id"] == change["id"])
        return result.getValue("status").jsonPrimitive.content
    }

    suspend fun pushFlutterMetadata(session: AnchorSession, change: JsonObject, outboxScope: String?): String {
        when (change.getValue("type").jsonPrimitive.content) {
            "revision" -> return pushSyncChange(session, flutterRevisionChange(change), outboxScope)
            "attachmentDelete" -> {
                deleteAttachment(
                    session, change.getValue("noteId").jsonPrimitive.content, change.getValue("id").jsonPrimitive.content, outboxScope,
                )
                return "applied"
            }
            "noteTags" -> Unit
            else -> return pushSyncChange(session, change, outboxScope)
        }
        val id = change.getValue("id").jsonPrimitive.content
        val token = outboxToken(session, outboxScope)
        val response = http.patch(session.origin + "/api/notes/" + id.encodeURLPathPart()) {
            bearerAuth(token)
            outboxScope?.let { header(outboxScopeHeader, it) }
            contentType(ContentType.Application.Json)
            setBody(buildJsonObject { put("tagIds", change.getValue("tagIds")) }.toString())
        }
        checkAuthResponse(response, response.authBody())
        return "applied"
    }

    private suspend fun historyResponse(response: HttpResponse): JsonObject {
        val body = response.authBody()
        checkAuthResponse(response, body)
        return checkNotNull(body)
    }

    suspend fun currentVersion(session: AnchorSession, noteId: String): CurrentVersion =
        withAccountToken(session) { token ->
            historyResponse(http.get(session.origin + "/api/notes/" + noteId.encodeURLPathPart()) {
                bearerAuth(token)
            }).currentVersion()
        }

    suspend fun revisions(session: AnchorSession, noteId: String, cursor: String?): RevisionPage =
        withAccountToken(session) { token ->
            val body = historyResponse(http.get(session.origin + revisionPath(noteId)) {
                bearerAuth(token)
                parameter("limit", 20)
                cursor?.let { parameter("cursor", it) }
            })
            RevisionPage(
                entries = body.getValue("revisions").jsonArray.map { it.jsonObject.noteRevision() },
                cursor = body["nextCursor"]?.jsonPrimitive?.contentOrNull,
            )
        }

    suspend fun revision(session: AnchorSession, noteId: String, revisionId: String): NoteRevision =
        withAccountToken(session) { token ->
            historyResponse(http.get(session.origin + revisionPath(noteId, revisionId)) {
                bearerAuth(token)
            }).noteRevision()
        }

    suspend fun restoreRevision(
        session: AnchorSession,
        noteId: String,
        revisionId: String,
        baseVersion: Long,
    ): RestoredVersion =
        withAccountToken(session) { token ->
            val note = historyResponse(postResponse(
                session.origin, revisionPath(noteId, revisionId) + "/restore?baseVersion=$baseVersion", token,
            ))
            RestoredVersion(note.currentVersion(), note["undoRevisionId"]?.jsonPrimitive?.contentOrNull)
        }

    private suspend fun convexToken(session: AnchorSession): String = session.tokenLock.withLock {
        if (session.accessToken.isBlank()) throw AnchorHttpFailure(401)
        try {
            return@withLock exchangeToken(session)
        } catch (error: AnchorHttpFailure) {
            if (error.status != 401) throw error
        }

        val refresh = session.refreshToken
        if (refresh == null) {
            expire(session)
            throw AnchorHttpFailure(401)
        }
        val hasProxyHeaders = headersFor(session.origin).isNotEmpty()
        val response = postResponse(session.origin, "/api/auth/refresh", body = buildJsonObject {
            put("refresh_token", refresh)
        })
        val payload = response.authBody()
        if (response.status.value == 401 && (!hasProxyHeaders || isRefreshRejectedByAnchor(payload))) expire(session)
        checkAuthResponse(response, payload)
        val tokens = checkNotNull(payload)
        val accessToken = tokens.getValue("access_token").jsonPrimitive.content
        val refreshToken = tokens.getValue("refresh_token").jsonPrimitive.content
        check(accessToken.isNotBlank() && refreshToken.isNotBlank())
        store(session, accessToken, refreshToken)
        session.accessToken = accessToken
        session.refreshToken = refreshToken
        exchangeToken(session)
    }

    private fun isRefreshRejectedByAnchor(payload: JsonObject?): Boolean {
        if (payload?.get("code") == JsonPrimitive("INVALID_REFRESH_TOKEN")) return true
        // NestJS includes the endpoint and the refresh-specific reason in its error response.
        return payload?.get("path") == JsonPrimitive("/api/auth/refresh") &&
            payload["statusCode"] == JsonPrimitive(401) &&
            (payload["message"] as? JsonPrimitive)?.contentOrNull in setOf(
                "Invalid refresh token", "Refresh token has expired", "Account pending approval",
            )
    }

    private suspend fun expire(session: AnchorSession) {
        try {
            sessionStore.clear()
        } finally {
            session.accessToken = ""
            session.refreshToken = null
            session.expired.value = true
        }
    }

    private suspend fun exchangeToken(session: AnchorSession): String =
        post(session.origin, "/api/auth/convex-token", session.accessToken)
            .getValue("token").jsonPrimitive.content

    private suspend fun outboxToken(session: AnchorSession, expectedScope: String?): String {
        val token = convexToken(session)
        if (expectedScope != null) {
            val response = postResponse(session.origin, "/api/compose/sync", token, buildJsonObject {
                put("limit", 1)
            }, expectedScope)
            if (!response.status.isSuccess()) throw response.failure()
            val scope = response.headers[syncScopeHeader] ?: throw AnchorHttpFailure(503)
            if (scope != expectedScope) throw AnchorHttpFailure(409, "OUTBOX_SCOPE_CHANGED")
        }
        return token
    }

    suspend fun uploadAttachment(session: AnchorSession, upload: PendingAttachmentUpload, outbox: AttachmentOutbox) {
        require(upload.origin == session.origin && upload.userId == session.userId)
        require(upload.fileSize in 1..maxAttachmentBytes)
        val token = outboxToken(session, upload.outboxScope)
        val response = http.post(session.origin + "/api/compose/attachments") {
            bearerAuth(token)
            upload.outboxScope?.let { header(outboxScopeHeader, it) }
            parameter("noteId", upload.noteId)
            parameter("attachmentId", upload.id)
            header("X-Anchor-Filename-Encoded", upload.filename.encodeURLParameter())
            timeout { requestTimeoutMillis = 120_000 }
            setBody(ChannelWriterContent(
                contentType = ContentType.parse(upload.mimeType),
                contentLength = upload.fileSize.toLong(),
                body = {
                    for ((partNumber, offset) in (0 until upload.fileSize step attachmentPartSize).withIndex()) {
                        val part = outbox.readPart(session.origin, session.userId, upload.id, partNumber)
                        check(part != null && part.size == minOf(attachmentPartSize, upload.fileSize - offset))
                        writeFully(part)
                    }
                },
            ))
        }
        val body = response.bodyAsText()
        if (!response.status.isSuccess()) {
            val code = runCatching { Json.parseToJsonElement(body).jsonObject["code"]?.jsonPrimitive?.content }.getOrNull()
            throw AnchorHttpFailure(response.status.value, code)
        }
        val receipt = readAttachment(Json.parseToJsonElement(body).jsonObject, session, upload.noteId, 0)
        check(receipt.id == upload.id && receipt.fileSize == upload.fileSize.toLong() && receipt.mimeType == upload.mimeType)
    }

    suspend fun downloadAttachment(session: AnchorSession, file: CachedAttachment): ByteArray {
        require(file.origin == session.origin && file.userId == session.userId)
        require(file.fileSize in 1L..maxAttachmentBytes.toLong())
        val token = convexToken(session)
        return http.prepareGet(session.origin + "/api/compose/attachments") {
            bearerAuth(token)
            parameter("noteId", file.noteId)
            parameter("attachmentId", file.id)
            timeout { requestTimeoutMillis = 120_000 }
        }.execute { response ->
            if (response.status.value != 200) throw AnchorHttpFailure(response.status.value)
            check(response.headers[HttpHeaders.ContentType] == file.mimeType)
            val channel = response.bodyAsChannel()
            ByteArray(file.fileSize.toInt()).also { bytes ->
                channel.readFully(bytes)
                check(channel.readAvailable(ByteArray(1)) == -1)
            }
        }
    }

    suspend fun deleteAttachment(session: AnchorSession, file: CachedAttachment) {
        require(file.origin == session.origin && file.userId == session.userId)
        deleteAttachment(session, file.noteId, file.id)
    }

    private suspend fun deleteAttachment(session: AnchorSession, noteId: String, attachmentId: String, outboxScope: String? = null) {
        val token = outboxToken(session, outboxScope)
        val response = http.delete(session.origin + "/api/compose/attachments") {
            bearerAuth(token)
            outboxScope?.let { header(outboxScopeHeader, it) }
            parameter("noteId", noteId)
            parameter("attachmentId", attachmentId)
        }
        if (!response.status.isSuccess()) throw response.failure()
        val receipt = Json.parseToJsonElement(response.bodyAsText()).jsonObject
        check(receipt.getValue("success").jsonPrimitive.boolean)
    }

    suspend fun reorderAttachments(session: AnchorSession, note: CachedNote, orderedIds: List<String>) {
        require(note.origin == session.origin && note.userId == session.userId && note.canEdit)
        val token = convexToken(session)
        val response = http.patch(session.origin + "/api/compose/attachments/list") {
            bearerAuth(token)
            parameter("noteId", note.id)
            contentType(ContentType.Application.Json)
            setBody(buildJsonObject {
                put("orderedIds", JsonArray(orderedIds.map { JsonPrimitive(it) }))
            }.toString())
        }
        if (!response.status.isSuccess()) throw AnchorHttpFailure(response.status.value)
        val ordered = Json.parseToJsonElement(response.bodyAsText()).jsonArray
        check(ordered.map { it.jsonObject.getValue("id").jsonPrimitive.content } == orderedIds)
    }

    suspend fun receiveSyncSignals(session: AnchorSession, signal: () -> Unit): Boolean {
        val token = convexToken(session)
        return http.prepareGet(session.origin + "/api/sync/events") {
            bearerAuth(token)
            header(HttpHeaders.Accept, "text/event-stream")
            header(HttpHeaders.CacheControl, "no-store")
            timeout {
                requestTimeoutMillis = 180_000
                socketTimeoutMillis = 60_000 // The server can wait 24 seconds between frames.
            }
        }.execute { response ->
            if (response.status.value != 200) throw AnchorHttpFailure(response.status.value)
            if (!response.headers[HttpHeaders.ContentType].orEmpty()
                    .substringBefore(';').trim().equals("text/event-stream", ignoreCase = true)
            ) return@execute false
            val body = response.bodyAsChannel()
            signal() // A change during an interruption may have no event on the new stream.
            var event = ""
            while (true) {
                val line = withTimeoutOrNull(60_000L) { body.readLineStrict(limit = 4096) } ?: break
                when {
                    line.startsWith("event:") -> event = line.substringAfter(':').trim()
                    line.isEmpty() -> {
                        if (event == "reconnect") break
                        if (event == "sync") signal()
                        event = ""
                    }
                }
            }
            true
        }
    }

    suspend fun syncNotes(session: AnchorSession, cache: NoteCacheDao) {
        var cursor = cache.cursor(session.origin, session.userId)?.takeIf { it.isNotEmpty() }
        var reset = false
        while (true) {
            when (val page = pullNotes(session, cursor)) {
                NoteFeedPage.Reset -> {
                    check(cursor != null && !reset)
                    cache.reset(session.origin, session.userId)
                    cursor = null
                    reset = true
                }
                is NoteFeedPage.Data -> {
                    check(!page.hasMore || page.cursor != cursor)
                    cache.applyPage(session.origin, session.userId, page)
                    if (!page.hasMore) return
                    cursor = page.cursor
                }
            }
        }
    }

    private fun readReminder(value: JsonObject): CachedReminder = CachedReminder(
        remindAt = value.getValue("remindAt").jsonPrimitive.content,
        recurrence = value.getValue("recurrence").jsonPrimitive.content,
        version = value.getValue("version").jsonPrimitive.long,
    )

    private fun readAttachment(value: JsonObject, session: AnchorSession, noteId: String, position: Int): CachedAttachment {
        check(value.getValue("noteId").jsonPrimitive.content == noteId)
        return CachedAttachment(
            origin = session.origin,
            userId = session.userId,
            noteId = noteId,
            id = value.getValue("id").jsonPrimitive.content,
            type = value.getValue("type").jsonPrimitive.content,
            originalFilename = value.getValue("originalFilename").jsonPrimitive.content,
            mimeType = value.getValue("mimeType").jsonPrimitive.content,
            fileSize = value.getValue("fileSize").jsonPrimitive.long,
            uploadedByUserId = value.getValue("uploadedByUserId").jsonPrimitive.content,
            createdAt = value.getValue("createdAt").jsonPrimitive.content,
            position = position,
        )
    }

    private suspend fun pullNotes(session: AnchorSession, cursor: String?): NoteFeedPage {
        val reply = postResponse(session.origin, "/api/compose/sync", convexToken(session), buildJsonObject {
            put("attachmentOrder", true)
            if (cursor != null) put("cursor", cursor)
        })
        if (!reply.status.isSuccess()) throw reply.failure()
        val response = Json.parseToJsonElement(reply.bodyAsText()).jsonObject
        if (response["resetRequired"]?.jsonPrimitive?.boolean == true) return NoteFeedPage.Reset
        val entries = response.getValue("entries").jsonArray.map { value ->
            val entry = value.jsonObject
            val type = entry.getValue("entityType").jsonPrimitive.content
            val id = entry.getValue("entityId").jsonPrimitive.content
            val operation = entry.getValue("op").jsonPrimitive.content
            if (type == "tag") {
                return@map when (operation) {
                    "remove" -> FeedEntry.TagRemove(id)
                    "upsert" -> {
                        val tag = entry.getValue("tag").jsonObject
                        check(tag.getValue("id").jsonPrimitive.content == id)
                        FeedEntry.TagUpsert(CachedTag(
                            origin = session.origin,
                            userId = session.userId,
                            id = id,
                            name = tag.getValue("name").jsonPrimitive.content,
                            color = tag.getValue("color").takeUnless { it is JsonNull }?.jsonPrimitive?.content,
                            position = tag.getValue("position").takeUnless { it is JsonNull }?.jsonPrimitive?.content,
                            version = tag.getValue("version").jsonPrimitive.long,
                        ))
                    }
                    else -> error("Unknown tag feed operation")
                }
            }
            if (type == "pin") {
                check(operation == "upsert" || operation == "remove")
                return@map FeedEntry.Pin(id, operation == "upsert")
            }
            if (type == "reminder") {
                val reminder = when (operation) {
                    "upsert" -> readReminder(entry.getValue("reminder").jsonObject)
                    "remove" -> null
                    else -> error("Unknown reminder feed operation")
                }
                return@map FeedEntry.Reminder(id, reminder)
            }
            check(type == "note")
            when (operation) {
                "remove" -> FeedEntry.Remove(id)
                "upsert" -> {
                    val note = entry.getValue("note").jsonObject
                    check(note.getValue("id").jsonPrimitive.content == id)
                    val reminder = note["reminder"]?.takeUnless { it is JsonNull }
                        ?.let { readReminder(it.jsonObject) }
                    FeedEntry.Upsert(CachedNote(
                        origin = session.origin,
                        userId = session.userId,
                        id = id,
                        title = note.getValue("title").jsonPrimitive.content,
                        content = note.getValue("content").takeUnless { it is JsonNull }?.jsonPrimitive?.content,
                        version = note.getValue("version").jsonPrimitive.long,
                        isPinned = note["isPinned"]?.jsonPrimitive?.boolean ?: false,
                        remindAt = reminder?.remindAt,
                        reminderRecurrence = reminder?.recurrence,
                        reminderVersion = reminder?.version,
                        position = note["position"]?.takeUnless { it is JsonNull }?.jsonPrimitive?.content,
                        background = note["background"]?.jsonPrimitive?.contentOrNull,
                        createdAt = note["createdAt"]?.jsonPrimitive?.longOrNull,
                        updatedAt = note["updatedAt"]?.jsonPrimitive?.longOrNull
                            ?.let { Instant.fromEpochMilliseconds(it).toString() },
                        canEdit = note["state"]?.jsonPrimitive?.content == "active" &&
                            note["permission"]?.jsonPrimitive?.content in listOf("owner", "editor"),
                        isOwner = note["permission"]?.jsonPrimitive?.content == "owner",
                        isArchived = note["isArchived"]?.jsonPrimitive?.boolean ?: false,
                        isTrashed = note["state"]?.jsonPrimitive?.content == "trashed",
                    ),
                        note["tagIds"]?.jsonArray?.map { it.jsonPrimitive.content }?.distinct().orEmpty(),
                        note["attachments"]?.jsonArray?.mapIndexed { index, item ->
                            readAttachment(item.jsonObject, session, id, index)
                        }.orEmpty(),
                    )
                }
                else -> error("Unknown note feed operation")
            }
        }
        return NoteFeedPage.Data(
            cursor = response.getValue("nextCursor").jsonPrimitive.content,
            hasMore = response.getValue("hasMore").jsonPrimitive.boolean,
            entries = entries,
            scope = reply.headers[syncScopeHeader],
        )
    }

    private fun origin(input: String): String {
        val url = Url(input.trim())
        require(url.protocol == URLProtocol.HTTPS ||
            (url.protocol == URLProtocol.HTTP && url.host == "127.0.0.1"))
        require(url.host.isNotBlank() && url.user == null && url.password == null)
        require(url.encodedPath in listOf("", "/") && url.parameters.isEmpty() && url.fragment.isEmpty())
        return url.toString().trimEnd('/')
    }

    private suspend fun HttpResponse.failure(): AnchorHttpFailure {
        val code = if (status.value == 409) (authBody()?.get("code") as? JsonPrimitive)?.contentOrNull else null
        return AnchorHttpFailure(status.value, code)
    }

    private suspend fun post(
        base: String, path: String, token: String? = null, body: JsonObject? = null, outboxScope: String? = null,
    ): JsonObject {
        val response = postResponse(base, path, token, body, outboxScope)
        if (!response.status.isSuccess()) throw response.failure()
        return Json.parseToJsonElement(response.bodyAsText()).jsonObject
    }

    private suspend fun postResponse(
        base: String, path: String, token: String? = null, body: JsonObject? = null, outboxScope: String? = null,
    ): HttpResponse =
        http.post(base + path) {
            token?.let { bearerAuth(it) }
            outboxScope?.let { header(outboxScopeHeader, it) }
            body?.let {
                contentType(ContentType.Application.Json)
                setBody(it.toString())
            }
        }
}

internal fun flutterRevisionChange(change: JsonObject): JsonObject {
    val revision = change.getValue("revision").jsonObject
    return buildJsonObject {
        put("type", "note")
        put("id", change.getValue("noteId"))
        put("title", revision.getValue("title"))
        put("revisionsOnly", true)
        put("requireRevisionWrite", true)
        put("revisions", JsonArray(listOf(revision)))
    }
}

internal fun PendingNote.syncNoteChange(): JsonObject = buildJsonObject {
    put("type", "note")
    put("id", id)
    put("title", title)
    baseVersion?.let { put("baseVersion", it) }
    if (flutterFields != null) {
        val fields = Json.parseToJsonElement(flutterFields).jsonObject
        put("content", deltaContent?.let(::JsonPrimitive) ?: JsonNull)
        for (key in listOf("isArchived", "background", "state", "createdAt")) {
            fields[key]?.let { put(key, it) }
        }
    } else {
        deltaContent?.let { put("content", it) }
        backgroundChange?.let { put("background", if (it.isEmpty()) JsonNull else JsonPrimitive(it)) }
    }
}
