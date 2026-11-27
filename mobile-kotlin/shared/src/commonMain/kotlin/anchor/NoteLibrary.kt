package anchor

import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlin.time.Instant
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.io.buffered
import kotlinx.io.files.Path
import kotlinx.io.files.SystemFileSystem
import kotlinx.io.readString
import kotlinx.io.writeString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.material3.Icon
import androidx.compose.foundation.background
import androidx.compose.foundation.border

internal enum class NoteLayout { List, Grid, Masonry }

internal enum class SelectionRemoval(val title: String, val button: String) {
    Trash("Move selected notes to trash?", "Move to trash"),
    Permanent("Delete selected notes permanently?", "Delete permanently"),
    EmptyTrash("Empty trash?", "Delete permanently"),
}

internal data class PendingSelectionRemoval(val action: SelectionRemoval, val notes: List<CachedNote>)

internal enum class NoteSort(val label: String) {
    EditedNewest("Last edited, newest first"),
    EditedOldest("Last edited, oldest first"),
    CreatedNewest("Date created, newest first"),
    CreatedOldest("Date created, oldest first"),
    TitleAscending("Title, A to Z"),
    TitleDescending("Title, Z to A"),
    Custom("Custom order"),
}

internal data class NoteLibraryPreferences(
    val layout: NoteLayout = NoteLayout.List,
    val sort: NoteSort = NoteSort.EditedNewest,
    val theme: AnchorAppearance = AnchorAppearance.System,
    val showCardPictures: Boolean = true,
    val startNewNotesInBody: Boolean = false,
    val noteFont: NoteFont = NoteFont.Sans,
    val noteTextSize: NoteTextSize = NoteTextSize.Default,
    val sortChecklistItems: Boolean = true,
    val density: AnchorDensity = AnchorDensity.Standard,
)

internal fun readNoteLibraryPreferences(path: Path, legacyShareFolder: Path? = null): NoteLibraryPreferences {
    val parts = runCatching { SystemFileSystem.source(path).buffered().use { it.readString() }.lineSequence().take(9).toList() }
        .getOrDefault(emptyList())
    val theme = AnchorAppearance.entries.firstOrNull { it.name == parts.getOrNull(2) }
    val density = AnchorDensity.entries.firstOrNull { it.name == parts.getOrNull(8) }
    val legacyContext = if (theme == null || density == null) readLegacyShareContext(legacyShareFolder) else null
    return NoteLibraryPreferences(
        layout = NoteLayout.entries.firstOrNull { it.name == parts.getOrNull(0) } ?: NoteLayout.List,
        sort = NoteSort.entries.firstOrNull { it.name == parts.getOrNull(1) } ?: NoteSort.EditedNewest,
        theme = theme ?: AnchorAppearance.entries.firstOrNull { JsonPrimitive(it.name.lowercase()) == legacyContext?.get("theme") }
            ?: AnchorAppearance.System,
        showCardPictures = parts.getOrNull(3)?.toBooleanStrictOrNull() ?: true,
        startNewNotesInBody = parts.getOrNull(4)?.toBooleanStrictOrNull() ?: false,
        noteFont = NoteFont.entries.firstOrNull { it.name == parts.getOrNull(5) } ?: NoteFont.Sans,
        noteTextSize = NoteTextSize.entries.firstOrNull { it.name == parts.getOrNull(6) } ?: NoteTextSize.Default,
        sortChecklistItems = parts.getOrNull(7)?.toBooleanStrictOrNull() ?: true,
        density = density ?: AnchorDensity.entries.firstOrNull { JsonPrimitive(it.name.lowercase()) == legacyContext?.get("density") }
            ?: AnchorDensity.Standard,
    )
}

private fun readLegacyShareContext(folder: Path?): JsonObject? = runCatching {
    val fs = SystemFileSystem
    val path = Path(fs.resolve(folder ?: return null), "context.json")
    val file = fs.metadataOrNull(path) ?: return null
    if (!file.isRegularFile || file.size !in 1L..1024L * 1024 || fs.resolve(path) != path) return null
    fs.source(path).buffered().use { Json.parseToJsonElement(it.readString()).jsonObject }
}.getOrNull()

internal fun saveNoteLibraryPreferences(path: Path, preferences: NoteLibraryPreferences) {
    val temporary = Path(checkNotNull(path.parent), "note-layout.tmp")
    SystemFileSystem.sink(temporary).buffered().use {
        it.writeString(
            "${preferences.layout.name}\n${preferences.sort.name}\n${preferences.theme.name}\n" +
                "${preferences.showCardPictures}\n${preferences.startNewNotesInBody}\n" +
                "${preferences.noteFont.name}\n${preferences.noteTextSize.name}\n" +
                "${preferences.sortChecklistItems}\n${preferences.density.name}",
        )
    }
    SystemFileSystem.atomicMove(temporary, path)
}

