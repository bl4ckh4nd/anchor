package anchor

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.IO
import kotlinx.coroutines.withContext
import kotlinx.io.IOException
import kotlinx.io.Source
import kotlinx.io.buffered
import kotlinx.io.files.Path
import kotlinx.io.files.SystemFileSystem
import kotlinx.io.readByteArray
import kotlinx.io.readString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull

internal data class VerifiedLegacyUpgradeBundle(
    val schemaVersion: Int,
    val manifest: String,
    val installed: Boolean,
    val installedShareInbox: Boolean,
    val database: Path,
    val attachments: Map<String, Path>,
    val shares: Map<String, LegacyUpgradeShare>,
)

internal data class LegacyUpgradeShare(val details: JsonObject, val files: Map<String, Path>)

private val payloadName = Regex("files/(0|[1-9][0-9]*)")
private val sha256Hex = Regex("[0-9a-f]{64}")

// The caller owns this private staging directory and keeps it unchanged through import.
internal fun verifyLegacyUpgradeBundle(directory: Path, account: AnchorSession): VerifiedLegacyUpgradeBundle {
    val fs = SystemFileSystem
    val root = fs.resolve(directory)
    val payloads = Path(root, "files")
    require(fs.list(root).map { it.name }.toSet() == setOf("collection.sqlite", "manifest.json", "files")) {
        "Unexpected files at the root of the upgrade bundle."
    }
    require(fs.resolve(payloads) == payloads && fs.metadataOrNull(payloads)?.isDirectory == true) {
        "Invalid upgrade payload directory."
    }
    fun requireRegularFile(file: Path) {
        require(fs.resolve(file) == file && fs.metadataOrNull(file)?.isRegularFile == true) {
            "Invalid file in upgrade bundle."
        }
    }
    fun readJson(file: Path): JsonObject {
        requireRegularFile(file)
        return fs.source(file).buffered().use { source ->
            Json.parseToJsonElement(source.readString()) as? JsonObject
                ?: throw IllegalArgumentException("Invalid upgrade manifest.")
        }
    }
    val manifest = readJson(Path(root, "manifest.json"))
    val schema = (manifest["schemaVersion"] as? JsonPrimitive)?.intOrNull
    require((manifest["version"] as? JsonPrimitive)?.intOrNull == 1 && (schema == 11 || schema == 12)) {
        "Unsupported upgrade bundle version."
    }
    require(manifest["userId"] == JsonPrimitive(account.userId) && manifest["origin"] == JsonPrimitive(account.origin)) {
        "Upgrade bundle does not match this account and server."
    }
    val installed = manifest["installed"]
    require(installed == null || installed == JsonPrimitive(true)) { "Invalid Flutter upgrade source." }
    val installedShareInbox = manifest["installedShareInbox"]
    require(installedShareInbox == null || installed != null && installedShareInbox == JsonPrimitive(true)) {
        "Invalid Flutter share source."
    }

    val expectedPayloads = mutableSetOf<String>()
    fun verifyFile(receipt: JsonObject, database: Boolean = false): Path {
        val location = (receipt["path"] as? JsonPrimitive)?.takeIf { it.isString }?.content.orEmpty()
        val file = if (database) {
            require(location == "collection.sqlite") { "Invalid upgrade database path." }
            Path(root, location)
        } else {
            require(payloadName.matches(location)) { "Invalid upgrade payload path." }
            val name = location.substringAfter('/')
            require(expectedPayloads.add(name)) { "Repeated upgrade payload path." }
            Path(payloads, name)
        }
        requireRegularFile(file)
        val hash = (receipt["sha256"] as? JsonPrimitive)?.takeIf { it.isString }?.content.orEmpty()
        val size = (receipt["size"] as? JsonPrimitive)?.longOrNull
        require(size != null && size >= 0 && size == fs.metadataOrNull(file)?.size && sha256Hex.matches(hash)) {
            "Invalid upgrade payload receipt."
        }
        require(fs.source(file).buffered().use(::upgradeSha256).toHexString() == hash) {
            "Upgrade payload checksum mismatch."
        }
        return file
    }
    val database = verifyFile(manifest.requiredObject("database"), database = true)
    val attachmentEntries = manifest.requiredObject("attachments")
    val attachments = attachmentEntries.mapValues { (id, _) ->
        verifyFile(attachmentEntries.requiredObject(id))
    }
    val shareEntries = manifest.requiredObject("shares")
    val shares = shareEntries.mapValues { (id, _) ->
        val share = shareEntries.requiredObject(id)
        val shareManifest = verifyFile(share.requiredObject("manifest"))
        val details = readJson(shareManifest)
        require(details["id"] == JsonPrimitive(id) && details["userId"] == JsonPrimitive(account.userId)) {
            "Upgrade share belongs to a different account or entry."
        }
        val files = share.requiredObject("files")
        val descriptors = details["files"] as? JsonArray
            ?: throw IllegalArgumentException("Invalid upgrade share file list.")
        val names = descriptors.map { descriptor ->
            val name = ((descriptor as? JsonObject)?.get("file") as? JsonPrimitive)
                ?.takeIf { it.isString }?.content.orEmpty()
            require(name.isNotEmpty() && !name.startsWith('.') && '/' !in name && '\\' !in name) {
                "Invalid upgrade share file name."
            }
            name
        }
        require(names.size == files.size && names.toSet() == files.keys) { "Upgrade share file list mismatch." }
        LegacyUpgradeShare(details, files.mapValues { (name, _) -> verifyFile(files.requiredObject(name)) })
    }
    require(fs.list(payloads).map { it.name }.toSet() == expectedPayloads) { "Unexpected upgrade payload files." }
    return VerifiedLegacyUpgradeBundle(
        schema, manifest.toString(), installed != null, installedShareInbox != null, database, attachments, shares,
    )
}

