package anchor

import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.Query
import androidx.room.Transaction
import androidx.room.Transactor
import androidx.room.useWriterConnection
import androidx.sqlite.SQLITE_DATA_INTEGER
import androidx.sqlite.SQLITE_DATA_NULL
import androidx.sqlite.SQLITE_DATA_TEXT
import androidx.sqlite.SQLiteStatement
import androidx.sqlite.driver.bundled.BundledSQLiteDriver
import androidx.sqlite.driver.bundled.SQLITE_OPEN_READONLY
import androidx.sqlite.execSQL
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.IO
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.withContext
import kotlinx.io.Buffer
import kotlinx.io.buffered
import kotlinx.io.files.Path
import kotlinx.io.files.SystemFileSystem
import kotlinx.io.readByteArray
import kotlinx.io.readString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import kotlin.time.Instant
import kotlin.uuid.Uuid

@Entity(tableName = "legacy_upgrade_imports", primaryKeys = ["origin", "userId"])
internal data class LegacyUpgradeImport(
    val origin: String,
    val userId: String,
    val directory: String,
    val manifest: String,
    @ColumnInfo(defaultValue = "0") val outboxPrepared: Boolean = false,
    @ColumnInfo(defaultValue = "0") val noteChangesPrepared: Boolean = false,
    @ColumnInfo(defaultValue = "0") val metadataPrepared: Boolean = false,
    @ColumnInfo(defaultValue = "0") val historyAndDeletesPrepared: Boolean = false,
    @ColumnInfo(defaultValue = "0") val sharesPrepared: Boolean = false,
    @ColumnInfo(defaultValue = "0") val trashUploadsPrepared: Boolean = false,
)

@Entity(tableName = "legacy_upgrade_rows", primaryKeys = ["origin", "userId", "sourceTable", "ordinal"])
internal data class LegacyUpgradeRow(
    val origin: String,
    val userId: String,
    val sourceTable: String,
    val ordinal: Long,
    val payload: String,
)

@Entity(tableName = "legacy_metadata_changes", primaryKeys = ["origin", "userId", "kind", "entityId"])
internal data class LegacyMetadataChange(
    val origin: String,
    val userId: String,
    val kind: String,
    val entityId: String,
    val payload: String,
    val rejection: String? = null,
    val outboxScope: String? = null,
)

private const val readyMetadataSql = """
    SELECT * FROM legacy_metadata_changes AS change
    WHERE change.origin = :origin AND change.userId = :userId AND change.rejection IS NULL
    AND (change.kind = 'tag' OR NOT EXISTS (
        SELECT 1 FROM pending_notes AS note
        WHERE note.origin = change.origin AND note.userId = change.userId
        AND note.id = COALESCE(json_extract(change.payload, '$.noteId'), change.entityId)
        AND note.baseVersion IS NULL
    ))
    AND (change.kind != 'noteTags' OR NOT EXISTS (
        SELECT 1 FROM json_each(change.payload, '$.tagIds') AS link
        JOIN legacy_metadata_changes AS tag ON tag.origin = change.origin AND tag.userId = change.userId
        AND tag.kind = 'tag' AND tag.entityId = link.value
    ))
    ORDER BY CASE WHEN change.kind = 'tag' THEN 0 ELSE 1 END, change.rowid
"""

@Dao
internal interface LegacyUpgradeDao {
    @Query("SELECT * FROM legacy_upgrade_imports WHERE origin = :origin AND userId = :userId")
    suspend fun imported(origin: String, userId: String): LegacyUpgradeImport?

    @Query("SELECT * FROM legacy_upgrade_rows WHERE origin = :origin AND userId = :userId AND sourceTable = :table ORDER BY ordinal")
    suspend fun rows(origin: String, userId: String, table: String): List<LegacyUpgradeRow>

    @Query("""
        SELECT payload FROM legacy_upgrade_rows
        WHERE origin = :origin AND userId = :userId AND sourceTable = 'note_revisions'
        AND json_extract(payload, '$.note_id') = :noteId
        ORDER BY json_extract(payload, '$.created_at') DESC, json_extract(payload, '$.id') DESC
    """)
    suspend fun revisionPayloads(origin: String, userId: String, noteId: String): List<String>

