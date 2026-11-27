package anchor

import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.LocalTextSelectionColors
import androidx.compose.foundation.text.selection.TextSelectionColors
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.OffsetMapping
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.input.TransformedText
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.withTimeoutOrNull
import androidx.compose.foundation.text.selection.SelectionContainer

internal enum class SaveStatus(val label: String) {
    Saved("Saved"), Saving("Saving…"), OnDevice("Saved on device"), Failed("Couldn’t save"),
}

/**
 * Full-screen note surface: the note colour fills the screen like the web editor.
 * The header holds back, the save status and the note actions; a floating toolbar sits at the bottom.
 */
@Composable
internal fun NoteScreen(
    background: String?,
    onBack: () -> Unit,
    status: @Composable RowScope.() -> Unit,
    actions: @Composable RowScope.() -> Unit,
    toolbar: (@Composable () -> Unit)? = null,
    toast: Toast? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    Dialog(
        onDismissRequest = onBack,
        properties = DialogProperties(usePlatformDefaultWidth = false, dismissOnClickOutside = false),
    ) {
        val dark = LocalAnchorDarkTheme.current
        val palette = notePalette(background)
        val fill = palette?.let { Color(if (dark) it.darkFill else it.lightFill) } ?: MaterialTheme.colorScheme.background
        Surface(Modifier.fillMaxSize(), color = fill) {
          Box(Modifier.fillMaxSize().notePattern(palette?.pattern, dark).safeDrawingPadding().imePadding()) {
            Column(Modifier.fillMaxSize()) {
                Row(
                    Modifier.fillMaxWidth().height(56.dp).padding(horizontal = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    AnchorIconButton(AnchorIcons.ArrowLeft, "Back to notes", onBack)
                    Row(
                        Modifier.weight(1f).padding(start = 2.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        content = status,
                    )
                    actions()
                }
                Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.TopCenter) {
                    Column(
                        Modifier.widthIn(max = 720.dp).fillMaxWidth().verticalScroll(rememberScrollState())
                            .padding(start = 20.dp, end = 20.dp, top = 6.dp, bottom = if (toolbar != null) 88.dp else 32.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                        content = content,
                    )
                    if (toolbar != null) Box(
                        Modifier.align(Alignment.BottomCenter).widthIn(max = 720.dp).fillMaxWidth()
                            .padding(horizontal = 12.dp, vertical = 12.dp),
                    ) { toolbar() }
                }
            }
            if (toast != null) AnchorToast(
                toast.text,
                Modifier.align(Alignment.BottomCenter).padding(start = 16.dp, end = 16.dp, bottom = if (toolbar != null) 76.dp else 16.dp),
                toast.actionLabel, toast.onAction,
            )
          }
        }
    }
}

internal class Toast(val text: String, val actionLabel: String? = null, val onAction: () -> Unit = {})

@Composable
internal fun SaveStatusLabel(status: SaveStatus) {
    val colors = MaterialTheme.colorScheme
    val ink = if (status == SaveStatus.Failed) colors.error else colors.onSurfaceVariant
    Row(
        Modifier.semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Icon(
            when (status) {
                SaveStatus.Saved -> AnchorIcons.Check
                SaveStatus.Saving -> AnchorIcons.LoaderCircle
                SaveStatus.OnDevice -> AnchorIcons.CloudOff
                SaveStatus.Failed -> AnchorIcons.TriangleAlert
            },
            null, Modifier.size(14.dp), tint = ink,
        )
        Text(status.label, style = MaterialTheme.typography.labelMedium.copy(fontSize = 12.5.sp), color = ink, maxLines = 1)
    }
}

/** The pill the header shows while a note has unsaved changes. */
@Composable
internal fun SavePill(label: String, description: String, enabled: Boolean, onClick: () -> Unit) {
    // The pill shows a short word; screen readers hear what it saves.
    AnchorButton(
        label, onClick, Modifier.semantics { contentDescription = description },
        tone = ButtonTone.Primary, enabled = enabled, small = true,
    )
}

internal val noteTitleStyle = TextStyle(fontSize = 27.sp, lineHeight = 30.sp, letterSpacing = (-0.76).sp, fontWeight = FontWeight.Bold)

@Composable
internal fun NoteTitleField(
    value: String,
    onValueChange: (String) -> Unit,
    enabled: Boolean,
    focusRequester: FocusRequester? = null,
) {
    val colors = MaterialTheme.colorScheme
    val style = LocalNoteTypography.current.style(noteTitleStyle, scaled = true).copy(color = colors.onSurface)
    CompositionLocalProvider(LocalTextSelectionColors provides noteSelectionColors()) {
        BasicTextField(
            value, onValueChange,
            Modifier.fillMaxWidth().padding(bottom = 4.dp).semantics { contentDescription = "Title" }
                .then(if (focusRequester != null) Modifier.focusRequester(focusRequester) else Modifier),
            // Read-only text stays selectable so it can be copied.
            readOnly = !enabled,
            singleLine = true,
            textStyle = style,
            cursorBrush = SolidColor(colors.tertiary),
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
            decorationBox = { inner ->
                Box {
                    if (value.isEmpty()) Text("Title", style = style.copy(color = colors.onSurfaceVariant.copy(alpha = 0.6f)))
                    inner()
                }
            },
        )
    }
}

@Composable
private fun noteSelectionColors() = TextSelectionColors(
    handleColor = MaterialTheme.colorScheme.tertiary,
    backgroundColor = MaterialTheme.colorScheme.tertiary.copy(alpha = 0.3f),
)

/** Small rounded chip under the note title or on a card (tags, reminder). */
@Composable
internal fun NoteChip(text: String, icon: ImageVector? = null, color: Color = Color.Unspecified) {
    val ink = if (color == Color.Unspecified) MaterialTheme.colorScheme.onSurface else color
    Row(
        Modifier.height(22.dp).clip(CircleShape).background(ink.copy(alpha = 0.08f)).padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        if (icon != null) Icon(icon, null, Modifier.size(12.dp), tint = ink)
        Text(text, style = MaterialTheme.typography.labelSmall.copy(fontSize = 11.5.sp, fontWeight = FontWeight.Medium), color = ink, maxLines = 1)
    }
}

internal class EditorUndo(
    val before: EditableDelta,
    val after: EditableDelta,
    val field: TextFieldValue,
    val label: String,
)

/** Editing state shared by the note body and the floating format toolbar. */
internal class NoteEditorState(documentState: MutableState<EditableDelta?>, val bodyFocus: FocusRequester) {
    var document by documentState
    var field by mutableStateOf(TextFieldValue(document?.text.orEmpty()))
    var typingFormats by mutableStateOf(emptyMap<InlineFormat, Boolean>())
    var editorUndo by mutableStateOf<EditorUndo?>(null)
    var linkTarget by mutableStateOf<NoteLinkTarget?>(null)
    var blockMenuOpen by mutableStateOf(false)
    var highlightMenuOpen by mutableStateOf(false)
    var checklistMenuOpen by mutableStateOf(false)

    fun applyChecklist(change: (EditableDelta) -> EditableDelta) {
        checklistMenuOpen = false
        val previous = document ?: return
        val next = change(previous)
        if (next === previous) return
        editorUndo = EditorUndo(previous, next, field, "Undo checklist change")
        document = next
        if (field.text != next.text) {
            field = TextFieldValue(next.text, TextRange(field.selection.end.coerceAtMost(next.text.length)))
        }
        typingFormats = emptyMap()
    }

    fun toggleChecklist(target: TextRange, checked: Boolean, sortChecklistItems: Boolean) {
        val source = document ?: return
        val format = if (checked) BlockFormat.Checklist else BlockFormat.Checked
        val (next, focus) = source.toggleChecklist(target, format, sortChecklistItems)
        if (next === source) return
        editorUndo = EditorUndo(source, next, field, "Undo checklist change")
        document = next
        field = TextFieldValue(next.text, focus)
        typingFormats = emptyMap()
    }

    fun applyFormatting(change: (EditableDelta) -> EditableDelta) {
        val source = document ?: return
        val next = change(source)
        if (next !== source) {
            editorUndo = EditorUndo(source, next, field, "Undo formatting change")
            document = next
            typingFormats = emptyMap()
        }
        bodyFocus.requestFocus()
    }
}

@Composable
internal fun rememberNoteEditorState(documentState: MutableState<EditableDelta?>, focusRequester: FocusRequester? = null) =
    remember(documentState, focusRequester) { NoteEditorState(documentState, focusRequester ?: FocusRequester()) }

private val blockIcons = mapOf(
    BlockFormat.Paragraph to AnchorIcons.Pilcrow,
    BlockFormat.Heading1 to AnchorIcons.Heading1,
    BlockFormat.Heading2 to AnchorIcons.Heading2,
    BlockFormat.Heading3 to AnchorIcons.Heading3,
    BlockFormat.Bullet to AnchorIcons.List,
    BlockFormat.Numbered to AnchorIcons.ListOrdered,
    BlockFormat.Checklist to AnchorIcons.ListChecks,
    BlockFormat.Quote to AnchorIcons.Quote,
    BlockFormat.Code to AnchorIcons.Code,
)

private val inlineIcons = mapOf(
    InlineFormat.Bold to AnchorIcons.Bold,
    InlineFormat.Italic to AnchorIcons.Italic,
    InlineFormat.Underline to AnchorIcons.Underline,
    InlineFormat.Strike to AnchorIcons.Strikethrough,
    InlineFormat.Code to AnchorIcons.Code,
)

@Composable
private fun ToolButton(
    icon: ImageVector,
    label: String,
    onClick: () -> Unit,
    enabled: Boolean,
    checked: Boolean? = null,
    state: String? = null,
) {
    val colors = MaterialTheme.colorScheme
    IconButton(
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier.size(40.dp).semantics {
            contentDescription = label
            if (checked != null) selected = checked
            if (state != null) stateDescription = state
        },
        shape = RoundedCornerShape(8.dp),
        colors = IconButtonDefaults.iconButtonColors(
            containerColor = if (checked == true) colors.tertiary.copy(alpha = 0.14f) else Color.Transparent,
            contentColor = if (checked == true) colors.tertiary else colors.onSurface,
        ),
    ) { Icon(icon, null, Modifier.size(18.dp)) }
}

/** The floating format toolbar (frames F20–F25). */
@Composable
internal fun NoteEditorToolbar(
    state: NoteEditorState,
    enabled: Boolean,
    background: String?,
    sortChecklistItems: Boolean,
    onMessage: (String) -> Unit,
    attach: (() -> Unit)? = null,
) {
    val current = state.document ?: return
    val colors = MaterialTheme.colorScheme
    val selection = state.field.selection
    val activeBlocks = current.blocksIn(selection.min, selection.max)
    val blockFormat = activeBlocks.map { it.format }.distinct().singleOrNull()
    Surface(
        Modifier.fillMaxWidth().shadow(12.dp, RoundedCornerShape(14.dp)),
        shape = RoundedCornerShape(14.dp),
        color = colors.surface,
    ) {
        // Undo sits outside the scrolling tools so it never appears off-screen.
        Row(Modifier.padding(horizontal = 4.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Row(
                Modifier.weight(1f, fill = false).horizontalScroll(rememberScrollState()),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                for (format in InlineFormat.entries) {
                    val active = current.hasFormat(format, selection.min, selection.max)
                    val checked = if (selection.collapsed) state.typingFormats[format] ?: active else active
                    ToolButton(checkNotNull(inlineIcons[format]), format.label, enabled = enabled, checked = checked, onClick = {
                        val target = state.document ?: return@ToolButton
                        if (selection.collapsed) {
                            state.typingFormats = state.typingFormats + (format to !checked)
                        } else {
                            state.document = target.format(format, selection.min, selection.max, !checked)
                        }
                        state.bodyFocus.requestFocus()
                    })
                }
                ToolButton(AnchorIcons.Link, "Link", enabled = enabled, onClick = {
                    val target = state.document?.linkTarget(selection.min, selection.max)
                    if (target == null) onMessage("Select text without embedded items to add a link.")
                    else state.linkTarget = target
                })
                ToolButton(
                    AnchorIcons.Heading, "Block format", enabled = enabled,
                    state = blockFormat?.label ?: "Mixed blocks", onClick = { state.blockMenuOpen = true },
                )
                if (!selection.collapsed) {
                    ToolButton(AnchorIcons.Highlighter, "Highlight", enabled = enabled, onClick = { state.highlightMenuOpen = true })
                    ToolButton(AnchorIcons.Eraser, "Clear formatting", enabled = enabled, onClick = {
                        state.applyFormatting { it.clearFormatting(selection.min, selection.max) }
                    })
                }
                if (current.blocks.any { it.isChecklist }) {
                    ToolButton(AnchorIcons.SquareCheck, "Checklist actions", enabled = enabled, onClick = { state.checklistMenuOpen = true })
                }
                if (attach != null) ToolButton(AnchorIcons.Paperclip, "Add to note", enabled = enabled, onClick = attach)
            }
            val undo = state.editorUndo
            if (undo != null && undo.after === current) {
                ToolButton(AnchorIcons.Undo2, undo.label, enabled = enabled, onClick = {
                    state.document = undo.before
                    state.field = undo.field
                    state.typingFormats = emptyMap()
                    state.editorUndo = null
                })
            }
        }
    }

    if (state.blockMenuOpen) {
        val close: () -> Unit = {
            state.blockMenuOpen = false
            state.bodyFocus.requestFocus()
        }
        AnchorSheet(onDismiss = close, title = "Text style") {
            val choices = BlockFormat.entries.filterNot { it == BlockFormat.Checked }
            val shown = if (blockFormat == BlockFormat.Checked) BlockFormat.Checklist else blockFormat
            if (shown == null) Text(
                "Mixed blocks", Modifier.padding(bottom = 4.dp),
                style = MaterialTheme.typography.bodyMedium, color = colors.onSurfaceVariant,
            )
            for (format in choices) {
                MenuRow(
                    format.label, icon = blockIcons[format], selected = format == shown, role = Role.RadioButton,
                    onClick = {
                        state.document = state.document?.applyBlock(selection.min, selection.max, format)
                        close()
                    },
                )
            }
            val list = activeBlocks.any { it.isList }
            val checklist = blockFormat == BlockFormat.Checklist || blockFormat == BlockFormat.Checked
            if (list || checklist) FlowRow(
                Modifier.padding(top = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (list) {
                    val outdent = current.listIndentChanges(selection.min, selection.max, -1)
                    val indent = current.listIndentChanges(selection.min, selection.max, 1)
                    AnchorButton("Outdent list", {
                        state.document = state.document?.writeBlockAttributes(outdent)
                        close()
                    }, tone = ButtonTone.Secondary, enabled = outdent.isNotEmpty(), small = true)
                    AnchorButton("Indent list", {
                        state.document = state.document?.writeBlockAttributes(indent)
                        close()
                    }, tone = ButtonTone.Secondary, enabled = indent.isNotEmpty(), small = true)
                }
                if (checklist) {
                    val checked = blockFormat == BlockFormat.Checked
                    AnchorButton(if (checked) "Mark unchecked" else "Mark checked", {
                        state.toggleChecklist(selection, checked, sortChecklistItems)
                        close()
                    }, tone = ButtonTone.Secondary, small = true)
                }
            }
        }
    }

    if (state.highlightMenuOpen) {
        val highlights = rememberNoteHighlights(background)
        fun pick(name: String?) {
            state.highlightMenuOpen = false
            state.applyFormatting { it.setHighlight(selection.min, selection.max, name) }
        }
        AnchorSheet(onDismiss = { state.highlightMenuOpen = false }, title = "Highlight") {
            Row(
                Modifier.fillMaxWidth().padding(vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                for ((name, paint) in highlights) {
                    val label = name.replaceFirstChar { it.uppercaseChar() }
                    Box(
                        Modifier.size(40.dp).clip(CircleShape).background(paint.background)
                            .border(1.dp, colors.outline, CircleShape)
                            .clickable(role = Role.Button, onClickLabel = label) { pick(name) }
                            .semantics { contentDescription = label },
                    )
                }
                Box(Modifier.weight(1f))
                TextButton(onClick = { pick(null) }) { Text("Remove highlight", color = colors.error) }
            }
        }
    }

    if (state.checklistMenuOpen) {
        val hasChecked = current.blocks.any { it.isChecked }
        AnchorSheet(onDismiss = { state.checklistMenuOpen = false }, title = "Checklist") {
            MenuRow("Uncheck all", icon = AnchorIcons.RotateCcw, enabled = hasChecked,
                onClick = { state.applyChecklist(EditableDelta::uncheckAll) })
            MenuRow("Delete checked items", icon = AnchorIcons.Trash2, danger = true, enabled = hasChecked,
                onClick = { state.applyChecklist(EditableDelta::deleteCheckedItems) })
            if (!hasChecked) Text(
                "Both are unavailable when nothing is checked.",
                style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant,
            )
        }
    }

    val target = state.linkTarget
    if (target != null) {
        fun closeLinkDialog() {
            state.linkTarget = null
            state.bodyFocus.requestFocus()
        }
        NoteLinkDialog(
            target = target,
            selectedText = current.text.substring(target.start, target.end),
            onClose = ::closeLinkDialog,
            apply = { label, url ->
                val source = state.document ?: return@NoteLinkDialog
                val next = source.text.replaceRange(target.start, target.end, label)
                val changed = source.changeTo(next, state.typingFormats, TextRange(target.start, target.end))
                    ?: return@NoteLinkDialog
                val end = target.start + label.length
                state.document = changed.setLink(target.start, end, url)
                state.field = TextFieldValue(next, TextRange(end))
                state.typingFormats = emptyMap()
                closeLinkDialog()
            },
        )
    }
}

/** The editable note body on the note's own colour. */
@Composable
internal fun NoteEditorBody(
    state: NoteEditorState,
    enabled: Boolean,
    background: String?,
    sortChecklistItems: Boolean,
    onMessage: (String) -> Unit,
    content: String? = null,
) {
    val current = state.document
    if (current == null) {
        AnchorBanner("This note body uses a format Compose cannot edit. You can still change its title.")
        val type = MaterialTheme.typography
        val noteType = LocalNoteTypography.current
        val codeFont = LocalAnchorCodeFont.current
        val highlights = rememberNoteHighlights(background)
        val preview = remember(content, type, noteType, codeFont, highlights) {
            notePreviewText(content, noteType.headings(type, scaled = true), codeFont, highlights)
        }
        if (preview.isNotBlank()) SelectionContainer {
            Text(preview, Modifier.padding(top = 12.dp), style = noteType.style(type.bodyLarge, scaled = true))
        }
        return
    }
    val highlights = rememberNoteHighlights(background)
    val type = MaterialTheme.typography
    val noteType = LocalNoteTypography.current
    val codeFont = LocalAnchorCodeFont.current
    val formatted = remember(current, type, noteType, codeFont, highlights) {
        current.editorText(noteType.headings(type, scaled = true), codeFont, highlights)
    }
    val transformation = VisualTransformation { text ->
        if (text.text == current.text) formatted else TransformedText(text, OffsetMapping.Identity)
    }
    fun checkboxAt(layout: TextLayoutResult, touch: Offset): DeltaBlock? {
        if (state.document !== current || layout.layoutInput.text.text != formatted.text.text) return null
        val offset = formatted.offsetMapping.transformedToOriginal(layout.getOffsetForPosition(touch))
        val index = current.blocks.binarySearchBy(offset) { it.start }
        val block = current.blocks.getOrNull(index)?.takeIf { it.isChecklist } ?: return null
        // The glyph and its following space are the last two characters of the prefix.
        val marker = formatted.offsetMapping.originalToTransformed(block.start) - 2
        return block.takeIf { layout.getBoundingBox(marker).contains(touch) }
    }
    val hitTest by rememberUpdatedState(::checkboxAt)
    val onCheckboxTap by rememberUpdatedState<(DeltaBlock) -> Unit>({ block ->
        state.toggleChecklist(TextRange(block.start), block.isChecked, sortChecklistItems)
    })
    var layout by remember { mutableStateOf<TextLayoutResult?>(null) }
    val interaction = remember { MutableInteractionSource() }
    val colors = MaterialTheme.colorScheme
    val bodyStyle = noteType.style(type.bodyLarge, scaled = true)
        .copy(color = colors.onSurface)
    CompositionLocalProvider(LocalTextSelectionColors provides noteSelectionColors()) {
        BasicTextField(
            value = state.field,
            onValueChange = { input ->
                val source = state.document ?: return@BasicTextField
                if (input.text == state.field.text && input.selection != state.field.selection) {
                    state.typingFormats = emptyMap()
                }
                val updated = source.changeTo(input.text, state.typingFormats, state.field.selection)
                if (updated == null) {
                    onMessage("Edit the text around embedded items to keep those items intact.")
                } else {
                    if (input.text.count { it == '\n' } > state.field.text.count { it == '\n' }) {
                        state.typingFormats = emptyMap()
                    }
                    state.document = updated
                    state.field = input
                }
            },
            modifier = Modifier.fillMaxWidth().heightIn(min = 160.dp).focusRequester(state.bodyFocus)
                .semantics { contentDescription = "Note" },
            readOnly = !enabled,
            textStyle = bodyStyle,
            cursorBrush = SolidColor(colors.tertiary),
            interactionSource = interaction,
            visualTransformation = transformation,
            onTextLayout = { layout = it },
            decorationBox = { innerTextField ->
                // The screen scrolls, keeping touches in the text layout's coordinates.
                Box(Modifier.pointerInput(enabled) {
                    if (!enabled) return@pointerInput
                    awaitEachGesture {
                        val down = awaitFirstDown(pass = PointerEventPass.Initial)
                        val target = layout?.let { hitTest(it, down.position) } ?: return@awaitEachGesture
                        down.consume()
                        val up = withTimeoutOrNull(viewConfiguration.longPressTimeoutMillis) {
                            waitForUpOrCancellation(pass = PointerEventPass.Initial)
                        }
                        if (up != null && layout?.let { hitTest(it, up.position) } == target) {
                            up.consume()
                            onCheckboxTap(target)
                        }
                    }
                }) {
                    if (state.field.text.isEmpty()) Text("Note", style = bodyStyle.copy(color = colors.onSurfaceVariant.copy(alpha = 0.6f)))
                    innerTextField()
                }
            },
        )
    }
}
