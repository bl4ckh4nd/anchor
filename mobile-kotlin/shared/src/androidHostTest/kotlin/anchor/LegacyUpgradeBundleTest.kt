package anchor

import java.io.File
import java.security.MessageDigest
import kotlinx.io.files.Path
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

// Wrong account or origin, corrupt bytes, path escape and unverified SQLite sidecars must abort.
class LegacyUpgradeBundleTest {
    @get:Rule
    val temp = TemporaryFolder()

    @Test
    fun verifiesPrivateBundleBeforeExposingItsDatabase() {
        val root = temp.newFolder()
        val database = File(root, "collection.sqlite").apply { writeText("database fixture") }
        val files = File(root, "files").apply { mkdir() }
        val media = File(files, "0")
        val mediaBytes = ByteArray(128 * 1024 + 5) { (it % 131).toByte() }
        media.writeBytes(mediaBytes)
        val shareManifest = File(files, "1")
        val shareMedia = File(files, "2").apply { writeText("shared file") }
        val manifest = File(root, "manifest.json")
        fun writeShare(user: String) = shareManifest.writeText(
            """{"version":1,"id":"share","userId":"$user","files":[{"file":"share.txt"}]}""",
        )
        fun writeManifest(mediaPath: String = "files/0") = manifest.writeText(
            """{"version":1,"schemaVersion":12,"userId":"owner","origin":"https://anchor.example",
            "database":${receipt("collection.sqlite", database)},
            "attachments":{"upload":${receipt(mediaPath, media)}},
            "shares":{"share":{"manifest":${receipt("files/1", shareManifest)},
            "files":{"share.txt":${receipt("files/2", shareMedia)}}}}}""",
        )
        val account = AnchorSession("https://anchor.example", "owner", "", null)
        val directory = Path(root.absolutePath)
        writeShare(account.userId)
        writeManifest()
        val verified = verifyLegacyUpgradeBundle(directory, account)
        assertEquals(Path(database.absolutePath), verified.database)
        assertEquals(Path(media.absolutePath), verified.attachments["upload"])
        assertEquals(Path(shareMedia.absolutePath), verified.shares["share"]?.files?.get("share.txt"))
        assertThrows(IllegalArgumentException::class.java) {
            verifyLegacyUpgradeBundle(directory, AnchorSession(account.origin, "other", "", null))
        }
        assertThrows(IllegalArgumentException::class.java) {
            verifyLegacyUpgradeBundle(directory, AnchorSession("https://other.example", account.userId, "", null))
        }
        writeManifest("files/../collection.sqlite")
        assertThrows(IllegalArgumentException::class.java) { verifyLegacyUpgradeBundle(directory, account) }
        writeManifest()
        media.writeBytes(mediaBytes.copyOf().apply { this[lastIndex] = 127 })
        assertThrows(IllegalArgumentException::class.java) { verifyLegacyUpgradeBundle(directory, account) }
        media.writeBytes(mediaBytes)
        writeShare("other")
        writeManifest()
        assertThrows(IllegalArgumentException::class.java) { verifyLegacyUpgradeBundle(directory, account) }
        writeShare(account.userId)
        writeManifest()
        val sidecar = File(root, "collection.sqlite-wal").apply { writeText("not in manifest") }
        assertThrows(IllegalArgumentException::class.java) { verifyLegacyUpgradeBundle(directory, account) }
        sidecar.delete()
        assertEquals(Path(database.absolutePath), verifyLegacyUpgradeBundle(directory, account).database)
    }

    private fun receipt(path: String, file: File): String {
        val hash = MessageDigest.getInstance("SHA-256").digest(file.readBytes()).oidcHex()
        return """{"path":"$path","size":${file.length()},"sha256":"$hash"}"""
    }
}