internal fun sortLibraryNotes(notes: List<CachedNote>, sort: NoteSort): List<CachedNote> {
    val order = when (sort) {
        NoteSort.EditedNewest, NoteSort.EditedOldest -> {
            val dates = notes.associate { note ->
                note.id to note.updatedAt?.let { runCatching { Instant.parse(it) }.getOrNull() }
            }
            val direction = if (sort == NoteSort.EditedOldest) naturalOrder<Instant>() else reverseOrder()
            compareBy<CachedNote, Instant?>(nullsLast(direction)) { dates[it.id] }.thenByDescending { it.id }
        }
        NoteSort.CreatedNewest, NoteSort.CreatedOldest -> {
            val direction = if (sort == NoteSort.CreatedOldest) naturalOrder<Long>() else reverseOrder()
            compareBy<CachedNote, Long?>(nullsLast(direction)) { it.createdAt }.thenByDescending { it.id }
        }
        NoteSort.TitleAscending, NoteSort.TitleDescending -> {
            val titles = noteTitleComparator()
            val direction = if (sort == NoteSort.TitleDescending) titles.reversed() else titles
            compareBy<CachedNote> { it.title.isBlank() }
                .thenComparator { a, b -> direction.compare(a.title.trim(), b.title.trim()) }
                .thenByDescending { it.id }
        }
        NoteSort.Custom -> {
            val unplacedOrder = compareBy<CachedNote, Long?>(nullsLast(reverseOrder<Long>())) { it.createdAt }
                .thenByDescending { it.id }
            Comparator { a, b ->
                when {
                    a.position == null && b.position == null -> unplacedOrder.compare(a, b)
                    a.position == null -> -1
                    b.position == null -> 1
                    else -> a.position.compareTo(b.position).takeIf { it != 0 } ?: a.id.compareTo(b.id)
                }
            }
        }
    }
    return notes.sortedWith(order)
}

internal expect fun noteTitleComparator(): Comparator<String>

internal data class NoteSection(val title: String?, val notes: List<CachedNote>)

internal fun noteSections(notes: List<CachedNote>, folder: NoteFolder): List<NoteSection> {
    if (folder != NoteFolder.Notes) return listOf(NoteSection(null, notes))
    val (active, archived) = notes.partition { it.folder == NoteFolder.Notes }
    val (pinned, others) = active.partition { it.isPinned }
    return buildList {
        if (pinned.isNotEmpty()) add(NoteSection("Pinned", pinned))
        if (others.isNotEmpty()) add(NoteSection(if (pinned.isNotEmpty()) "Others" else null, others))
        if (archived.isNotEmpty()) add(NoteSection("Archive", archived))
    }
}

@Composable
internal fun NoteSectionTitle(title: String, count: Int? = null) {
    SectionLabel(title, Modifier.padding(top = 6.dp), count)
}

internal data class NoteCardPicture(val name: String, val bitmap: ImageBitmap)

@Composable
internal fun noteCardPictures(
    dao: NoteCacheDao,
    note: CachedNote,
    layout: NoteLayout,
    load: suspend (CachedAttachment) -> ImageBitmap?,
): List<NoteCardPicture> {
    val density = LocalAnchorDensity.current
    val files by remember(dao, note.origin, note.userId, note.id) {
        dao.attachments(note.origin, note.userId, note.id)
    }.collectAsState(emptyList())
    return files.asSequence().filter { it.type == "image" }.take(if (layout == NoteLayout.Masonry) density.maxPictures else 1)
        .toList().mapNotNull { file ->
            key(file) {
                val photo by produceState<ImageBitmap?>(null) {
                    while (true) {
                        try {
                            value = load(file)
                            break
                        } catch (error: CancellationException) {
                            throw error
                        } catch (error: Exception) {
                            if (!isTemporarySyncFailure(error)) break
                            delay(10_000)
                        }
                    }
                }
                photo?.let { NoteCardPicture(file.originalFilename, it) }
            }
        }
}

@Composable
private fun CardPicture(picture: NoteCardPicture, modifier: Modifier) {
    Image(picture.bitmap, "Preview of ${picture.name}", modifier, contentScale = ContentScale.Crop)
}

