package anchor

import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import io.ktor.http.Url
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import androidx.compose.ui.graphics.Color
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.background

internal class NoteEditorControls(val dirty: Boolean, val openBackground: () -> Unit)

/**
 * One note on its own screen. Editable notes keep a buffer bound to the version they were opened with;
 * read-only notes show the same layout without the toolbar.
 */
@Composable
internal fun EditNote(
    note: CachedNote,
    editable: Boolean,
    status: SaveStatus?,
    sortChecklistItems: Boolean,
    onClose: () -> Unit,
    onSave: suspend (PendingNote) -> Unit,
    onMessage: (String) -> Unit,
    onDirtyChange: (Boolean) -> Unit = {},
    toast: Toast? = null,
    attach: (() -> Unit)? = null,
    actions: @Composable RowScope.(NoteEditorControls) -> Unit = {},
    details: @Composable ColumnScope.() -> Unit = {},
    footer: @Composable ColumnScope.() -> Unit = {},
) {
    val scope = rememberCoroutineScope()
    val original = remember(note) { EditableDelta.read(note.content) }
    val document = remember(note) { mutableStateOf(original) }
    var title by remember(note) { mutableStateOf(note.title) }
    var background by remember(note) { mutableStateOf(note.background) }
    var saved by remember(note) { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var discard by remember { mutableStateOf(false) }
    var picking by remember { mutableStateOf(false) }
    // Format may change even if the final text equals the original after several edits.
    val bodyChanged = document.value !== original && document.value != null
    val dirty = !saved && (title != note.title || bodyChanged || background != note.background)
    LaunchedEffect(dirty) { onDirtyChange(dirty) }
    val editor = rememberNoteEditorState(document)

    fun dismiss() {
        if (!busy) {
            if (dirty) discard = true else onClose()
        }
    }

    fun save() {
        busy = true
        scope.launch {
            try {
                onSave(PendingNote(
                    origin = note.origin, userId = note.userId, id = note.id, title = title,
                    content = "", baseVersion = note.version,
                    deltaContent = if (bodyChanged) document.value?.encode() else null,
                    backgroundChange = if (background != note.background) background.orEmpty() else null,
                ))
                saved = true
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                onMessage("Could not save changes on this device. Try again.")
            } finally {
                busy = false
            }
        }
    }

    val canType = editable && !saved && !busy
    NoteScreen(
        background = background,
        onBack = ::dismiss,
        status = {
            if (dirty && editable) SavePill("Save", "Save changes", enabled = !busy, onClick = ::save)
            else (if (busy) SaveStatus.Saving else status)?.let { SaveStatusLabel(it) }
        },
        actions = { actions(NoteEditorControls(dirty) { picking = true }) },
        toolbar = if (canType && document.value != null) {
            { NoteEditorToolbar(editor, true, background, sortChecklistItems, onMessage, attach) }
        } else null,
        toast = toast,
    ) {
        NoteTitleField(title, { title = it }, enabled = canType)
        details()
        NoteEditorBody(editor, canType, background, sortChecklistItems, onMessage, note.content)
        footer()
    }
    if (picking) NoteBackgroundSheet(background, onClose = { picking = false }) { background = it }
    if (discard) {
        ConfirmDialog(
            title = "Discard these changes?",
            text = "Your edits to this note haven’t been saved.",
            confirmLabel = "Discard changes",
            dismissLabel = "Keep editing",
            onConfirm = onClose,
            onDismiss = { discard = false },
        )
    }
}

/** A new note opens on the same screen; its text stays in memory until it is saved. */
@Composable
internal fun NewNote(
    title: MutableState<String>,
    document: MutableState<EditableDelta?>,
    background: MutableState<String?>,
    busy: Boolean,
    startInBody: Boolean?,
    sortChecklistItems: Boolean,
    onClose: () -> Unit,
    onSave: () -> Unit,
    onMessage: (String) -> Unit,
    attach: () -> Unit,
    toast: Toast? = null,
) {
    var picking by remember { mutableStateOf(false) }
    val titleFocus = remember { FocusRequester() }
    val bodyFocus = remember { FocusRequester() }
    val editor = rememberNoteEditorState(document, bodyFocus)
    var focused by remember { mutableStateOf(false) }
    LaunchedEffect(startInBody) {
        if (!focused && startInBody != null) {
            (if (startInBody) bodyFocus else titleFocus).requestFocus()
            focused = true
        }
    }
    val empty = title.value.isBlank() && document.value?.text?.isNotBlank() != true
    NoteScreen(
        background = background.value,
        onBack = onClose,
        status = { SavePill("Save", "Save note", enabled = !busy && !empty, onClick = onSave) },
        actions = {
            AnchorIconButton(AnchorIcons.Palette, "Background", { picking = true }, enabled = !busy)
        },
        toolbar = { NoteEditorToolbar(editor, !busy, background.value, sortChecklistItems, onMessage, attach) },
        toast = toast,
    ) {
        NoteTitleField(title.value, { title.value = it }, enabled = !busy, focusRequester = titleFocus)
        NoteEditorBody(editor, !busy, background.value, sortChecklistItems, onMessage)
    }
    if (picking) NoteBackgroundSheet(background.value, onClose = { picking = false }) { background.value = it }
}

private val bareLinkHost = Regex(
    "^(?:[A-Za-z0-9_](?:[A-Za-z0-9_\\-]*[A-Za-z0-9_])?(?:\\.[A-Za-z0-9_\\-]+)+|localhost)(?::[0-9]+)?(?:[/?#].*)?$",
    RegexOption.IGNORE_CASE,
)
private val networkLinkSchemes = setOf("http", "https", "ftp", "ftps")
private val addressLinkSchemes = setOf("mailto", "tel", "sms", "geo")
private val ipv4LinkHost = Regex("^(?:[0-9]{1,3}\\.){3}[0-9]{1,3}$")

internal fun normalizedNoteLink(raw: String): String? {
    val address = raw.trim()
    if (address.isEmpty() || address.any { it.isWhitespace() || it.isISOControl() || it == '\\' }) return null
    val host = address.substringBefore('/').substringBefore('?').substringBefore('#').substringBefore(':')
    val bareHost = bareLinkHost.matches(address) &&
        (host.any { it in 'a'..'z' || it in 'A'..'Z' } || ipv4LinkHost.matches(host))
    val normalized = if (bareHost) "https://$address" else address
    val protocol = normalized.substringBefore(':', "").lowercase()
    if (protocol in addressLinkSchemes)
        return normalized.takeIf { it.substringAfter(':').isNotEmpty() }
    if (protocol == "file") return normalized.takeIf { it.substringAfter(':').startsWith("///") && it.length > 8 }
    if (protocol !in networkLinkSchemes || !normalized.substringAfter(':').startsWith("//")) return null
    val authority = normalized.substringAfter("://").takeWhile { it !in "/?#" }
    if (authority.isEmpty() || '@' in authority) return null
    val parsed = runCatching { Url(normalized) }.getOrNull() ?: return null
    return normalized.takeIf { parsed.host.isNotBlank() && parsed.user == null && parsed.password == null }
}

@Composable
internal fun NoteLinkDialog(
    target: NoteLinkTarget,
    selectedText: String,
    onClose: () -> Unit,
    apply: (String, String?) -> Unit,
) {
    var label by remember(target) { mutableStateOf(selectedText) }
    var address by remember(target) { mutableStateOf(target.url.orEmpty()) }
    val normalized = remember(address) { normalizedNoteLink(address) }
    ConfirmDialog(
        title = if (target.url == null) "Link" else "Edit link",
        confirmLabel = if (target.url == null) "Add link" else "Save link",
        destructive = false,
        enabled = true,
        onConfirm = { if (normalized != null) apply(label.ifBlank { normalized }, normalized) },
        onDismiss = onClose,
    ) {
        if ('\n' !in selectedText) {
            AnchorField(label, { label = it.replace('\n', ' ') }, "Text to display")
        }
        AnchorField(
            address, { address = it }, "URL",
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
            error = if (address.isNotBlank() && normalized == null) "Enter a valid URL." else null,
        )
        if (target.url != null) {
            TextButton(onClick = { apply(selectedText, null) }) { Text("Remove link", color = MaterialTheme.colorScheme.error) }
        }
    }
}

@Composable
internal fun ReviewNoteEdit(draft: PendingNote?, onClose: () -> Unit, onDiscard: suspend () -> Unit) {
    val scope = rememberCoroutineScope()
    var confirm by remember { mutableStateOf(false) }
    var discarding by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }
    AnchorSheet(
        onDismiss = { if (!discarding) onClose() },
        title = if (draft == null) "Draft unavailable" else "Draft needs review",
        subtitle = if (draft == null) "The draft is still on this device. Its contents are hidden while the note is unavailable."
            else "The server could not apply this change. You can copy your draft here.",
    ) {
        if (draft != null) {
            val palette = notePalette(draft.backgroundChange?.ifEmpty { null })
            SelectionContainer(
                Modifier.fillMaxWidth().clip(MaterialTheme.shapes.large)
                    .background(palette?.let { Color(if (LocalAnchorDarkTheme.current) it.darkFill else it.lightFill) }
                        ?: MaterialTheme.colorScheme.surfaceContainer)
                    .padding(14.dp),
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    val noteType = LocalNoteTypography.current
                    Text(draft.title.ifBlank { "Untitled note" }, style = noteType.style(MaterialTheme.typography.titleMedium))
                    val body = draft.deltaContent
                    if (body != null) {
                        val type = MaterialTheme.typography
                        val codeFont = LocalAnchorCodeFont.current
                        val highlights = rememberNoteHighlights()
                        val preview = remember(body, type, noteType, codeFont, highlights) {
                            notePreviewText(body, noteType.headings(type, scaled = true), codeFont, highlights)
                        }
                        Text(preview, style = noteType.style(type.bodyLarge, scaled = true))
                    }
                    draft.backgroundChange?.let {
                        Text(
                            "Background: ${noteBackgroundNames[it.ifEmpty { null }] ?: it}",
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }
        if (failed) AnchorBanner("Could not discard the draft. Try again.", tone = BannerTone.Error)
        Row(Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            AnchorButton("Discard draft", { confirm = true }, Modifier.weight(1f), ButtonTone.Secondary, !discarding)
            AnchorButton("Close draft", onClose, Modifier.weight(1f), ButtonTone.Primary, !discarding)
        }
    }
    if (confirm) {
        ConfirmDialog(
            title = "Discard this local draft?",
            text = "Your changes on this device will be lost.",
            confirmLabel = "Discard draft",
            dismissLabel = "Keep draft",
            enabled = !discarding,
            onDismiss = { confirm = false },
            onConfirm = {
                discarding = true
                scope.launch {
                    try {
                        onDiscard()
                    } catch (error: CancellationException) {
                        throw error
                    } catch (_: Exception) {
                        failed = true
                        confirm = false
                    } finally {
                        discarding = false
                    }
                }
            },
        )
    }
}