    @Query("""
        SELECT json_extract(payload, '$.id') FROM legacy_upgrade_rows
        WHERE origin = :origin AND userId = :userId AND sourceTable = 'note_attachments'
        AND json_extract(payload, '$.sync_status') = 'synced'
        AND json_extract(payload, '$.note_id') = :noteId
        AND COALESCE(json_extract(payload, '$.server_attachment_id'), json_extract(payload, '$.id')) = :id
        AND json_extract(payload, '$.file_size') = :size
        AND json_extract(payload, '$.mime_type') = :mime
        LIMIT 1
    """)
    suspend fun cachedFlutterFileId(origin: String, userId: String, noteId: String, id: String, size: Long, mime: String): String?

    @Insert
    suspend fun addImport(value: LegacyUpgradeImport)

    @Insert
    suspend fun addRow(row: LegacyUpgradeRow)

    @Query("UPDATE legacy_upgrade_imports SET outboxPrepared = 1, trashUploadsPrepared = 1 WHERE origin = :origin AND userId = :userId")
    suspend fun markOutboxPrepared(origin: String, userId: String)

    @Query("UPDATE legacy_upgrade_imports SET noteChangesPrepared = 1 WHERE origin = :origin AND userId = :userId")
    suspend fun markNoteChangesPrepared(origin: String, userId: String)

    @Query("UPDATE legacy_upgrade_imports SET metadataPrepared = 1 WHERE origin = :origin AND userId = :userId")
    suspend fun markMetadataPrepared(origin: String, userId: String)

    @Query("UPDATE legacy_upgrade_imports SET historyAndDeletesPrepared = 1 WHERE origin = :origin AND userId = :userId")
    suspend fun markHistoryAndDeletesPrepared(origin: String, userId: String)

    @Query("UPDATE legacy_upgrade_imports SET sharesPrepared = 1 WHERE origin = :origin AND userId = :userId")
    suspend fun markSharesPrepared(origin: String, userId: String)

    @Insert
    suspend fun insertMetadata(change: LegacyMetadataChange)

    @Query(outboxScopeSql)
    suspend fun scope(origin: String, userId: String): String?

    @Transaction
    suspend fun addMetadata(change: LegacyMetadataChange) {
        insertMetadata(change.copy(outboxScope = scope(change.origin, change.userId)))
    }

    @Query("""
        SELECT EXISTS(SELECT 1 FROM legacy_metadata_changes
        WHERE origin = :origin AND userId = :userId AND (
            (kind = 'noteTags' AND entityId = :noteId) OR
            (kind = 'attachmentDelete' AND json_extract(payload, '$.noteId') = :noteId)
        ))
    """)
    suspend fun hasCopyChanges(origin: String, userId: String, noteId: String): Boolean

    @Query(readyMetadataSql)
    suspend fun readyMetadata(origin: String, userId: String): List<LegacyMetadataChange>

    @Query(readyMetadataSql)
    fun observeReadyMetadata(origin: String, userId: String): Flow<List<LegacyMetadataChange>>

    @Query("SELECT * FROM legacy_metadata_changes WHERE origin = :origin AND userId = :userId ORDER BY rowid")
    suspend fun metadata(origin: String, userId: String): List<LegacyMetadataChange>

    @Query("DELETE FROM legacy_metadata_changes WHERE origin = :origin AND userId = :userId AND kind = :kind AND entityId = :id")
    suspend fun acknowledgeMetadata(origin: String, userId: String, kind: String, id: String)

    @Query("UPDATE legacy_metadata_changes SET rejection = :reason WHERE origin = :origin AND userId = :userId AND kind = :kind AND entityId = :id")
    suspend fun rejectMetadata(origin: String, userId: String, kind: String, id: String, reason: String)

    @Query("DELETE FROM legacy_metadata_changes WHERE origin = :origin AND userId = :userId")
    suspend fun clearMetadata(origin: String, userId: String)

    @Query("DELETE FROM legacy_upgrade_rows WHERE origin = :origin AND userId = :userId")
    suspend fun clearRows(origin: String, userId: String)

    @Query("DELETE FROM legacy_upgrade_imports WHERE origin = :origin AND userId = :userId")
    suspend fun clearImport(origin: String, userId: String)
}

private val legacyTables = listOf(
    "notes", "tags", "note_tags", "note_attachments", "note_revisions",
    "note_history_state", "sync_state", "sync_sweep",
)
private val upgradeGeneration = Regex("[a-f0-9]{32}")
private val installedUpgradeUserId = Regex("[A-Za-z0-9_-]+")