@Composable
internal fun LibraryNoteCard(
    note: CachedNote,
    layout: NoteLayout,
    modifier: Modifier = Modifier,
    dropTarget: Boolean = false,
    dragHandle: (@Composable (Modifier) -> Unit)? = null,
    pictures: List<NoteCardPicture> = emptyList(),
    picked: Boolean? = null,
    enabled: Boolean = true,
    tags: List<String> = emptyList(),
    footnote: String? = null,
    onClick: () -> Unit,
) {
    val dark = LocalAnchorDarkTheme.current
    val density = LocalAnchorDensity.current
    val noteType = LocalNoteTypography.current
    val palette = notePalette(note.background)
    val colors = MaterialTheme.colorScheme
    val fill = palette?.let { Color(if (dark) it.darkFill else it.lightFill) }
        ?: if (dark) colors.background else colors.surface
    val edge = palette?.let { Color(if (dark) it.darkEdge else it.lightEdge) } ?: colors.outlineVariant
    val preview = remember(note.content) {
        notePreviewText(note.content, List(3) { SpanStyle() }).text.trim()
    }
    val date = remember(note.updatedAt) {
        note.updatedAt?.let { runCatching { noteCardDate(Instant.parse(it)) }.getOrNull() }
    }
    val lines = when (layout) {
        NoteLayout.List -> density.listPreviewLines
        NoteLayout.Grid -> density.gridPreviewLines
        NoteLayout.Masonry -> density.masonryPreviewLines
    }

    Card(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier.fillMaxWidth().heightIn(min = if (layout == NoteLayout.Grid) 120.dp else 56.dp)
            .then(if (picked == null) Modifier else Modifier.semantics { selected = picked }),
        shape = MaterialTheme.shapes.large,
        border = if (dropTarget || picked == true) BorderStroke(2.dp, colors.tertiary) else BorderStroke(1.dp, edge),
        colors = CardDefaults.cardColors(containerColor = fill, contentColor = colors.onSurface),
    ) {
        Column(Modifier.fillMaxWidth().notePattern(palette?.pattern, dark)) {
            if (layout != NoteLayout.List && pictures.isNotEmpty()) {
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    for (row in pictures.chunked(2)) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                            for (picture in row) CardPicture(picture, Modifier.weight(1f).height(96.dp))
                        }
                    }
                }
            }
            Box(Modifier.fillMaxWidth()) {
                val hasAction = dragHandle != null || picked != null
                val thumbnail = pictures.firstOrNull().takeIf { layout == NoteLayout.List }
                val avoidHandle = if (hasAction && thumbnail == null) Modifier.padding(end = 36.dp) else Modifier
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(
                        Modifier.weight(1f).padding(horizontal = 16.dp, vertical = density.space12),
                        verticalArrangement = Arrangement.spacedBy(density.space8),
                    ) {
                        Text(
                            note.title.ifBlank { "Untitled note" },
                            modifier = avoidHandle,
                            style = noteType.style(noteCardTitle),
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                        if (preview.isNotBlank()) {
                            Text(preview, avoidHandle, style = noteType.style(noteCardBody),
                                 maxLines = lines, overflow = TextOverflow.Ellipsis)
                        }
                        val reminder = remember(note.remindAt, note.reminderRecurrence) { reminderLabel(note) }
                        val stamp = footnote ?: date
                        if (tags.isNotEmpty() || reminder != null || stamp != null) {
                            FlowRow(
                                Modifier.fillMaxWidth().padding(top = 2.dp),
                                horizontalArrangement = Arrangement.spacedBy(6.dp),
                                verticalArrangement = Arrangement.spacedBy(4.dp),
                                itemVerticalAlignment = Alignment.CenterVertically,
                            ) {
                                for (tag in tags.take(3)) NoteChip(tag, AnchorIcons.Hash)
                                if (reminder != null) NoteChip(reminder, AnchorIcons.Bell)
                                if (stamp != null) Text(
                                    stamp, Modifier.weight(1f).wrapContentWidth(Alignment.End),
                                    style = noteType.style(noteCardFootnote), color = colors.onSurfaceVariant,
                                )
                            }
                        }
                    }
                    if (thumbnail != null) {
                        CardPicture(thumbnail, Modifier.padding(top = 8.dp, bottom = 8.dp, end = if (hasAction) 48.dp else 12.dp)
                            .size(64.dp).clip(MaterialTheme.shapes.small))
                    }
                }
                if (picked != null) {
                    Box(
                        Modifier.align(Alignment.TopEnd).padding(10.dp).size(22.dp).clip(CircleShape)
                            .then(
                                if (picked) Modifier.background(colors.tertiary)
                                else Modifier.border(1.5.dp, colors.outline, CircleShape),
                            ),
                        contentAlignment = Alignment.Center,
                    ) { if (picked) Icon(AnchorIcons.Check, null, Modifier.size(14.dp), tint = colors.onTertiary) }
                } else dragHandle?.invoke(Modifier.align(Alignment.TopEnd))
            }
        }
    }
}

internal expect fun noteCardDate(time: Instant): String
