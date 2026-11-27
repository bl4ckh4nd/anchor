package anchor

import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Button
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp

internal const val maxAttachmentBytes = 50 * 1024 * 1024
internal const val maxProfileImageBytes = 5 * 1024 * 1024
internal val profileImageTypes = setOf("image/jpeg", "image/png", "image/webp")

internal data class PickedAttachment(val name: String, val mimeType: String, val bytes: ByteArray)

private val mimeByExtension = mapOf(
    "jpeg" to "image/jpeg",
    "jpg" to "image/jpeg",
    "png" to "image/png",
    "webp" to "image/webp",
    "gif" to "image/gif",
    "mp3" to "audio/mpeg",
    "wav" to "audio/wav",
    "m4a" to "audio/x-m4a",
    "mp4" to "audio/mp4",
    "ogg" to "audio/ogg",
    "oga" to "audio/ogg",
    "opus" to "audio/ogg",
    "aac" to "audio/aac",
    "webm" to "audio/webm",
)

internal fun attachmentMimeType(name: String, declared: String? = null): String? =
    declared?.takeIf { it in mimeByExtension.values }
        ?: mimeByExtension[name.substringAfterLast('.', "").lowercase()]

@Composable
internal expect fun rememberPickAttachment(
    profileImage: Boolean = false,
    onResult: (Result<PickedAttachment?>) -> Unit,
): () -> Unit

internal fun attachmentExportName(name: String): String =
    name.substringAfterLast('/').substringAfterLast('\\')
        .filterNot { it.isISOControl() }.trim()
        .takeUnless { it.isEmpty() || it == "." || it == ".." } ?: "attachment"

internal enum class AttachmentTransfer(val label: String) {
    Download("Download"), Share("Share file"), Photo("Save to Photos"),
}

internal class PhotoPermissionDenied : Exception()

@Composable
internal expect fun rememberTransferAttachment(
    onResult: (AttachmentTransfer, Result<Boolean>) -> Unit,
): (CachedAttachment, AttachmentTransfer, suspend () -> ByteArray) -> Unit

internal expect suspend fun decodeAttachmentImage(bytes: ByteArray, maxDimension: Int? = null): ImageBitmap?

@Composable
internal expect fun AttachmentAudio(bytes: ByteArray)

internal fun audioTimestamp(seconds: Long): String =
    "${seconds / 60}:${(seconds % 60).toString().padStart(2, '0')}"

@Composable
internal fun AudioPlaybackControls(
    ready: Boolean,
    playing: Boolean,
    positionMillis: Long,
    durationMillis: Long,
    onToggle: () -> Unit,
    onSeek: (Long) -> Unit,
) {
    var scrub by remember(durationMillis) { mutableStateOf<Float?>(null) }
    val position = scrub?.toLong() ?: positionMillis
    val timing = "${audioTimestamp(position / 1000)} / ${audioTimestamp(durationMillis / 1000)}"
    Column {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Button(enabled = ready, onClick = onToggle) { Text(if (playing) "Pause" else "Play") }
            if (durationMillis > 0) Text(timing)
        }
        if (durationMillis > 0) {
            Slider(
                value = position.toFloat().coerceIn(0f, durationMillis.toFloat()),
                valueRange = 0f..durationMillis.toFloat(),
                onValueChange = { scrub = it },
                onValueChangeFinished = {
                    scrub?.toLong()?.let(onSeek)
                    scrub = null
                },
                modifier = Modifier.fillMaxWidth().semantics {
                    contentDescription = "Playback position"
                    stateDescription = timing
                },
            )
        }
    }
}
