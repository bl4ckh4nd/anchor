package anchor

import androidx.compose.foundation.background
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import androidx.compose.ui.Alignment
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.Row
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.background

private enum class FactorOperation(val label: String, val submit: String) {
    Replace("Replace authenticator", "Continue"),
    Rotate("Generate new recovery codes", "Generate codes"),
    Disable("Turn off authenticator", "Turn off authenticator"),
}

@Composable
internal fun AuthenticatorSettings(api: AnchorApi, session: AnchorSession, onClose: () -> Unit) {
    val scope = rememberCoroutineScope()
    var status by remember { mutableStateOf<AuthenticatorStatus?>(null) }
    var operation by remember { mutableStateOf<FactorOperation?>(null) }
    var key by remember { mutableStateOf<String?>(null) }
    var codes by remember { mutableStateOf<List<String>?>(null) }
    var code by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var recovery by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf("") }

    fun resetForm() {
        operation = null
        key = null
        code = ""
        password = ""
        recovery = false
        message = ""
    }

    fun run(work: suspend () -> Unit) {
        if (busy) return
        busy = true
        message = ""
        scope.launch {
            try {
                work()
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                val failure = error as? AnchorHttpFailure
                message = when {
                    failure?.code == "TWO_FACTOR_POLICY_REQUIRED" -> "Your server requires this authenticator."
                    failure?.code == "INVALID_PASSWORD" -> "The password was not accepted."
                    failure?.status == 400 -> "The code was not accepted. Try again."
                    failure?.status == 429 -> "Too many attempts. Try again later."
                    else -> "Could not complete the request. Try again."
                }
            } finally {
                busy = false
            }
        }
    }

    LaunchedEffect(session) { run { status = api.authenticatorStatus(session) } }

    val savedCodes = codes
    val setupKey = key
    val form = operation
    val current = status
    // Recovery codes must be acknowledged before leaving, as on the web.
    SystemBackHandler(savedCodes == null && !busy, onClose)
    StackedScreen(
        "Two-factor authentication", onClose, backLabel = "Back to notes", backEnabled = savedCodes == null && !busy,
    ) {
        if (message.isNotEmpty()) {
            AnchorBanner(message, Modifier.semantics { liveRegion = LiveRegionMode.Polite }, tone = BannerTone.Info)
        }
        val field = Modifier.fillMaxWidth()
        when {
            savedCodes != null -> {
                SheetTitle("Save your recovery codes", "Keep these codes somewhere safe. Each code can be used once.")
                CodeBox(savedCodes.joinToString("\n"))
                AnchorButton("I saved the codes", {
                    codes = null
                    resetForm()
                    run { status = api.authenticatorStatus(session) }
                }, field, enabled = !busy)
            }
            setupKey != null || form != null -> {
                if (setupKey != null) {
                    SheetTitle("Set up an authenticator", "Enter this setup key in your authenticator app.")
                    CodeBox(setupKey)
                } else {
                    SheetTitle(checkNotNull(form).label, null)
                    if (form != FactorOperation.Replace) {
                        AnchorField(
                            password, { password = it }, "Password", field, icon = AnchorIcons.Lock, enabled = !busy,
                            password = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                        )
                    }
                }
                AnchorField(
                    code, { input -> code = if (recovery) input.take(32) else input.filter { it in '0'..'9' }.take(6) },
                    if (recovery) "Recovery code" else "Authenticator code", field, icon = AnchorIcons.KeyRound,
                    enabled = !busy, password = true,
                    keyboardOptions = KeyboardOptions(
                        keyboardType = if (recovery) KeyboardType.Password else KeyboardType.NumberPassword,
                    ),
                )
                if (setupKey == null && form != FactorOperation.Rotate) {
                    AnchorButton(if (recovery) "Use an authenticator code" else "Use a recovery code", {
                        recovery = !recovery
                        code = ""
                    }, tone = ButtonTone.Ghost, small = true, enabled = !busy)
                }
                val hasCode = code.count { !it.isWhitespace() && it != '-' } == (if (recovery) 10 else 6)
                val needsPassword = setupKey == null && form != FactorOperation.Replace
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    AnchorButton("Cancel", { resetForm() }, Modifier.weight(1f), ButtonTone.Secondary, enabled = !busy)
                    AnchorButton(if (setupKey != null) "Verify code" else checkNotNull(form).submit, {
                        val submitted = code
                        val currentPassword = password
                        code = ""
                        password = ""
                        run {
                            when {
                                setupKey != null -> codes = api.enableAuthenticator(session, submitted)
                                form == FactorOperation.Replace -> {
                                    key = api.setupAuthenticator(session, submitted, recovery)
                                    recovery = false
                                }
                                form == FactorOperation.Rotate ->
                                    codes = api.regenerateRecoveryCodes(session, currentPassword, submitted)
                                else -> {
                                    api.disableAuthenticator(session, currentPassword, submitted, recovery)
                                    resetForm()
                                    status = api.authenticatorStatus(session)
                                }
                            }
                        }
                    }, Modifier.weight(1f), enabled = !busy && hasCode && (!needsPassword || password.isNotEmpty()))
                }
            }
            current == null -> AnchorButton(if (busy) "Loading…" else "Retry", {
                run { status = api.authenticatorStatus(session) }
            }, tone = ButtonTone.Secondary, small = true, enabled = !busy)
            else -> {
                SettingsGroup {
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Icon(
                            if (current.enabled) AnchorIcons.ShieldCheck else AnchorIcons.Lock, null, Modifier.size(20.dp),
                            tint = if (current.enabled) LocalAnchorTones.current.added else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Column {
                            Text(
                                if (current.enabled) "Authenticator is on" else "Authenticator is off",
                                style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold),
                            )
                            if (current.enabled) Text(
                                "Recovery codes remaining: ${current.remaining}",
                                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                    if (current.available && current.enabled) {
                        FactorOperation.entries
                            .filter { it != FactorOperation.Disable || current.policy != "everyone" }
                            .forEach { option ->
                                MenuDivider()
                                MenuRow(
                                    option.label, { operation = option }, enabled = !busy, chevron = true,
                                    danger = option == FactorOperation.Disable,
                                )
                            }
                    }
                }
                if (!current.available) {
                    Text("Authenticator setup is unavailable on this server.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                } else if (!current.enabled) {
                    AnchorButton("Set up authenticator", {
                        run { key = api.setupAuthenticator(session, null, recovery = false) }
                    }, field, icon = AnchorIcons.ShieldCheck, enabled = !busy)
                }
            }
        }
    }
}

/** Setup keys and recovery codes, selectable and in the code font. */
@Composable
private fun CodeBox(text: String) {
    SelectionContainer(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(MaterialTheme.colorScheme.surface).padding(16.dp),
    ) { Text(text, fontFamily = LocalAnchorCodeFont.current) }
}
