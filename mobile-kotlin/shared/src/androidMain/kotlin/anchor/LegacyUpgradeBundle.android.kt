package anchor

import java.security.MessageDigest
import kotlinx.io.Source

internal actual fun upgradeSha256(bytes: ByteArray): ByteArray =
    MessageDigest.getInstance("SHA-256").digest(bytes)

internal actual fun upgradeSha256(source: Source): ByteArray {
    val digest = MessageDigest.getInstance("SHA-256")
    val buffer = ByteArray(64 * 1024)
    while (true) {
        val count = source.readAtMostTo(buffer)
        if (count < 0) break
        digest.update(buffer, 0, count)
    }
    return digest.digest()
}
