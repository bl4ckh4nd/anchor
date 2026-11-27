package anchor

import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.cinterop.addressOf
import kotlinx.cinterop.alloc
import kotlinx.cinterop.memScoped
import kotlinx.cinterop.ptr
import kotlinx.cinterop.reinterpret
import kotlinx.cinterop.usePinned
import kotlinx.io.Source
import platform.CoreCrypto.CC_SHA256
import platform.CoreCrypto.CC_SHA256_CTX
import platform.CoreCrypto.CC_SHA256_Final
import platform.CoreCrypto.CC_SHA256_Init
import platform.CoreCrypto.CC_SHA256_Update

@OptIn(ExperimentalForeignApi::class)
internal actual fun upgradeSha256(bytes: ByteArray): ByteArray = ByteArray(32).apply {
    bytes.usePinned { input ->
        usePinned { output ->
            checkNotNull(CC_SHA256(input.addressOf(0), bytes.size.toUInt(), output.addressOf(0).reinterpret()))
        }
    }
}

@OptIn(ExperimentalForeignApi::class)
internal actual fun upgradeSha256(source: Source): ByteArray = memScoped {
    val digest = alloc<CC_SHA256_CTX>()
    check(CC_SHA256_Init(digest.ptr) == 1)
    val buffer = ByteArray(64 * 1024)
    buffer.usePinned { pinned ->
        while (true) {
            val count = source.readAtMostTo(buffer)
            if (count < 0) break
            check(CC_SHA256_Update(digest.ptr, pinned.addressOf(0), count.toUInt()) == 1)
        }
    }
    ByteArray(32).apply {
        usePinned { check(CC_SHA256_Final(it.addressOf(0).reinterpret(), digest.ptr) == 1) }
    }
}
