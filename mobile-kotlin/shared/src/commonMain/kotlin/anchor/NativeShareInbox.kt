package anchor

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.IO
import kotlinx.coroutines.withContext
import kotlinx.io.buffered
import kotlinx.io.files.Path
import kotlinx.io.files.SystemFileSystem
import kotlinx.io.readByteArray
import kotlinx.io.readString
import kotlinx.io.writeString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import kotlin.time.Instant
import kotlin.uuid.Uuid

internal suspend fun publishShareContext(
    directory: Path,
    account: AnchorSession?,
    tags: List<CachedTag>,
    theme: AnchorAppearance,
    density: AnchorDensity = AnchorDensity.Standard,
) =
    withContext(Dispatchers.IO) {
        val fs = SystemFileSystem
        fs.createDirectories(directory)
        val root = fs.resolve(directory)
        val context = buildJsonObject {
            if (account != null) {
                put("origin", account.origin)
                put("userId", account.userId)
                put("theme", theme.name.lowercase())
                put("density", density.name.lowercase())
                put("tags", JsonArray(tags.map { tag ->
                    require(tag.origin == account.origin && tag.userId == account.userId)
                    buildJsonObject {
                        put("id", tag.id)
                        put("name", tag.name)
                        put("color", tag.color?.let(::JsonPrimitive) ?: JsonNull)
                    }
                }))
            }
        }
        val temp = Path(root, ".context-${Uuid.random()}")
        try {
            fs.sink(temp).buffered().use { it.writeString(context.toString()) }
            fs.atomicMove(temp, Path(root, "context.json"))
        } finally {
            fs.delete(temp, mustExist = false)
        }
    }

internal suspend fun DraftDatabase.importNativeShareInbox(account: AnchorSession, directory: Path): List<PendingNote> =
    withContext(Dispatchers.IO) {
        val fs = SystemFileSystem
        if (!fs.exists(directory)) return@withContext emptyList()
        val inbox = Path(fs.resolve(directory), "inbox")
        if (!fs.exists(inbox)) return@withContext emptyList()
        require(fs.resolve(inbox) == inbox)
        val imported = mutableListOf<PendingNote>()
        for (folder in fs.list(inbox)) {
            try {
                if (fs.metadataOrNull(folder)?.isDirectory != true || fs.resolve(folder) != folder) continue
                val id = folder.name
                Uuid.parseHexDash(id)
                val manifest = Path(folder, "manifest.json")
                require(fs.resolve(manifest) == manifest)
                val size = fs.metadataOrNull(manifest)
                require(size?.isRegularFile == true && size.size in 1L..(1024 * 1024L))
                val details = fs.source(manifest).buffered().use { Json.parseToJsonElement(it.readString()).jsonObject }
                if (details["userId"] != JsonPrimitive(account.userId) || details["origin"] != JsonPrimitive(account.origin)) continue
                require(details["id"] == JsonPrimitive(id) && details["version"] == JsonPrimitive(1))
                val files = checkNotNull(details["files"] as? JsonArray)
                require(files.size <= 20)
                val paths = mutableSetOf<Path>()
                val readFiles: List<() -> PickedAttachment> = files.map { item ->
                    val descriptor = item.jsonObject
                    val name = checkNotNull(descriptor.shareString("file"))
                    require(name.isNotBlank() && name != manifest.name && !name.startsWith('.') && '/' !in name && '\\' !in name)
                    val file = Path(folder, name)
                    require(paths.add(file))
                    val filename = checkNotNull(descriptor.shareString("name"))
                    val mime = checkNotNull(descriptor.shareString("mime"))
                    val read: () -> PickedAttachment = {
                        require(fs.resolve(file) == file)
                        val data = fs.metadataOrNull(file)
                        require(data?.isRegularFile == true && data.size in 1L..maxAttachmentBytes.toLong())
                        val bytes = fs.source(file).buffered().use { source ->
                            source.readByteArray(data.size.toInt()).also { require(source.exhausted()) }
                        }
                        PickedAttachment(filename, mime, bytes)
                    }
                    read
                }
                val note = IncomingShare(
                    id, details.shareString("title").orEmpty(), details.shareString("text").orEmpty(), readFiles,
                    link = details.shareString("link"),
                    savedAt = Instant.parse(checkNotNull(details.shareString("savedAt"))).toString(),
                    tagIds = (details["tagIds"] as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.takeIf { it.isString }?.content },
                )
                saveIncomingShare(account, note)?.let(imported::add)
                for (file in paths) fs.delete(file, mustExist = false)
                fs.delete(manifest)
                fs.delete(folder)
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                // Leave an unreadable or uncommitted share for a later attempt.
            }
        }
        imported
    }

private fun JsonObject.shareString(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