internal class LegacyUpgradeExportRequired : IllegalStateException("A Flutter upgrade export is required.")

internal fun AnchorSession.upgradeAccountKey(): String {
    val key = Buffer().apply { write("${origin}\u0000${userId}".encodeToByteArray()) }
    return upgradeSha256(key).toHexString()
}

internal fun committedUpgradeName(accountKey: String, directory: String): String {
    val name = Path(directory).name
    require(name == accountKey ||
        name.startsWith("$accountKey.") && upgradeGeneration.matches(name.substringAfter('.'))) {
        "Invalid committed Flutter upgrade location."
    }
    return name
}

internal suspend fun DraftDatabase.importStagedLegacyUpgrade(
    supportDirectory: Path,
    account: AnchorSession,
    installedDocuments: Path? = null,
    installedShareFolder: Path? = null,
): Boolean =
    withContext(Dispatchers.IO) {
        val fs = SystemFileSystem
        val imported = legacyUpgrade().imported(account.origin, account.userId)
        fun noBundle(): Boolean {
            require(imported == null) { "Committed Flutter upgrade package is unavailable." }
            if (installedDocuments != null && installedUpgradeUserId.matches(account.userId) &&
                fs.metadataOrNull(Path(installedDocuments, "db_${account.userId}.sqlite"))?.isRegularFile == true
            ) {
                throw LegacyUpgradeExportRequired()
            }
            return false
        }
        if (!fs.exists(supportDirectory)) return@withContext noBundle()
        val namespace = Path(fs.resolve(supportDirectory), "legacy-upgrade")
        if (!fs.exists(namespace)) return@withContext noBundle()
        require(fs.resolve(namespace) == namespace) { "Invalid Flutter upgrade directory." }
        val accountKey = account.upgradeAccountKey()
        val name = if (imported != null) {
            committedUpgradeName(accountKey, imported.directory)
        } else {
            val selection = Path(namespace, "$accountKey.current")
            if (fs.list(namespace).none { it.name == selection.name }) {
                accountKey
            } else {
                val metadata = fs.metadataOrNull(selection)
                require(metadata?.isRegularFile == true && metadata.size == 32L && fs.resolve(selection) == selection) {
                    "Invalid Flutter upgrade selection."
                }
                val generation = fs.source(selection).buffered().use { it.readString() }
                require(upgradeGeneration.matches(generation)) { "Invalid Flutter upgrade selection." }
                "$accountKey.$generation"
            }
        }
        val bundle = Path(namespace, name)
        if (!fs.exists(bundle)) {
            require(imported == null && name == accountKey) { "Selected Flutter upgrade package is unavailable." }
            return@withContext noBundle()
        }
        require(fs.resolve(bundle) == bundle) { "Invalid Flutter upgrade package location." }
        importLegacyUpgrade(bundle, account, installedDocuments, installedShareFolder)
    }

// Retain the private bundle with its media until activation has consumed it.
internal suspend fun DraftDatabase.importLegacyUpgrade(
    directory: Path,
    account: AnchorSession,
    installedDocuments: Path? = null,
    installedShareFolder: Path? = null,
): Boolean =
    withContext(Dispatchers.IO) {
        val bundle = verifyLegacyUpgradeBundle(directory, account)
        useWriterConnection { writer ->
            writer.withTransaction(Transactor.SQLiteTransactionType.IMMEDIATE) {
                val dao = legacyUpgrade()
                val previous = dao.imported(account.origin, account.userId)
                if (previous != null) {
                    require(previous.manifest == bundle.manifest) {
                        "A different Flutter collection has already been imported for this account."
                    }
                    if (!previous.outboxPrepared || !previous.trashUploadsPrepared) {
                        prepareFlutterOutbox(account, dao, bundle, trashOnly = previous.outboxPrepared)
                    }
                    if (!previous.noteChangesPrepared) prepareFlutterNoteChanges(account, dao)
                    if (!previous.metadataPrepared) prepareFlutterMetadata(account, dao)
                    if (!previous.historyAndDeletesPrepared) prepareFlutterHistoryAndDeletes(account, dao)
                    if (!previous.sharesPrepared) prepareFlutterShares(account, dao, bundle.shares)
                    prepareFlutterCache(account, dao)
                    return@withTransaction false
                }

                if (bundle.installed) checkInstalledDatabase(account, installedDocuments, bundle)
                if (bundle.installedShareInbox) checkInstalledShareInbox(account, installedShareFolder, bundle)
                BundledSQLiteDriver().open(bundle.database.toString(), SQLITE_OPEN_READONLY).use { source ->
                    source.execSQL("PRAGMA trusted_schema=OFF")
                    source.prepare("PRAGMA user_version").use { version ->
                        require(version.step() && version.getInt(0) == bundle.schemaVersion) {
                            "Flutter database version differs from the upgrade manifest."
                        }
                    }
                    for (table in legacyTables) {
                        source.prepare("PRAGMA table_list('$table')").use { schema ->
                            require(schema.step() && schema.getText(2) == "table") {
                                "Required Flutter database table is missing or invalid."
                            }
                        }
                        source.prepare("SELECT * FROM $table ORDER BY rowid").use { rows ->
                            val names = rows.getColumnNames()
                            var ordinal = 0L
                            while (rows.step()) {
                                val payload = rows.legacyPayload(names)
                                dao.addRow(LegacyUpgradeRow(
                                    account.origin, account.userId, table, ordinal++, payload.toString(),
                                ))
                            }
                        }
                    }
                }
                dao.addImport(LegacyUpgradeImport(
                    account.origin, account.userId, checkNotNull(bundle.database.parent).name, bundle.manifest,
                ))
                prepareFlutterOutbox(account, dao, bundle)
                prepareFlutterNoteChanges(account, dao)
                prepareFlutterMetadata(account, dao)
                prepareFlutterHistoryAndDeletes(account, dao)
                prepareFlutterShares(account, dao, bundle.shares)
                prepareFlutterCache(account, dao)
                true
            }
        }
    }

