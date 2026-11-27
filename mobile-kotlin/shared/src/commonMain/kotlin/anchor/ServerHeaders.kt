package anchor

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.border
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

internal const val maxServerHeaders = 10
private val fieldName = Regex("""[A-Za-z0-9!#$%&'*+.^_`|~-]+""")
private val reserved = setOf(
    "accept", "accept-encoding", "authorization", "connection", "content-length", "content-type",
    "expect", "host", "keep-alive", "proxy-authorization", "proxy-connection", "range",
    "te", "trailer", "transfer-encoding", "upgrade",
)

internal data class ServerHeader(val name: String = "", val value: String = "")

internal fun validateServerHeaders(headers: List<ServerHeader>): Map<String, String> {
    require(headers.size <= maxServerHeaders) { "Use at most ten headers." }
    val names = mutableSetOf<String>()
    return buildMap {
        for ((rawName, value) in headers) {
            val name = rawName.trim(' ', '\t')
            if (name.isEmpty() && value.isEmpty()) continue
            require(name.length <= 128 && fieldName.matches(name)) { "Enter a valid header name." }
            val key = name.lowercase()
            require(key !in reserved && !key.startsWith("x-anchor-")) { "This header name is reserved." }
            require(names.add(key)) { "Use each header name once." }
            require(value.length <= 4096 && value.all { it == '\t' || it in ' '..'~' }) { "Enter a valid header value." }
            put(name, value.trim(' ', '\t'))
        }
    }
}

/** Full-height page for the headers sent to one server origin (frame F62). */
@Composable
internal fun ServerHeadersDialog(
    server: String,
    headers: Map<String, String>,
    onClose: () -> Unit,
    onSave: suspend (Map<String, String>) -> Unit,
) {
    val rows = remember(server) {
        mutableStateListOf<ServerHeader>().apply {
            addAll(headers.map { (name, value) -> ServerHeader(name, value) }.ifEmpty { listOf(ServerHeader()) })
        }
    }
    var saving by remember { mutableStateOf(false) }
    // The row the message belongs to; null for a failed save.
    var error by remember { mutableStateOf<Pair<Int?, String>?>(null) }
    val scope = rememberCoroutineScope()
    val colors = MaterialTheme.colorScheme
    fun save() {
        val validated = try {
            validateServerHeaders(rows.toList())
        } catch (invalid: IllegalArgumentException) {
            // Each check concerns one row or a clash with an earlier one, so the first failing prefix names the row.
            val row = rows.indices.firstOrNull { runCatching { validateServerHeaders(rows.take(it + 1)) }.isFailure }
            error = row to (invalid.message ?: "Enter a valid header.")
            return
        }
        saving = true
        error = null
        scope.launch {
            try {
                onSave(validated)
                onClose()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                error = null to "Could not save the server headers."
            } finally {
                saving = false
            }
        }
    }
    Dialog(
        onDismissRequest = { if (!saving) onClose() },
        properties = DialogProperties(usePlatformDefaultWidth = false, dismissOnClickOutside = false),
    ) {
        Surface(Modifier.fillMaxSize(), color = colors.background) {
            Column(Modifier.fillMaxSize().safeDrawingPadding().imePadding()) {
                AnchorTopBar(
                    "Server headers",
                    navigation = { AnchorIconButton(AnchorIcons.ArrowLeft, "Back", { if (!saving) onClose() }, enabled = !saving) },
                    compactTitle = true,
                )
                Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.TopCenter) {
                    Column(
                        Modifier.widthIn(max = 640.dp).fillMaxWidth().verticalScroll(rememberScrollState())
                            .padding(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 16.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Text(
                            "Sent with every request to $server.",
                            style = MaterialTheme.typography.bodyMedium.copy(fontSize = 14.sp), color = colors.onSurfaceVariant,
                        )
                        if (rows.isNotEmpty()) Column(
                            Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(colors.surface)
                                .border(1.dp, colors.outlineVariant, RoundedCornerShape(16.dp)),
                        ) {
                            rows.forEachIndexed { index, row ->
                                if (index > 0) Box(Modifier.fillMaxWidth().height(1.dp).background(LocalAnchorTones.current.divider))
                                val rowError = error?.takeIf { it.first == index }?.second
                                Column(
                                    Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 8.dp),
                                    verticalArrangement = Arrangement.spacedBy(8.dp),
                                ) {
                                    HeaderField(row.name, { rows[index] = row.copy(name = it) }, "Header name", !saving, rowError != null)
                                    HeaderField(
                                        row.value, { rows[index] = row.copy(value = it) }, "Header value", !saving, false,
                                        secret = true,
                                    )
                                    if (rowError != null) Row(
                                        Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                                        verticalAlignment = Alignment.CenterVertically,
                                    ) {
                                        Icon(AnchorIcons.TriangleAlert, null, Modifier.size(14.dp), tint = colors.error)
                                        Text(rowError, style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.5.sp), color = colors.error)
                                    }
                                    TextButton(
                                        enabled = !saving, contentPadding = PaddingValues(horizontal = 0.dp),
                                        onClick = {
                                            rows.removeAt(index)
                                            error = null
                                        },
                                    ) { Text("Remove header", color = colors.error) }
                                }
                            }
                        }
                        AnchorButton(
                            "Add header", { rows.add(ServerHeader()) }, Modifier.fillMaxWidth(), ButtonTone.Secondary,
                            enabled = !saving && rows.size < maxServerHeaders, icon = AnchorIcons.Plus,
                        )
                        Text(
                            "Up to $maxServerHeaders headers.",
                            style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.5.sp), color = colors.onSurfaceVariant,
                        )
                        error?.takeIf { it.first == null }?.let { AnchorBanner(it.second, tone = BannerTone.Error) }
                    }
                }
                Row(
                    Modifier.widthIn(max = 640.dp).fillMaxWidth().align(Alignment.CenterHorizontally)
                        .padding(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 12.dp),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    AnchorButton("Cancel", onClose, Modifier.weight(1f), ButtonTone.Secondary, !saving)
                    AnchorButton("Save headers", ::save, Modifier.weight(1f), enabled = !saving)
                }
            }
        }
    }
}

/** A header text field without a visible label (frame F62); the label is its accessible name. */
@Composable
private fun HeaderField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    enabled: Boolean,
    error: Boolean,
    secret: Boolean = false,
) {
    val colors = MaterialTheme.colorScheme
    OutlinedTextField(
        value, onValueChange, Modifier.fillMaxWidth().semantics { contentDescription = label },
        enabled = enabled, singleLine = true, isError = error,
        placeholder = { Text(label) },
        visualTransformation = if (secret) PasswordVisualTransformation() else VisualTransformation.None,
        keyboardOptions = if (secret) KeyboardOptions(keyboardType = KeyboardType.Password) else KeyboardOptions.Default,
        shape = ControlShape,
        colors = OutlinedTextFieldDefaults.colors(
            focusedBorderColor = colors.tertiary,
            unfocusedBorderColor = colors.outline,
            focusedContainerColor = colors.surface,
            unfocusedContainerColor = colors.surface,
            disabledContainerColor = colors.surface,
            cursorColor = colors.tertiary,
        ),
    )
}
