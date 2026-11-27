package anchor

import android.content.Intent
import android.net.Uri
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext
import java.security.MessageDigest
import java.security.SecureRandom

internal actual fun createOidcProof(): OidcProof {
    val verifier = ByteArray(32).also { SecureRandom().nextBytes(it) }.oidcHex()
    val challenge = MessageDigest.getInstance("SHA-256").digest(verifier.encodeToByteArray()).oidcHex()
    return OidcProof(verifier, challenge)
}

@Composable
internal actual fun rememberOpenBrowser(): (String) -> Unit {
    val context = LocalContext.current
    return { url -> context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
}