private fun checkInstalledDatabase(
    account: AnchorSession,
    documents: Path?,
    bundle: VerifiedLegacyUpgradeBundle,
) {
    require(documents != null && installedUpgradeUserId.matches(account.userId)) {
        "Flutter source database is unavailable."
    }
    val fs = SystemFileSystem
    val current = Path(fs.resolve(documents), "db_${account.userId}.sqlite")
    require(fs.metadataOrNull(current)?.isRegularFile == true && fs.resolve(current) == current) {
        "Flutter source database is unavailable."
    }
    val driver = BundledSQLiteDriver()
    driver.open(current.toString(), SQLITE_OPEN_READONLY).use { source ->
        source.execSQL("PRAGMA trusted_schema=OFF")
        source.execSQL("BEGIN")
        fun unchanged(condition: Boolean) {
            require(condition) { "Flutter data changed after the backup was prepared." }
        }
        source.prepare("PRAGMA user_version").use { version ->
            unchanged(version.step() && version.getInt(0) == bundle.schemaVersion)
        }
        driver.open(bundle.database.toString(), SQLITE_OPEN_READONLY).use { saved ->
            saved.execSQL("PRAGMA trusted_schema=OFF")
            for (table in legacyTables) {
                val query = "SELECT * FROM $table ORDER BY rowid"
                source.prepare(query).use { currentRows ->
                    saved.prepare(query).use { savedRows ->
                        val names = currentRows.getColumnNames()
                        unchanged(names == savedRows.getColumnNames())
                        while (currentRows.step()) {
                            unchanged(savedRows.step() && currentRows.legacyPayload(names) == savedRows.legacyPayload(names))
                        }
                        unchanged(!savedRows.step())
                    }
                }
            }
        }
    }
}

private fun SQLiteStatement.legacyPayload(names: List<String>): JsonObject = buildJsonObject {
    for ((index, name) in names.withIndex()) {
        put(name, when (getColumnType(index)) {
            SQLITE_DATA_NULL -> JsonNull
            SQLITE_DATA_INTEGER -> JsonPrimitive(getLong(index))
            SQLITE_DATA_TEXT -> JsonPrimitive(getText(index))
            else -> throw IllegalArgumentException("Unsupported Flutter database field.")
        })
    }
}

