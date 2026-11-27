@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)

package anchor

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import kotlin.coroutines.resume
import kotlin.uuid.Uuid
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import platform.AVFAudio.AVAudioRecorder
import platform.AVFAudio.AVAudioSession
import platform.AVFAudio.AVAudioSessionCategoryPlayAndRecord
import platform.AVFAudio.AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation
import platform.AVFAudio.AVEncoderBitRateKey
import platform.AVFAudio.AVFormatIDKey
import platform.AVFAudio.AVNumberOfChannelsKey
import platform.AVFAudio.AVSampleRateKey
import platform.AVFAudio.setActive
import platform.CoreAudioTypes.kAudioFormatMPEG4AAC
import platform.Foundation.NSTemporaryDirectory
import platform.Foundation.NSURL
import kotlinx.io.buffered
import kotlinx.io.files.Path
import kotlinx.io.files.SystemFileSystem
import kotlinx.io.readByteArray

@Composable
internal actual fun rememberAudioCapture(): AudioCapture = remember {
    object : AudioCapture {
        private val session = AVAudioSession.sharedInstance()
        private var recorder: AVAudioRecorder? = null
        private var file: Path? = null
        private var previousCategory: String? = null

        override suspend fun requestPermission(): Boolean = suspendCancellableCoroutine { continuation ->
            session.requestRecordPermission { granted -> continuation.resume(granted) }
        }

        override fun start() {
            check(recorder == null)
            val output = Path(NSTemporaryDirectory(), "anchor-recording-${Uuid.random()}.m4a")
            file = output
            previousCategory = session.category
            try {
                check(session.setCategory(AVAudioSessionCategoryPlayAndRecord, error = null))
                check(session.setActive(true, error = null))
                val settings = mapOf<Any?, Any>(
                    AVFormatIDKey to kAudioFormatMPEG4AAC.toInt(),
                    AVSampleRateKey to recordingSampleRate,
                    AVNumberOfChannelsKey to 1,
                    AVEncoderBitRateKey to recordingBitRate,
                )
                val media = AVAudioRecorder(NSURL.fileURLWithPath(output.toString()), settings, error = null)
                recorder = media
                check(media.record())
            } catch (error: Exception) {
                cancel()
                throw error
            }
        }

        private fun endRecording() {
            recorder?.stop()
            recorder = null
            previousCategory?.let {
                session.setActive(false, withOptions = AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation, error = null)
                session.setCategory(it, error = null)
            }
            previousCategory = null
        }

        override suspend fun stop(): PickedAttachment {
            val output = checkNotNull(file)
            file = null
            try {
                endRecording()
                return withContext(Dispatchers.Default) {
                    val fs = SystemFileSystem
                    val size = checkNotNull(fs.metadataOrNull(output)).size
                    require(size in 1L..maxAttachmentBytes.toLong())
                    val bytes = fs.source(output).buffered().use { it.readByteArray() }
                    PickedAttachment("Recording.m4a", "audio/mp4", bytes)
                }
            } finally {
                SystemFileSystem.delete(output, mustExist = false)
            }
        }

        override fun cancel() {
            endRecording()
            file?.let { SystemFileSystem.delete(it, mustExist = false) }
            file = null
        }
    }
}
