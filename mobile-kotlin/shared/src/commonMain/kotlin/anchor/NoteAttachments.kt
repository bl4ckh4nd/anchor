package anchor

import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.foundation.Image
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
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import androidx.compose.ui.Alignment
import androidx.compose.foundation.layout.Box
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Surface
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.foundation.clickable
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.safeDrawingPadding

private data class AttachmentPreview(val file: CachedAttachment, val image: ImageBitmap? = null, val audio: ByteArray? = null)

@Composable
internal fun NoteAttachments(
    note: CachedNote,
    session: AnchorSession,
    cache: NoteCacheDao,
    outbox: AttachmentOutbox,
    sendingId: String?,
    discardUpload: suspend (String) -> Unit,
    readAttachment: suspend (CachedAttachment) -> ByteArray,
    transferAttachment: ((CachedAttachment, AttachmentTransfer) -> Unit)?,
    api: AnchorApi,
    foreground: Boolean,
    pull: suspend () -> Unit,
    adding: Boolean = false,
    onAddingClose: () -> Unit = {},
) {
    val files by remember(cache, note.origin, note.userId, note.id) {
        cache.attachments(note.origin, note.userId, note.id)
    }.collectAsState(emptyList())
    val pending by remember(outbox, note.origin, note.userId, note.id) {
        outbox.observeNote(note.origin, note.userId, note.id)
    }.collectAsState(emptyList())
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var preview by remember { mutableStateOf<AttachmentPreview?>(null) }
    var deleteCandidate by remember { mutableStateOf<CachedAttachment?>(null) }
    var draftOrder by remember { mutableStateOf<List<CachedAttachment>?>(null) }
    var message by remember { mutableStateOf("") }

    fun canDelete(file: CachedAttachment): Boolean =
        note.canEdit && (note.isOwner || file.uploadedByUserId == session.userId)

    val pick = rememberPickAttachment { result ->
        val file = result.getOrNull()
        scope.launch {
            try {
                if (result.isFailure) {
                    message = "Choose a supported image or audio file up to 50 MiB."
                } else if (file != null && note.canEdit) {
                    outbox.enqueue(note, file)
                }
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                message = "Could not save the attachment on this device."
            } finally {
                busy = false
            }
        }
    }

    LaunchedEffect(foreground, files, preview) {
        if (!foreground || preview?.let { value -> files.none(value.file::matchesFile) } == true) {
            preview = null
        }
    }
    LaunchedEffect(foreground, files, note.canEdit, note.isOwner) {
        val candidate = deleteCandidate
        if (!foreground || candidate != null && (!canDelete(candidate) || files.none { it.id == candidate.id })) {
            deleteCandidate = null
        }
    }
    LaunchedEffect(foreground, note.canEdit, files) {
        draftOrder = null
    }

    var recording by remember { mutableStateOf(false) }
    if (files.isNotEmpty() || pending.isNotEmpty() || message.isNotEmpty()) Column(
        Modifier.fillMaxWidth().padding(vertical = 4.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        for (file in files) {
            AttachmentRow(
                if (file.type == "audio") AnchorIcons.Mic else AnchorIcons.Image,
                file.originalFilename, enabled = !busy,
                onClick = {
                    busy = true
                    message = "Opening ${file.originalFilename}…"
                    scope.launch {
                        try {
                            val bytes = readAttachment(file)
                            preview = if (file.type == "audio") {
                                AttachmentPreview(file, audio = bytes)
                            } else {
                                AttachmentPreview(file, image = decodeAttachmentImage(bytes) ?: error("Invalid image"))
                            }
                            message = ""
                        } catch (error: CancellationException) {
                            throw error
                        } catch (error: Exception) {
                            message = if (error is AnchorHttpFailure && error.status == 404) {
                                "This attachment is no longer available."
                            } else {
                                "Could not open this attachment."
                            }
                        } finally {
                            busy = false
                        }
                    }
                },
            )
        }
        for (item in pending) {
            val rejected = item.rejected
            AttachmentRow(
                if (rejected) AnchorIcons.TriangleAlert else AnchorIcons.LoaderCircle,
                item.filename,
                detail = when {
                    rejected -> "Upload rejected"
                    sendingId == item.id -> "Uploading…"
                    else -> "Waiting to upload"
                },
                danger = rejected,
                action = {
                    TextButton(enabled = !busy && sendingId != item.id, onClick = {
                        busy = true
                        scope.launch {
                            try {
                                discardUpload(item.id)
                            } catch (error: CancellationException) {
                                throw error
                            } catch (_: Exception) {
                                message = "Could not discard the upload."
                            } finally {
                                busy = false
                            }
                        }
                    }) { Text("Discard upload") }
                },
            )
        }
        if (message.isNotEmpty()) {
            Text(
                message, Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }

    if (adding && note.canEdit) {
        AnchorSheet(onDismiss = onAddingClose, title = "Add to note") {
            MenuRow("Picture or audio file", icon = AnchorIcons.Image, detail = "Up to 50 MiB", enabled = !busy, onClick = {
                onAddingClose()
                busy = true
                message = ""
                pick()
            })
            MenuRow("Record audio", icon = AnchorIcons.Mic, enabled = !busy && foreground, onClick = {
                onAddingClose()
                recording = true
            })
            if (files.size > 1) MenuRow("Reorder attachments", icon = AnchorIcons.GripVertical, enabled = !busy, onClick = {
                onAddingClose()
                draftOrder = files
            })
        }
    }
    if (recording && note.canEdit) {
        RecordAudio(foreground, onClose = { recording = false }, failed = { message = it }) {
            outbox.enqueue(note, it)
            message = ""
        }
    }

    val order = draftOrder
    if (order != null && foreground && note.canEdit) {
        AttachmentOrderDialog(
            order = order,
            changed = order != files,
            move = { from, to ->
                draftOrder = order.toMutableList().apply { add(to, removeAt(from)) }
            },
            dismiss = { draftOrder = null },
            save = {
                draftOrder = null
                busy = true
                message = ""
                scope.launch {
                    try {
                        api.reorderAttachments(session, note, order.map { it.id })
                        message = "Attachment order saved."
                        pull()
                    } catch (error: CancellationException) {
                        throw error
                    } catch (_: Exception) {
                        message = if (message.isEmpty()) "Could not save attachment order. Sync and try again."
                            else "Attachment order saved. Sync to update the list."
                    } finally {
                        busy = false
                    }
                }
            },
        )
    }

    val opened = preview
    if (opened != null && foreground && files.any(opened.file::matchesFile)) {
        Dialog(
            onDismissRequest = { preview = null },
            properties = DialogProperties(usePlatformDefaultWidth = false),
        ) {
            // Media stays on a dark scrim in both themes, like the web viewer.
            Surface(Modifier.fillMaxSize(), color = Color(0xF20B0C0F), contentColor = Color.White) {
                Column(Modifier.fillMaxSize().safeDrawingPadding()) {
                    Row(
                        Modifier.fillMaxWidth().height(56.dp).padding(horizontal = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        AnchorIconButton(AnchorIcons.X, "Close preview", { preview = null }, tint = Color.White)
                        Text(
                            opened.file.originalFilename, Modifier.weight(1f).padding(start = 6.dp),
                            style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        )
                        if (canDelete(opened.file)) AnchorIconButton(AnchorIcons.Trash2, "Delete attachment", {
                            preview = null
                            deleteCandidate = opened.file
                        }, tint = Color.White)
                    }
                    Box(Modifier.fillMaxWidth().weight(1f).padding(16.dp), contentAlignment = Alignment.Center) {
                        opened.image?.let {
                            Image(it, opened.file.originalFilename, Modifier.fillMaxSize().clip(RoundedCornerShape(12.dp)), contentScale = ContentScale.Fit)
                        }
                        opened.audio?.let {
                            Surface(shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surface) {
                                Box(Modifier.padding(12.dp)) { AttachmentAudio(it) }
                            }
                        }
                    }
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
                        horizontalArrangement = Arrangement.SpaceEvenly,
                    ) {
                        for (action in AttachmentTransfer.entries) {
                            if (action == AttachmentTransfer.Photo && opened.image == null) continue
                            Column(
                                Modifier.clip(RoundedCornerShape(12.dp))
                                    .clickable(enabled = transferAttachment != null, role = Role.Button) {
                                        preview = null
                                        transferAttachment?.invoke(opened.file, action)
                                    }
                                    .padding(horizontal = 12.dp, vertical = 8.dp),
                                horizontalAlignment = Alignment.CenterHorizontally,
                                verticalArrangement = Arrangement.spacedBy(4.dp),
                            ) {
                                Icon(
                                    when (action) {
                                        AttachmentTransfer.Download -> AnchorIcons.Download
                                        AttachmentTransfer.Share -> AnchorIcons.Share2
                                        AttachmentTransfer.Photo -> AnchorIcons.Image
                                    }, null, Modifier.size(20.dp),
                                )
                                Text(action.label, style = MaterialTheme.typography.labelMedium)
                            }
                        }
                    }
                }
            }
        }
    }

    val candidate = deleteCandidate
    if (candidate != null && foreground && canDelete(candidate) && files.any { it.id == candidate.id }) {
        ConfirmDialog(
            title = "Delete attachment?",
            text = candidate.originalFilename,
            confirmLabel = "Delete",
            onDismiss = { deleteCandidate = null },
            onConfirm = {
                deleteCandidate = null
                busy = true
                message = ""
                scope.launch {
                    try {
                        api.deleteAttachment(session, candidate)
                        message = "Attachment deleted."
                        pull()
                    } catch (error: CancellationException) {
                        throw error
                    } catch (_: Exception) {
                        message = if (message.isEmpty()) "Could not delete the attachment. Try again."
                            else "Attachment deleted. Sync to update the list."
                    } finally {
                        busy = false
                    }
                }
            },
        )
    }
}

@Composable
private fun AttachmentOrderDialog(
    order: List<CachedAttachment>,
    changed: Boolean,
    move: (Int, Int) -> Unit,
    dismiss: () -> Unit,
    save: () -> Unit,
) {
    AnchorSheet(onDismiss = dismiss, title = "Reorder attachments") {
        for ((index, item) in order.withIndex()) {
            Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(item.originalFilename, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                IconButton(
                    onClick = { move(index, index - 1) },
                    enabled = index > 0,
                    modifier = Modifier.semantics { contentDescription = "Move ${item.originalFilename} up" },
                ) { Icon(AnchorIcons.ArrowUp, null, Modifier.size(18.dp)) }
                IconButton(
                    onClick = { move(index, index + 1) },
                    enabled = index < order.lastIndex,
                    modifier = Modifier.semantics { contentDescription = "Move ${item.originalFilename} down" },
                ) { Icon(AnchorIcons.ArrowDown, null, Modifier.size(18.dp)) }
            }
        }
        Row(Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            AnchorButton("Cancel", dismiss, Modifier.weight(1f), ButtonTone.Secondary)
            AnchorButton("Save order", save, Modifier.weight(1f), enabled = changed)
        }
    }
}

@Composable
private fun AttachmentRow(
    icon: ImageVector,
    name: String,
    detail: String? = null,
    danger: Boolean = false,
    enabled: Boolean = true,
    onClick: (() -> Unit)? = null,
    action: (@Composable () -> Unit)? = null,
) {
    val colors = MaterialTheme.colorScheme
    val ink = if (danger) colors.error else colors.onSurface
    Row(
        Modifier.fillMaxWidth().heightIn(min = 48.dp).clip(RoundedCornerShape(12.dp))
            .background(colors.surface.copy(alpha = 0.7f))
            .then(if (onClick != null) Modifier.clickable(enabled = enabled, role = Role.Button, onClick = onClick) else Modifier)
            .padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Icon(icon, null, Modifier.size(18.dp), tint = if (danger) colors.error else colors.onSurfaceVariant)
        Column(Modifier.weight(1f).padding(vertical = 8.dp)) {
            Text(name, color = ink, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (detail != null) Text(
                detail, Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                style = MaterialTheme.typography.bodySmall, color = if (danger) colors.error else colors.onSurfaceVariant,
            )
        }
        action?.invoke()
    }
}
