package anchor

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlin.time.Instant

internal data class CurrentVersion(val title: String, val content: String?, val canRestore: Boolean, val version: Long)
internal data class RestoredVersion(val note: CurrentVersion, val undoRevisionId: String?)
internal data class NoteRevision(
    val id: String,
    val title: String,
    val content: String?,
    val createdAt: Instant,
    val cause: String,
    val author: String?,
)
internal data class RevisionPage(val entries: List<NoteRevision>, val cursor: String?)
internal data class HistorySnapshot(val current: CurrentVersion, val page: RevisionPage, val offline: Boolean = false)

internal suspend fun loadNoteHistory(
    note: CachedNote,
    localRevisions: List<NoteRevision>,
    remote: suspend () -> HistorySnapshot,
): HistorySnapshot = try {
    remote()
} catch (error: Exception) {
    if (!isTemporarySyncFailure(error) || localRevisions.isEmpty()) throw error
    HistorySnapshot(
        CurrentVersion(note.title, note.content, canRestore = false, version = note.version),
        RevisionPage(localRevisions, cursor = null),
        offline = true,
    )
}

private fun JsonObject.text(key: String) = (get(key) as? JsonPrimitive)?.contentOrNull

internal fun JsonObject.currentVersion() = CurrentVersion(
    title = checkNotNull(text("title")),
    content = text("content"),
    canRestore = text("state") == "active" && text("permission") in listOf("owner", "editor"),
    version = checkNotNull(text("version")).toLong(),
)

internal fun JsonObject.noteRevision() = NoteRevision(
    id = checkNotNull(text("id")),
    title = checkNotNull(text("title")),
    content = text("content"),
    createdAt = Instant.parse(checkNotNull(text("createdAt"))),
    cause = checkNotNull(text("cause")),
    author = (get("author") as? JsonObject)?.text("name"),
)

internal expect fun revisionDate(time: Instant): String