internal fun checkInstalledShareInbox(account: AnchorSession, directory: Path?, bundle: VerifiedLegacyUpgradeBundle) {
    require(directory != null) { "Flutter share inbox is unavailable." }
    val fs = SystemFileSystem
    val inbox = Path(fs.resolve(directory), "inbox")
    fun unchanged(condition: Boolean) {
        require(condition) { "Flutter share inbox changed after the backup was prepared." }
    }
    val packageShares = (Json.parseToJsonElement(bundle.manifest) as JsonObject).requiredObject("shares")
    val seen = mutableSetOf<String>()
    if (fs.exists(inbox)) {
        unchanged(fs.resolve(inbox) == inbox)
        for (folder in fs.list(inbox)) {
            if (fs.metadataOrNull(folder)?.isDirectory != true) continue
            unchanged(fs.resolve(folder) == folder)
            val file = Path(folder, "manifest.json")
            unchanged(fs.metadataOrNull(file)?.isRegularFile == true && fs.resolve(file) == file)
            val entry = fs.source(file).buffered().use { Json.parseToJsonElement(it.readString()) as JsonObject }
            if (entry["userId"] != JsonPrimitive(account.userId)) continue
            val share = bundle.shares[folder.name]
            unchanged(share != null && share.details == entry && seen.add(folder.name))
            val receipts = packageShares.requiredObject(folder.name).requiredObject("files")
            for ((name, _) in receipts) {
                val original = Path(folder, name)
                val receipt = receipts.requiredObject(name)
                val metadata = fs.metadataOrNull(original)
                unchanged(metadata?.isRegularFile == true &&
                    metadata.size == (receipt["size"] as? JsonPrimitive)?.longOrNull && fs.resolve(original) == original)
                unchanged(JsonPrimitive(fs.source(original).buffered().use(::upgradeSha256).toHexString()) == receipt["sha256"])
            }
        }
    }
    unchanged(seen == bundle.shares.keys)
}

private fun JsonObject.requiredObject(key: String): JsonObject =
    this[key] as? JsonObject ?: throw IllegalArgumentException("Invalid upgrade manifest object.")

internal expect fun upgradeSha256(source: Source): ByteArray
internal expect fun upgradeSha256(bytes: ByteArray): ByteArray

internal suspend fun DraftDatabase.readFlutterAttachment(
    account: AnchorSession,
    file: CachedAttachment,
    supportDirectory: Path,
): ByteArray? = withContext(Dispatchers.IO) {
    require(file.origin == account.origin && file.userId == account.userId)
    if (file.fileSize !in 1L..maxAttachmentBytes.toLong()) return@withContext null
    val upgrade = legacyUpgrade()
    val imported = upgrade.imported(account.origin, account.userId) ?: return@withContext null
    val localId = upgrade.cachedFlutterFileId(
        account.origin, account.userId, file.noteId, file.id, file.fileSize, file.mimeType,
    ) ?: return@withContext null
    val manifest = Json.parseToJsonElement(imported.manifest) as JsonObject
    val receipt = manifest.requiredObject("attachments")[localId] as? JsonObject ?: return@withContext null
    val name = (receipt["path"] as? JsonPrimitive)?.content.orEmpty()
    val hash = (receipt["sha256"] as? JsonPrimitive)?.content.orEmpty()
    val size = (receipt["size"] as? JsonPrimitive)?.longOrNull
    if (!payloadName.matches(name) || !sha256Hex.matches(hash) || size != file.fileSize) return@withContext null

    val fs = SystemFileSystem
    try {
        val namespace = Path(fs.resolve(supportDirectory), "legacy-upgrade")
        val bundle = Path(namespace, committedUpgradeName(account.upgradeAccountKey(), imported.directory))
        val path = Path(bundle, "files", name.substringAfter('/'))
        val metadata = fs.metadataOrNull(path) ?: return@withContext null
        if (!metadata.isRegularFile || metadata.size != size || fs.resolve(path) != path) return@withContext null
        fs.source(path).buffered().use { source ->
            val bytes = source.readByteArray(file.fileSize.toInt())
            bytes.takeIf { source.exhausted() && upgradeSha256(it).toHexString() == hash }
        }
    } catch (_: IOException) {
        null
    }
}