private suspend fun DraftDatabase.prepareFlutterOutbox(
    account: AnchorSession,
    legacy: LegacyUpgradeDao,
    bundle: VerifiedLegacyUpgradeBundle,
    trashOnly: Boolean = false,
) {
    val origin = account.origin
    val userId = account.userId
    val parents = legacy.records(account, "notes").filter {
        val state = it.text("state")
        state == "trashed" || (!trashOnly && state == "active")
    }.associateBy { it.text("id") }
    val newNoteIds = mutableSetOf<String>()
    if (!trashOnly) {
        val draftDao = drafts()
        val pendingIds = draftDao.list(origin, userId).mapTo(mutableSetOf()) { it.id }
        for ((id, row) in parents) {
            if (row.flag("is_synced") || row.number("version") != null || !id.isUploadId()) continue
            if (pendingIds.add(id)) {
                draftDao.enqueue(PendingNote(
                    origin, userId, id, row.text("title"), content = "", deltaContent = row.optionalText("content"),
                    flutterFields = row.flutterNoteFields(creating = true),
                ))
            }
            newNoteIds.add(id)
        }
    }
    val outbox = attachmentOutbox()
    // Convex prepends each upload, so send the lowest-priority files first.
    val pendingUploads = legacy.records(account, "note_attachments")
        .filter { it.text("sync_status") == "pending_upload" }
        .sortedByDescending { it.getValue("position").jsonPrimitive.int }
    for (row in pendingUploads) {
        val id = row.text("id")
        val noteId = row.text("note_id")
        val parent = parents[noteId] ?: continue
        if ((!trashOnly && parent.number("version") == null && noteId !in newNoteIds) ||
            !id.isUploadId() || !noteId.isUploadId()) continue
        val size = checkNotNull(row.number("file_size"))
        if (size !in 1L..maxAttachmentBytes.toLong()) continue
        val file = requireNotNull(bundle.attachments[id]) { "Pending Flutter attachment is missing." }
        val upload = PendingAttachmentUpload(
            id, origin, userId, noteId, row.text("original_filename"), row.text("mime_type"), size.toInt(),
            retainOnMissingNote = true,
            deferUntilRestored = parent.text("state") == "trashed",
        )
        outbox.enqueueFlutterFile(upload, file)
    }
    legacy.markOutboxPrepared(origin, userId)
}

private suspend fun DraftDatabase.prepareFlutterShares(
    account: AnchorSession,
    legacy: LegacyUpgradeDao,
    shares: Map<String, LegacyUpgradeShare>,
) {
    val origin = account.origin
    val userId = account.userId
    if (shares.isNotEmpty()) {
        val notes = legacy.records(account, "notes").associateBy { it.text("id") }
        val tagIds = legacy.records(account, "tags").filterNot { it.flag("is_deleted") }
            .mapTo(mutableSetOf()) { JsonPrimitive(it.text("id")) }
        val draftDao = drafts()
        val pendingIds = draftDao.list(origin, userId).mapTo(mutableSetOf()) { it.id }
        val outbox = attachmentOutbox()
        for ((id, share) in shares) {
            if (notes[id]?.text("state") == "deleted") continue
            val details = share.details
            require(id.isUploadId() && details.getValue("version").jsonPrimitive.int == 1)
            val savedAt = Instant.parse(details.text("savedAt")).toString()
            if (id !in notes && pendingIds.add(id)) {
                val fields = buildJsonObject { put("createdAt", savedAt) }
                draftDao.enqueue(PendingNote(
                    origin, userId, id, details.shareText("title").orEmpty().takeUnless { it.isBlank() }.orEmpty(),
                    content = "", deltaContent = shareNoteContent(details.shareText("text").orEmpty(), details.shareText("link")),
                    flutterFields = fields.toString(),
                ))
                val selectedTags = (details["tagIds"] as? JsonArray).orEmpty().filter { it in tagIds }.distinct()
                if (selectedTags.isNotEmpty()) {
                    val payload = buildJsonObject {
                        put("type", "noteTags")
                        put("id", id)
                        put("tagIds", JsonArray(selectedTags))
                    }
                    legacy.addMetadata(LegacyMetadataChange(origin, userId, "noteTags", id, payload.toString()))
                }
            }
            val descriptors = details.getValue("files") as JsonArray
            // The upload endpoint prepends attachments.
            for (entry in descriptors.asReversed()) {
                val descriptor = entry.jsonObject
                val name = descriptor.text("file")
                val file = share.files.getValue(name)
                val size = checkNotNull(SystemFileSystem.metadataOrNull(file)).size
                if (size !in 1L..maxAttachmentBytes.toLong()) continue
                val idBytes = upgradeSha256("flutter-share\u0000$origin\u0000$userId\u0000$id\u0000$name".encodeToByteArray()).copyOf(16)
                idBytes[6] = ((idBytes[6].toInt() and 15) or 128).toByte()
                idBytes[8] = ((idBytes[8].toInt() and 63) or 128).toByte()
                val upload = PendingAttachmentUpload(
                    Uuid.fromByteArray(idBytes).toString(), origin, userId, id,
                    descriptor.text("name"), descriptor.text("mime"), size.toInt(), retainOnMissingNote = true,
                )
                outbox.enqueueFlutterFile(upload, file)
            }
        }
    }
    legacy.markSharesPrepared(origin, userId)
}

