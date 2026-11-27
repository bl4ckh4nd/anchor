package anchor

import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.material3.Icon
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size

@Composable
internal fun SelectedNoteTags(
    notes: NoteCacheDao,
    session: AnchorSession,
    onTag: (CachedTag) -> Unit,
    onDismiss: () -> Unit,
) {
    val tags by remember(notes, session) { notes.tags(session.origin, session.userId) }.collectAsState(emptyList())
    AnchorSheet(onDismiss = onDismiss, title = "Tag selected notes") {
        if (tags.isEmpty()) Text("Create a tag from a note first.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        for (tag in tags) MenuRow(tag.name, icon = AnchorIcons.Hash, onClick = { onTag(tag) })
        AnchorButton("Cancel", onDismiss, Modifier.fillMaxWidth().padding(top = 12.dp), ButtonTone.Secondary)
    }
}

@Composable
internal fun NoteTags(
    notes: NoteCacheDao,
    note: CachedNote,
    busy: Boolean,
    message: String,
    onClose: () -> Unit,
    onCreate: (String, () -> Unit) -> Unit,
    onAssign: (CachedTag, Boolean) -> Unit,
    onRename: (CachedTag, String, () -> Unit) -> Unit,
    onDelete: (CachedTag, () -> Unit) -> Unit,
) {
    val tags by remember(notes, note.origin, note.userId) {
        notes.tags(note.origin, note.userId)
    }.collectAsState(emptyList())
    val assigned by remember(notes, note.origin, note.userId, note.id) {
        notes.assignedTags(note.origin, note.userId, note.id)
    }.collectAsState(null)
    var name by remember { mutableStateOf("") }
    var editing by remember { mutableStateOf<CachedTag?>(null) }
    var rename by remember { mutableStateOf("") }
    var confirmingDelete by remember { mutableStateOf(false) }
    val tagToEdit = editing
    fun back() {
        if (confirmingDelete) confirmingDelete = false
        else if (editing != null) editing = null
        else onClose()
    }

    if (tagToEdit != null) {
        AnchorSheet(onDismiss = ::back, title = "Rename tag") {
            AnchorField(rename, { rename = it }, "Tag name", enabled = !busy)
            TextButton(enabled = !busy, onClick = { confirmingDelete = true }) {
                Icon(AnchorIcons.Trash2, null, Modifier.padding(end = 6.dp).size(16.dp), tint = MaterialTheme.colorScheme.error)
                Text("Delete tag", color = MaterialTheme.colorScheme.error)
            }
            if (message.isNotEmpty() && !confirmingDelete) AnchorBanner(message, tone = BannerTone.Error)
            Row(Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                AnchorButton("Back", ::back, Modifier.weight(1f), ButtonTone.Secondary, !busy)
                AnchorButton(
                    "Save tag", { onRename(tagToEdit, rename.trim()) { editing = null } }, Modifier.weight(1f),
                    enabled = !busy && rename.isNotBlank() && rename.trim() != tagToEdit.name,
                )
            }
        }
        if (confirmingDelete) ConfirmDialog(
            title = "Delete tag?",
            text = "“${tagToEdit.name}” will be removed from all notes using it.",
            confirmLabel = "Delete tag",
            enabled = !busy,
            onDismiss = { confirmingDelete = false },
            onConfirm = {
                onDelete(tagToEdit) {
                    confirmingDelete = false
                    editing = null
                }
            },
        )
        return
    }
    AnchorSheet(onDismiss = ::back, title = "Tags") {
        AnchorField(
            name, { name = it }, "New tag", icon = AnchorIcons.Plus, enabled = !busy,
            trailing = {
                TextButton(
                    enabled = !busy && name.isNotBlank(),
                    onClick = { onCreate(name.trim()) { name = "" } },
                ) { Text("Create tag") }
            },
        )
        if (message.isNotEmpty()) AnchorBanner(message, Modifier.padding(top = 4.dp), BannerTone.Error)
        Column(Modifier.padding(top = 4.dp)) {
            for (tag in tags) {
                val selected = assigned?.contains(tag.id) == true
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Row(
                        Modifier.weight(1f).heightIn(min = 48.dp).toggleable(
                            value = selected,
                            enabled = !busy && assigned != null,
                            role = Role.Checkbox,
                            onValueChange = { onAssign(tag, it) },
                        ),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Checkbox(selected, onCheckedChange = null, enabled = !busy && assigned != null)
                        Text(tag.name)
                    }
                    TextButton(
                        enabled = !busy,
                        modifier = Modifier.semantics { contentDescription = "Edit ${tag.name}" },
                        onClick = {
                            editing = tag
                            rename = tag.name
                        },
                    ) {
                        Text("Edit", color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Icon(AnchorIcons.ChevronRight, null, Modifier.padding(start = 2.dp).size(14.dp))
                    }
                }
            }
        }
        AnchorButton("Done", ::back, Modifier.fillMaxWidth().padding(top = 12.dp))
    }
}
