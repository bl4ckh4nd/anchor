package anchor

import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import androidx.compose.ui.Alignment
import androidx.compose.foundation.layout.Box
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.material3.Icon
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size

@Composable
internal fun ShareNoteSheet(api: AnchorApi, session: AnchorSession, note: CachedNote, onClose: () -> Unit) {
    val scope = rememberCoroutineScope()
    var shares by remember { mutableStateOf<List<NoteShare>?>(null) }
    var sharesError by remember { mutableStateOf(false) }
    var refresh by remember { mutableStateOf(0) }
    var busy by remember { mutableStateOf(false) }
    var writeError by remember { mutableStateOf(false) }
    var input by remember { mutableStateOf("") }
    val query = input.trim()
    var contacts by remember(query) { mutableStateOf<List<NoteContact>?>(null) }
    var contactsError by remember(query) { mutableStateOf(false) }
    var recipient by remember { mutableStateOf<NoteContact?>(null) }
    var permission by remember { mutableStateOf(SharePermission.Viewer) }
    var removal by remember { mutableStateOf<NoteShare?>(null) }

    LaunchedEffect(refresh) {
        sharesError = false
        try {
            shares = api.noteShares(session, note)
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            sharesError = true
        }
    }

    LaunchedEffect(query, refresh) {
        contactsError = false
        try {
            if (query.length >= 2) delay(250)
            contacts = api.findShareContacts(session, query)
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            contactsError = true
        }
    }

    fun changeAccess(write: suspend () -> Unit) {
        if (busy) return
        busy = true
        writeError = false
        scope.launch {
            try {
                write()
                input = ""
                recipient = null
                removal = null
                shares = null
                refresh++
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                writeError = true
            } finally {
                busy = false
            }
        }
    }

    val pendingRemoval = removal
    val pendingRecipient = recipient
    AnchorSheet(onDismiss = { if (!busy) onClose() }, title = "Share note", subtitle = note.title.ifBlank { "Untitled note" }) {
        val current = shares
        AnchorField(
            input, {
                input = it
                recipient = null
            }, "Find people", icon = AnchorIcons.Search, enabled = current != null && !busy,
        )
        Column(Modifier.padding(top = 4.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            if (pendingRecipient != null) {
                PersonRow(pendingRecipient, session.userId)
                SectionLabel("Permission", Modifier.padding(top = 6.dp))
                Segmented(SharePermission.entries, permission, SharePermission::label, { permission = it }, enabled = !busy)
                Row(Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    AnchorButton("Cancel", { recipient = null }, Modifier.weight(1f), ButtonTone.Secondary, !busy)
                    AnchorButton("Share", {
                        changeAccess { api.grantNoteShare(session, note, pendingRecipient, permission) }
                    }, Modifier.weight(1f), enabled = !busy && current != null)
                }
            } else if (current != null && query.isNotEmpty()) {
                val available = contacts.orEmpty().filter { contact ->
                    contact.id != session.userId && current.none { it.contact.id == contact.id }
                }
                if (contactsError) {
                    TextButton(enabled = !busy, onClick = { refresh++ }) { Text("Retry finding people") }
                } else if (query.length >= 2 && contacts != null && available.isEmpty()) {
                    Text("No matching people", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                for (contact in available) {
                    PersonRow(contact, session.userId, Modifier.clickable(enabled = !busy, role = Role.Button) {
                        recipient = contact
                        permission = SharePermission.Viewer
                    })
                }
            } else {
                when {
                    sharesError -> TextButton(enabled = !busy, onClick = { refresh++ }) { Text("Retry loading access") }
                    current == null -> Text("Loading access…", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    current.isEmpty() -> EmptyState(AnchorIcons.Users, "No one else has access", modifier = Modifier.padding(0.dp))
                    else -> for (share in current) {
                        PersonRow(share.contact, session.userId) {
                            var menu by remember { mutableStateOf(false) }
                            Box {
                                TextButton(enabled = !busy, onClick = { menu = true }) {
                                    Text(share.permission.label, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                    Icon(AnchorIcons.ChevronDown, null, Modifier.padding(start = 4.dp).size(14.dp))
                                }
                                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                                    val next = if (share.permission == SharePermission.Viewer) SharePermission.Editor else SharePermission.Viewer
                                    DropdownMenuItem(
                                        text = { Text(if (next == SharePermission.Editor) "Make editor" else "Make viewer") },
                                        onClick = {
                                            menu = false
                                            changeAccess { api.changeNoteShare(session, note, share, next) }
                                        },
                                    )
                                    DropdownMenuItem(
                                        text = { Text("Remove access", color = MaterialTheme.colorScheme.error) },
                                        onClick = {
                                            menu = false
                                            writeError = false
                                            removal = share
                                        },
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
        if (writeError) AnchorBanner("Could not update access. Try again.", Modifier.padding(top = 8.dp), BannerTone.Error)
        if (pendingRecipient == null) {
            AnchorButton("Done", onClose, Modifier.fillMaxWidth().padding(top = 12.dp), enabled = !busy)
        }
    }
    if (pendingRemoval != null) {
        ConfirmDialog(
            title = "Remove access?",
            text = "${pendingRemoval.contact.name} (${pendingRemoval.contact.email}) will lose access to this note.",
            confirmLabel = "Remove access",
            enabled = !busy,
            onDismiss = { removal = null },
            onConfirm = { changeAccess { api.revokeNoteShare(session, note, pendingRemoval) } },
        )
    }
}

@Composable
private fun PersonRow(
    contact: NoteContact,
    selfId: String,
    modifier: Modifier = Modifier,
    trailing: @Composable () -> Unit = {},
) {
    Row(
        modifier.fillMaxWidth().heightIn(min = 52.dp).padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Avatar(initialsOf(contact.name.ifBlank { contact.email }), avatarColor(contact.id), 32.dp)
        Column(Modifier.weight(1f)) {
            Text(
                if (contact.id == selfId) "${contact.name} (you)" else contact.name,
                style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold),
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            Text(
                contact.email, style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        }
        trailing()
    }
}
