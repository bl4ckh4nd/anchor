package anchor

import android.Manifest
import android.content.pm.PackageManager
import android.media.MediaRecorder
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import java.io.File
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

@Composable
internal actual fun rememberAudioCapture(): AudioCapture {
    val context = LocalContext.current
    var permission by remember { mutableStateOf<CompletableDeferred<Boolean>?>(null) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        permission?.complete(it)
    }
    return remember(context, launcher) {
        object : AudioCapture {
            private var recorder: MediaRecorder? = null
            private var file: File? = null

            override suspend fun requestPermission(): Boolean {
                if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED)
                    return true
                val result = CompletableDeferred<Boolean>()
                permission = result
                return try {
                    launcher.launch(Manifest.permission.RECORD_AUDIO)
                    result.await()
                } finally {
                    permission = null
                }
            }

            @Suppress("DEPRECATION")
            override fun start() {
                check(recorder == null)
                file = File.createTempFile("anchor-recording-", ".m4a", context.cacheDir)
                try {
                    val media = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(context) else MediaRecorder()
                    recorder = media
                    media.setAudioSource(MediaRecorder.AudioSource.MIC)
                    media.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                    media.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                    media.setAudioChannels(1)
                    media.setAudioEncodingBitRate(recordingBitRate)
                    media.setAudioSamplingRate(recordingSampleRate)
                    media.setMaxFileSize(maxAttachmentBytes.toLong())
                    media.setOutputFile(checkNotNull(file).absolutePath)
                    media.prepare()
                    media.start()
                } catch (error: Exception) {
                    cancel()
                    throw error
                }
            }

            override suspend fun stop(): PickedAttachment {
                val active = checkNotNull(recorder)
                val output = checkNotNull(file)
                recorder = null
                file = null
                try {
                    try {
                        active.stop()
                    } finally {
                        active.release()
                    }
                    return withContext(Dispatchers.IO) {
                        require(output.length() in 1L..maxAttachmentBytes.toLong())
                        PickedAttachment("Recording.m4a", "audio/mp4", output.readBytes())
                    }
                } finally {
                    output.delete()
                }
            }

            override fun cancel() {
                recorder?.release()
                recorder = null
                file?.delete()
                file = null
            }
        }
    }
}
