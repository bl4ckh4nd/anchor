package anchor

import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import kotlin.time.TimeSource
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import androidx.compose.ui.Alignment
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.background

internal const val recordingBitRate = 96_000
internal const val recordingSampleRate = 44_100
internal const val recordingLimitMillis = (maxAttachmentBytes - 2 * 1024 * 1024) * 8_000L / recordingBitRate

internal interface AudioCapture {
    suspend fun requestPermission(): Boolean
    fun start()
    suspend fun stop(): PickedAttachment
    fun cancel()
}

@Composable
internal expect fun rememberAudioCapture(): AudioCapture

/** Asks for the microphone, then records in a sheet. Compose it while [open] is true. */
@Composable
internal fun RecordAudio(
    foreground: Boolean,
    onClose: () -> Unit,
    failed: (String) -> Unit,
    confirmationLabel: String = "Attach recording",
    attach: suspend (PickedAttachment) -> Unit,
) {
    val capture = rememberAudioCapture()
    var dialogOpen by remember { mutableStateOf(false) }
    LaunchedEffect(capture) {
        try {
            if (capture.requestPermission()) dialogOpen = true
            else {
                failed("Allow microphone access in Settings to record.")
                onClose()
            }
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            failed("Could not access the microphone.")
            onClose()
        }
    }
    if (dialogOpen) {
        RecordAudioDialog(capture, foreground, onClose, failed, confirmationLabel, attach)
    }
}

@Composable
private fun RecordAudioDialog(
    capture: AudioCapture,
    foreground: Boolean,
    close: () -> Unit,
    failed: (String) -> Unit,
    confirmationLabel: String,
    attach: suspend (PickedAttachment) -> Unit,
) {
    val scope = rememberCoroutineScope()
    var running by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var elapsed by remember { mutableStateOf(0L) }
    var clip by remember { mutableStateOf<PickedAttachment?>(null) }
    var message by remember { mutableStateOf("") }

    DisposableEffect(capture) { onDispose(capture::cancel) }

    LaunchedEffect(foreground) {
        if (!foreground) {
            if (running || clip != null) {
                capture.cancel()
                close()
            }
            return@LaunchedEffect
        }
        if (!running && clip == null) {
            try {
                capture.start()
                running = true
            } catch (_: Exception) {
                failed("Could not start recording.")
                close()
            }
        }
    }

    fun finish() {
        if (!running || busy) return
        busy = true
        scope.launch {
            try {
                clip = capture.stop()
                running = false
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                failed("Could not save the recording. Try recording again.")
                close()
            } finally {
                busy = false
            }
        }
    }

    LaunchedEffect(running) {
        if (!running) return@LaunchedEffect
        val startedAt = TimeSource.Monotonic.markNow()
        while (startedAt.elapsedNow().inWholeMilliseconds < recordingLimitMillis) {
            elapsed = startedAt.elapsedNow().inWholeSeconds
            delay(250)
        }
        finish()
    }

    val recording = clip
    AnchorSheet(onDismiss = { if (!busy) close() }, title = if (recording != null) "Review recording" else "Record audio") {
        if (recording != null) {
            AttachmentAudio(recording.bytes)
        } else {
            Column(Modifier.fillMaxWidth().padding(vertical = 12.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Box(
                    Modifier.size(64.dp).clip(CircleShape).background(MaterialTheme.colorScheme.error.copy(alpha = 0.12f)),
                    contentAlignment = Alignment.Center,
                ) { Icon(AnchorIcons.Mic, null, Modifier.size(28.dp), tint = MaterialTheme.colorScheme.error) }
                Text(
                    audioTimestamp(elapsed), Modifier.padding(top = 10.dp),
                    style = MaterialTheme.typography.headlineSmall.copy(fontWeight = FontWeight.SemiBold),
                )
                Text(
                    if (running) "Recording" else "Starting microphone",
                    Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        if (message.isNotEmpty()) AnchorBanner(message, tone = BannerTone.Error)
        Row(Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            AnchorButton("Cancel", close, Modifier.weight(1f), ButtonTone.Secondary, !busy)
            if (recording == null) {
                AnchorButton("Stop recording", ::finish, Modifier.weight(1f), enabled = running && !busy, icon = AnchorIcons.Square)
            } else {
                AnchorButton(confirmationLabel, {
                    busy = true
                    scope.launch {
                        try {
                            attach(recording)
                            close()
                        } catch (error: CancellationException) {
                            throw error
                        } catch (_: Exception) {
                            message = "Could not save the recording on this device. Try again."
                        } finally {
                            busy = false
                        }
                    }
                }, Modifier.weight(1f), enabled = !busy)
            }
        }
    }
}
