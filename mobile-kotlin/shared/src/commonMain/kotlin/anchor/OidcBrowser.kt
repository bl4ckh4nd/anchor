package anchor

import androidx.compose.runtime.Composable
import kotlinx.coroutines.flow.MutableStateFlow

internal const val composeOidcReturn = "com.zhfahim.anchor.compose://oidc/callback"

class OidcBrowserCallbacks {
    internal val pending = MutableStateFlow<String?>(null)

    fun accept(url: String) {
        if (url.length <= 1024 && url.startsWith("$composeOidcReturn?")) pending.value = url
    }
}

internal data class OidcProof(val verifier: String, val challenge: String)

internal fun ByteArray.oidcHex() = joinToString("") { (it.toInt() and 255).toString(16).padStart(2, '0') }

internal expect fun createOidcProof(): OidcProof

@Composable
internal expect fun rememberOpenBrowser(): (String) -> Unit