private fun JsonObject.shareText(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

private val shareWords = Regex("\\S+")
private val shareEmail = Regex("^[\\w.+-]+@[\\w-]+(\\.[\\w-]+)*\\.[a-z]{2,}$", RegexOption.IGNORE_CASE)

internal fun shareNoteContent(text: String, link: String? = null): String? {
    val body = text.replace("\r\n", "\n").replace('\r', '\n').trimEnd()
    val sharedLink = link?.takeIf { it.isNotEmpty() }
    if (body.isEmpty() && sharedLink == null) return null
    val runs = mutableListOf<Pair<String, String?>>()
    fun insert(value: String, url: String? = null) {
        if (value.isEmpty()) return
        val last = runs.lastOrNull()
        if (last != null && last.second == null && url == null) {
            runs[runs.lastIndex] = (last.first + value) to null
        } else {
            runs.add(value to url)
        }
    }
    var offset = 0
    for (match in shareWords.findAll(body)) {
        val start = match.value.indexOfFirst { it !in "(\"'<[{“‘" }
        if (start < 0) continue
        var word = match.value.substring(start).trimEnd { it in ".,;:!?'\">]}”’" }
        while (word.endsWith(')') && word.count { it == ')' } > word.count { it == '(' }) {
            word = word.dropLast(1)
        }
        val address = when {
            shareEmail.matches(word) -> "mailto:$word"
            ':' in word || word.startsWith("www.", ignoreCase = true) -> normalizedNoteLink(word)
            else -> null
        } ?: continue
        val begin = match.range.first + start
        insert(body.substring(offset, begin))
        insert(word, address)
        offset = begin + word.length
    }
    insert(body.substring(offset))
    if (sharedLink != null) {
        if (body.isNotEmpty()) insert("\n")
        insert(sharedLink, normalizedNoteLink(sharedLink))
    }
    insert("\n")
    return buildJsonObject {
        put("ops", JsonArray(runs.map { (value, linkTarget) ->
            buildJsonObject {
                put("insert", value)
                linkTarget?.let { put("attributes", buildJsonObject { put("link", it) }) }
            }
        }))
    }.toString()
}

private suspend fun AttachmentOutbox.enqueueFlutterFile(upload: PendingAttachmentUpload, file: Path) {
    SystemFileSystem.source(file).buffered().use { source ->
        enqueue(upload) { _, length -> source.readByteArray(length) }
        require(source.exhausted()) { "Pending Flutter attachment length differs from the manifest." }
    }
}

private suspend fun prepareFlutterMetadata(account: AnchorSession, legacy: LegacyUpgradeDao) {
    suspend fun add(kind: String, id: String, fields: JsonObjectBuilder.() -> Unit) {
        val payload = buildJsonObject {
            put("type", kind)
            put("id", id)
            fields()
        }
        legacy.addMetadata(LegacyMetadataChange(account.origin, account.userId, kind, id, payload.toString()))
    }

    val tags = legacy.records(account, "tags")
    for (tag in tags.filterNot { it.flag("is_synced") }) {
        add("tag", tag.text("id")) {
            put("name", tag.text("name"))
            put("color", tag.getValue("color"))
            put("isDeleted", tag.flag("is_deleted"))
            tag.number("version")?.let { put("baseVersion", it) }
        }
    }
    val activeTagIds = tags.filterNot { it.flag("is_deleted") }.mapTo(mutableSetOf()) { it.text("id") }
    val links = legacy.records(account, "note_tags").filter { it.text("tag_id") in activeTagIds }
        .groupBy({ it.text("note_id") }, { it.text("tag_id") })
    for (note in legacy.records(account, "notes").filter { it.text("state") != "deleted" }) {
        val id = note.text("id")
        if (!note.flag("is_synced")) {
            add("noteTags", id) {
                put("tagIds", JsonArray(links[id].orEmpty().distinct().map(::JsonPrimitive)))
            }
        }
        if (!note.flag("is_pin_synced")) {
            add("pin", id) { put("isPinned", note.flag("is_pinned")) }
        }
        if (!note.flag("is_reminder_synced")) {
            add("reminder", id) {
                put("remindAt", note.getValue("reminder_at"))
                val recurrence = note.optionalText("reminder_recurrence")
                put("recurrence", recurrence?.takeIf { it in listOf("daily", "weekly", "monthly", "yearly") } ?: "none")
                note.number("reminder_version")?.let { put("baseVersion", it) }
            }
        }
    }
    legacy.markMetadataPrepared(account.origin, account.userId)
}

private suspend fun prepareFlutterHistoryAndDeletes(account: AnchorSession, legacy: LegacyUpgradeDao) {
    val origin = account.origin
    val userId = account.userId
    val liveNoteIds = legacy.records(account, "notes").filter { it.text("state") != "deleted" }
        .mapTo(mutableSetOf()) { it.text("id") }
    val revisions = legacy.records(account, "note_revisions").filterNot { it.flag("is_synced") }
        .sortedWith(compareBy({ it.number("created_at") }, { it.text("id") }))
    for (row in revisions) {
        val noteId = row.text("note_id")
        val cause = row.text("cause")
        if (noteId !in liveNoteIds || cause !in listOf("edit", "restore")) continue
        val revisionId = row.text("id")
        val payload = buildJsonObject {
            put("type", "revision")
            put("id", revisionId)
            put("noteId", noteId)
            put("revision", buildJsonObject {
                put("id", revisionId)
                put("title", row.text("title"))
                put("content", row.getValue("content"))
                put("version", row.getValue("version"))
                put("cause", cause)
                put("createdAt", Instant.fromEpochMilliseconds(checkNotNull(row.number("created_at"))).toString())
            })
        }
        legacy.addMetadata(LegacyMetadataChange(origin, userId, "revision", revisionId, payload.toString()))
    }
    for (row in legacy.records(account, "note_attachments").filter { it.text("sync_status") == "pending_delete" }) {
        val noteId = row.text("note_id")
        val serverId = row.optionalText("server_attachment_id") ?: row.text("id")
        if (noteId !in liveNoteIds || !noteId.isUploadId() || !serverId.isUploadId()) continue
        val payload = buildJsonObject {
            put("type", "attachmentDelete")
            put("id", serverId)
            put("noteId", noteId)
        }
        legacy.addMetadata(LegacyMetadataChange(origin, userId, "attachmentDelete", row.text("id"), payload.toString()))
    }
    legacy.markHistoryAndDeletesPrepared(origin, userId)
}

internal suspend fun DraftDatabase.sendFlutterMetadata(account: AnchorSession, send: suspend (JsonObject, String?) -> String): Boolean {
    val dao = legacyUpgrade()
    var rejected = false
    for (change in dao.readyMetadata(account.origin, account.userId)) {
        val result = try {
            send(Json.parseToJsonElement(change.payload).jsonObject, change.outboxScope)
        } catch (error: AnchorHttpFailure) {
            when {
                error.outboxScopeChanged -> "server_changed"
                error.status == 400 -> "invalid"
                error.status == 404 -> "denied"
                else -> throw error
            }
        }
        when (result) {
            "applied" -> dao.acknowledgeMetadata(account.origin, account.userId, change.kind, change.entityId)
            "conflict", "denied", "invalid", "server_changed" -> {
                dao.rejectMetadata(account.origin, account.userId, change.kind, change.entityId, result)
                rejected = true
            }
            else -> throw AnchorHttpFailure(503)
        }
    }
    return rejected
}

private suspend fun DraftDatabase.prepareFlutterNoteChanges(account: AnchorSession, legacy: LegacyUpgradeDao) {
    val origin = account.origin
    val userId = account.userId
    val draftDao = drafts()
    val pendingIds = draftDao.list(origin, userId).mapTo(mutableSetOf()) { it.id }
    for (row in legacy.records(account, "notes")) {
        if (row.flag("is_synced")) continue
        val version = row.number("version") ?: continue
        val id = row.text("id")
        if (version !in 1L..9_007_199_254_740_991L || !id.isUploadId() || !pendingIds.add(id)) continue
        draftDao.enqueue(PendingNote(
            origin, userId, id, row.text("title"), content = "", baseVersion = version,
            deltaContent = row.optionalText("content"), flutterFields = row.flutterNoteFields(creating = false),
        ))
    }
    legacy.markNoteChangesPrepared(origin, userId)
}

private suspend fun DraftDatabase.prepareFlutterCache(account: AnchorSession, legacy: LegacyUpgradeDao) {
    val (origin, userId) = account.origin to account.userId
    val cache = notes()
    if (cache.cursor(origin, userId) != null) return
    val tags = legacy.records(account, "tags").filterNot { it.flag("is_deleted") }.map { row ->
        CachedTag(origin, userId, row.text("id"), row.text("name"), row.optionalText("color"), null, row.number("version") ?: 0)
    }
    val tagIds = tags.mapTo(mutableSetOf()) { it.id }
    val noteTags = legacy.records(account, "note_tags").filter { it.text("tag_id") in tagIds }
        .groupBy({ it.text("note_id") }, { it.text("tag_id") })
    val attachments = legacy.records(account, "note_attachments").filter { it.text("sync_status") == "synced" }
        .groupBy { it.text("note_id") }
    val entries = legacy.records(account, "notes").filter { it.text("state") in listOf("active", "trashed") }.map { row ->
        val id = row.text("id")
        val note = CachedNote(
            origin, userId, id, row.text("title"), row.optionalText("content"), row.number("version") ?: 0,
            isPinned = row.flag("is_pinned"),
            remindAt = row.optionalText("reminder_at"),
            reminderRecurrence = row.optionalText("reminder_recurrence"),
            reminderVersion = row.number("reminder_version"),
            background = row.optionalText("background"),
            updatedAt = row["updated_at"]?.jsonPrimitive?.longOrNull?.let { Instant.fromEpochSeconds(it).toString() },
            createdAt = row["created_at"]?.jsonPrimitive?.longOrNull?.let { Instant.fromEpochSeconds(it).toEpochMilliseconds() },
            isArchived = row.flag("is_archived"),
            isTrashed = row.text("state") == "trashed",
        )
        val files = attachments[id].orEmpty().map { media ->
            CachedAttachment(
                origin, userId, id, media.optionalText("server_attachment_id") ?: media.text("id"),
                media.text("type"), media.text("original_filename"), media.text("mime_type"),
                media.getValue("file_size").jsonPrimitive.long,
                media.optionalText("uploaded_by_user_id").orEmpty(),
                Instant.fromEpochSeconds(media.getValue("created_at").jsonPrimitive.long).toString(),
                media.getValue("position").jsonPrimitive.int,
            )
        }
        FeedEntry.Upsert(note, noteTags[id].orEmpty(), files)
    }
    cache.seedFromFlutter(origin, userId, entries, tags)
}

private suspend fun LegacyUpgradeDao.records(account: AnchorSession, table: String) =
    rows(account.origin, account.userId, table).map { Json.parseToJsonElement(it.payload).jsonObject }

internal suspend fun DraftDatabase.readFlutterRevisions(account: AnchorSession, noteId: String): List<NoteRevision> =
    withContext(Dispatchers.IO) {
        legacyUpgrade().revisionPayloads(account.origin, account.userId, noteId).map { payload ->
            val row = Json.parseToJsonElement(payload).jsonObject
            NoteRevision(
                id = row.text("id"),
                title = row.text("title"),
                content = row.optionalText("content"),
                createdAt = Instant.fromEpochMilliseconds(checkNotNull(row.number("created_at"))),
                cause = row.text("cause"),
                author = row.optionalText("author_name"),
            )
        }
    }

private fun JsonObject.flutterNoteFields(creating: Boolean): String = buildJsonObject {
    val state = text("state")
    put("isArchived", flag("is_archived"))
    put("background", getValue("background"))
    if (creating || text("permission") == "owner" || state == "deleted") put("state", state)
    if (creating) {
        this@flutterNoteFields["created_at"]?.jsonPrimitive?.longOrNull?.let {
            put("createdAt", Instant.fromEpochSeconds(it).toString())
        }
    }
}.toString()

private fun String.isUploadId(): Boolean = runCatching { Uuid.parseHexDash(this) }.isSuccess
private fun JsonObject.optionalText(key: String): String? = getValue(key).jsonPrimitive.contentOrNull
private fun JsonObject.text(key: String): String = checkNotNull(optionalText(key))
private fun JsonObject.number(key: String): Long? = getValue(key).takeUnless { it is JsonNull }?.jsonPrimitive?.long
private fun JsonObject.flag(key: String): Boolean = getValue(key).jsonPrimitive.int == 1
