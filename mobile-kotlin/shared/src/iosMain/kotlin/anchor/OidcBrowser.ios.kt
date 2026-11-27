package anchor

import androidx.compose.runtime.Composable
import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.cinterop.addressOf
import kotlinx.cinterop.reinterpret
import kotlinx.cinterop.usePinned
import platform.CoreCrypto.CC_SHA256
import platform.Foundation.NSURL
import platform.Security.SecRandomCopyBytes
import platform.Security.errSecSuccess
import platform.Security.kSecRandomDefault
import platform.UIKit.UIApplication

@OptIn(ExperimentalForeignApi::class)
internal actual fun createOidcProof(): OidcProof {
    val verifier = ByteArray(32).apply {
        usePinned { check(SecRandomCopyBytes(kSecRandomDefault, size.toULong(), it.addressOf(0)) == errSecSuccess) }
    }.oidcHex()
    val input = verifier.encodeToByteArray()
    val challenge = ByteArray(32)
    input.usePinned { data ->
        challenge.usePinned { result ->
            CC_SHA256(data.addressOf(0), input.size.toUInt(), result.addressOf(0).reinterpret())
        }
    }
    return OidcProof(verifier, challenge.oidcHex())
}

@Composable
internal actual fun rememberOpenBrowser(): (String) -> Unit = { url ->
    val target = checkNotNull(NSURL.URLWithString(url))
    val application = UIApplication.sharedApplication
    check(application.canOpenURL(target))
    application.openURL(target, options = emptyMap<Any?, Any>(), completionHandler = null)
}