@Composable
internal fun NoteHistory(
    api: AnchorApi,
    session: AnchorSession,
    note: CachedNote,
    localRevisions: List<NoteRevision>,
    onClose: () -> Unit,
    pull: suspend () -> Unit,
) {
    val noteId = note.id
    val scope = rememberCoroutineScope()
    val type = MaterialTheme.typography
    val noteType = LocalNoteTypography.current
    val codeFont = LocalAnchorCodeFont.current
    val highlights = rememberNoteHighlights()
    val headings = remember(type, noteType) { noteType.headings(type) }
    var current by remember { mutableStateOf<CurrentVersion?>(null) }
    var revisions by remember { mutableStateOf(emptyList<NoteRevision>()) }
    var cursor by remember { mutableStateOf<String?>(null) }
    var detail by remember { mutableStateOf<NoteRevision?>(null) }
    var showCurrent by remember { mutableStateOf(false) }
    var confirm by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf("") }
    var failed by remember { mutableStateOf(false) }
    var undo by remember { mutableStateOf<RestoredVersion?>(null) }
    var comparison by remember { mutableStateOf<RevisionComparison?>(null) }
    var offline by remember { mutableStateOf(false) }

    suspend fun load(failure: String, changed: String? = null, action: suspend () -> Unit) {
        busy = true
        failed = false
        status = ""
        try {
            action()
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            status = if ((error as? AnchorHttpFailure)?.code == "NOTE_CHANGED")
                changed ?: failure else failure
            failed = true
        } finally {
            busy = false
        }
    }

    suspend fun loadFirst() = load("Could not load version history.") {
        val snapshot = loadNoteHistory(note, localRevisions) {
            HistorySnapshot(api.currentVersion(session, noteId), api.revisions(session, noteId, null))
        }
        current = snapshot.current
        revisions = snapshot.page.entries
        cursor = snapshot.page.cursor
        offline = snapshot.offline
    }
    LaunchedEffect(Unit) { loadFirst() }

    suspend fun refreshAfterRestore() {
        comparison = null
        try {
            pull()
            val page = api.revisions(session, noteId, null)
            revisions = page.entries
            cursor = page.cursor
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            status += " Reopen history to refresh."
        }
    }

    fun back() {
        if (busy) return
        if (showCurrent || detail != null) {
            showCurrent = false
            detail = null
            status = ""
            failed = false
            undo = null
            comparison = null
        } else onClose()
    }

    Dialog(
        onDismissRequest = ::back,
        properties = DialogProperties(usePlatformDefaultWidth = false, dismissOnClickOutside = false),
    ) {
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            Box(Modifier.fillMaxSize().safeDrawingPadding(), contentAlignment = Alignment.TopCenter) {
                Column(Modifier.widthIn(max = 480.dp).fillMaxWidth()) {
                    val selected = detail
                    val live = current
                    val inDetail = showCurrent || selected != null
                    AnchorTopBar(
                        when {
                            selected != null -> revisionDate(selected.createdAt)
                            showCurrent -> "Current version"
                            else -> "Version history"
                        },
                        navigation = {
                            AnchorIconButton(
                                AnchorIcons.ArrowLeft, if (inDetail) "Back to versions" else "Close history", ::back,
                                enabled = !busy,
                            )
                        },
                        compactTitle = true,
                        actions = {
                            if (selected != null && live?.canRestore == true) {
                                AnchorButton("Restore", { confirm = true }, enabled = !busy, small = true)
                            }
                        },
                    )
                    Column(Modifier.fillMaxWidth().weight(1f).padding(horizontal = 16.dp)) {
                        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth().padding(bottom = 8.dp))
                        if (offline) AnchorBanner("Versions saved on this device", Modifier.padding(bottom = 6.dp), tone = BannerTone.Info)
                        if (failed && status.isNotEmpty()) AnchorBanner(
                            status, Modifier.padding(bottom = 6.dp), tone = BannerTone.Error,
                            actionLabel = if (live == null) "Try again" else null,
                            onAction = { scope.launch { loadFirst() } },
                        )
                        if (inDetail) {
                            var openedFolds by remember(comparison) { mutableStateOf(emptySet<Int>()) }
                            LazyColumn(
                                Modifier.fillMaxWidth().weight(1f),
                                contentPadding = PaddingValues(top = 4.dp, bottom = 16.dp),
                                verticalArrangement = Arrangement.spacedBy(12.dp),
                            ) {
                                if (selected != null && (selected.label() != null || !selected.author.isNullOrBlank())) {
                                    item { RevisionMetadata(selected) }
                                }
                                if (selected?.cause == "conflict") item {
                                    AnchorBanner("This draft was saved when the note changed on another device.", tone = BannerTone.Info)
                                }
                                if (selected != null && live != null) item {
                                    Row(
                                        verticalAlignment = Alignment.CenterVertically,
                                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                                    ) {
                                        ChangesToggle(on = comparison != null, enabled = !busy) {
                                            if (comparison != null) {
                                                comparison = null
                                            } else {
                                                scope.launch {
                                                    load("Could not compare these versions.") {
                                                        val index = revisions.indexOfFirst { it.id == selected.id }
                                                        val target = if (selected.cause != "conflict" && index > 0) {
                                                            revisions.subList(0, index).lastOrNull { it.cause != "conflict" }
                                                        } else null
                                                        val other = if (offline) target else target?.let { api.revision(session, noteId, it.id) }
                                                        comparison = withContext(Dispatchers.Default) {
                                                            RevisionComparison(
                                                                target = if (other == null) "Compared with the current version"
                                                                    else "Compared with ${revisionDate(other.createdAt)}",
                                                                beforeTitle = selected.title,
                                                                afterTitle = other?.title ?: live.title,
                                                                lines = compareRevisions(
                                                                    revisionBlocks(selected.content, headings, codeFont, highlights),
                                                                    revisionBlocks(if (other == null) live.content else other.content, headings, codeFont, highlights),
                                                                ),
                                                            )
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                        comparison?.let {
                                            Text(
                                                it.target,
                                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                                style = MaterialTheme.typography.bodySmall,
                                            )
                                        }
                                    }
                                }
                                val changes = comparison
                                if (changes != null) comparisonRows(changes, openedFolds) { openedFolds = openedFolds + it }
                                else item {
                                    Surface(shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.surface) {
                                        Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                            val title = if (selected != null) selected.title else live?.title.orEmpty()
                                            val content = if (selected != null) selected.content else live?.content
                                            Text(title.ifBlank { "Untitled" }, style = noteType.style(type.titleLarge))
                                            val body = remember(content, headings, codeFont, highlights) {
                                                notePreviewText(content, headings, codeFont, highlights)
                                            }
                                            if (body.isNotBlank()) {
                                                SelectionContainer { Text(body, style = noteType.style(type.bodyLarge)) }
                                            } else {
                                                Text("No note text", color = MaterialTheme.colorScheme.onSurfaceVariant)
                                            }
                                        }
                                    }
                                }
                            }
                        } else if (live != null) {
                            LazyColumn(
                                Modifier.fillMaxWidth().weight(1f),
                                contentPadding = PaddingValues(top = 4.dp, bottom = 16.dp),
                            ) {
                                item {
                                    HistoryRow("Current version", live.title, enabled = !busy, current = true, onClick = { showCurrent = true })
                                }
                                items(revisions, key = { it.id }) { revision ->
                                    HistoryRow(
                                        revision.title.ifBlank { "Untitled" },
                                        listOfNotNull(revisionDate(revision.createdAt), revision.author?.takeIf { it.isNotBlank() })
                                            .joinToString(" · "),
                                        enabled = !busy,
                                        chip = revision.label(),
                                        onClick = {
                                            scope.launch {
                                                load("Could not open this version. Try selecting it again.") {
                                                    detail = if (offline) revision else api.revision(session, noteId, revision.id)
                                                }
                                            }
                                        },
                                    )
                                }
                                if (revisions.isEmpty() && !busy) item {
                                    Text(
                                        "No previous versions", Modifier.padding(vertical = 16.dp),
                                        style = type.bodyMedium.copy(fontSize = 14.sp),
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                                val next = cursor
                                if (next != null) item {
                                    AnchorButton(
                                        "Load more versions",
                                        {
                                            scope.launch {
                                                load("Could not load more versions.") {
                                                    val page = api.revisions(session, noteId, next)
                                                    revisions = (revisions + page.entries).distinctBy { it.id }
                                                    cursor = page.cursor
                                                }
                                            }
                                        },
                                        Modifier.fillMaxWidth().padding(top = 12.dp),
                                        tone = ButtonTone.Secondary,
                                        enabled = !busy,
                                    )
                                }
                            }
                        }
                        val lastRestore = undo
                        val undoId = lastRestore?.undoRevisionId
                        val undoRestore: () -> Unit = undoRestore@{
                            if (busy || lastRestore == null || undoId == null) return@undoRestore
                            scope.launch {
                                load("Could not undo the restore.", "The note changed. This restore can no longer be undone.") {
                                    val restored = try {
                                        api.restoreRevision(session, noteId, undoId, lastRestore.note.version)
                                    } catch (error: AnchorHttpFailure) {
                                        if (error.code == "NOTE_CHANGED") undo = null
                                        throw error
                                    }
                                    current = restored.note
                                    undo = null
                                    status = "Restore undone."
                                    refreshAfterRestore()
                                }
                            }
                        }
                        val canUndo = lastRestore != null && undoId != null
                        if (!failed && status.isNotEmpty()) {
                            AnchorToast(
                                status, Modifier.padding(vertical = 12.dp),
                                actionLabel = if (canUndo) "Undo" else null, onAction = undoRestore,
                            )
                        } else if (canUndo) {
                            AnchorButton(
                                "Undo", undoRestore, Modifier.padding(vertical = 12.dp),
                                tone = ButtonTone.Secondary, enabled = !busy, small = true,
                            )
                        }
                    }
                    if (confirm && selected != null && live != null) {
                        ConfirmDialog(
                            title = "Restore this version?",
                            confirmLabel = "Restore version",
                            text = "The current text will be saved in version history.",
                            destructive = false,
                            onDismiss = { confirm = false },
                            onConfirm = {
                                confirm = false
                                scope.launch {
                                    load("Could not restore this version.", "The note changed. Reopen history and try again.") {
                                        val restored = api.restoreRevision(session, noteId, selected.id, live.version)
                                        current = restored.note
                                        undo = restored.takeIf { it.undoRevisionId != null }
                                        status = if (restored.note.version == live.version)
                                            "The note already matches this version." else "Version restored."
                                        refreshAfterRestore()
                                    }
                                }
                            },
                        )
                    }
                }
            }
        }
    }
}

private fun NoteRevision.label() = when (cause) {
    "conflict" -> "Conflict draft"
    "restore" -> "Before restore"
    else -> null
}

/** One entry of the version timeline (F48): a ring, the title with its kind, and when and by whom. */
@Composable
private fun HistoryRow(
    title: String,
    subtitle: String,
    enabled: Boolean,
    onClick: () -> Unit,
    current: Boolean = false,
    chip: String? = null,
) {
    val colors = MaterialTheme.colorScheme
    Column {
        Row(
            Modifier.fillMaxWidth()
                .then(if (current) Modifier.clip(RoundedCornerShape(12.dp)).background(colors.surfaceContainer) else Modifier)
                .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
                .padding(horizontal = if (current) 12.dp else 4.dp, vertical = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Box(
                Modifier.padding(top = 5.dp).size(10.dp).clip(CircleShape).background(colors.surface)
                    .border(2.dp, if (current) colors.tertiary else colors.onSurfaceVariant, CircleShape),
            )
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(
                        title, Modifier.weight(1f, fill = false),
                        style = MaterialTheme.typography.titleSmall.copy(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
                        maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                    if (chip != null) NoteChip(chip)
                }
                if (subtitle.isNotBlank()) Text(
                    subtitle, style = MaterialTheme.typography.bodySmall.copy(fontSize = 13.sp),
                    color = colors.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
            if (!current) Icon(AnchorIcons.ChevronRight, null, Modifier.padding(top = 2.dp).size(16.dp), tint = colors.onSurfaceVariant)
        }
        if (!current) Box(Modifier.fillMaxWidth().height(1.dp).background(LocalAnchorTones.current.divider))
    }
}

/** The "Show changes" pill of F49; filled while the comparison is open. */
@Composable
private fun ChangesToggle(on: Boolean, enabled: Boolean, onClick: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    val alpha = if (enabled) 1f else 0.45f
    Box(
        Modifier.heightIn(min = 44.dp).clip(CircleShape).clickable(enabled = enabled, role = Role.Button, onClick = onClick),
        contentAlignment = Alignment.CenterStart,
    ) {
        Box(
            Modifier.height(27.dp).clip(CircleShape)
                .background(colors.onSurface.copy(alpha = if (on) alpha else 0.07f))
                .padding(horizontal = 11.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                if (on) "Hide changes" else "Show changes",
                style = MaterialTheme.typography.labelMedium.copy(fontSize = 12.5.sp, fontWeight = FontWeight.Medium),
                color = (if (on) colors.surface else colors.onSurface).copy(alpha = alpha),
            )
        }
    }
}

@Composable
private fun RevisionMetadata(revision: NoteRevision) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        revision.label()?.let { NoteChip(it) }
        revision.author?.takeIf { it.isNotBlank() }?.let {
            Text(it, style = MaterialTheme.typography.bodySmall.copy(fontSize = 13.sp), color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}
