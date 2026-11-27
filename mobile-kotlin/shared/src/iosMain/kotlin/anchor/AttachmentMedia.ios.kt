@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)

package anchor

import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.toComposeImageBitmap
import androidx.compose.ui.uikit.LocalUIViewController
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.coroutines.suspendCoroutine
import kotlin.uuid.Uuid
import kotlinx.cinterop.addressOf
import kotlinx.cinterop.usePinned
import kotlinx.io.buffered
import kotlinx.io.files.Path
import kotlinx.io.files.SystemFileSystem
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import org.jetbrains.skia.Image
import org.jetbrains.skia.Rect
import org.jetbrains.skia.Surface
import platform.AVFAudio.AVAudioPlayer
import platform.AVFAudio.AVAudioPlayerDelegateProtocol
import platform.Foundation.NSData
import platform.Foundation.NSFileHandle
import platform.Foundation.NSFileManager
import platform.Foundation.NSTemporaryDirectory
import platform.Foundation.NSURL
import platform.Foundation.closeFile
import platform.Foundation.create
import platform.Foundation.fileHandleForReadingFromURL
import platform.Foundation.getBytes
import platform.Foundation.readDataOfLength
import platform.Photos.PHAccessLevelAddOnly
import platform.Photos.PHAssetCreationRequest
import platform.Photos.PHAssetResourceTypePhoto
import platform.Photos.PHAuthorizationStatusAuthorized
import platform.Photos.PHPhotoLibrary
import platform.UIKit.UIActivityViewController
import platform.UIKit.UIDocumentPickerDelegateProtocol
import platform.UIKit.UIDocumentPickerViewController
import platform.UIKit.popoverPresentationController
import platform.UniformTypeIdentifiers.UTTypeAudio
import platform.UniformTypeIdentifiers.UTTypeImage
import platform.darwin.NSObject

@Composable
internal actual fun rememberTransferAttachment(
    onResult: (AttachmentTransfer, Result<Boolean>) -> Unit,
): (CachedAttachment, AttachmentTransfer, suspend () -> ByteArray) -> Unit {
    val controller = LocalUIViewController.current
    val scope = rememberCoroutineScope()
    val deliver by rememberUpdatedState(onResult)
    val manager = NSFileManager.defaultManager
    var stagedDirectory by remember { mutableStateOf<NSURL?>(null) }

    fun cleanUp() {
        stagedDirectory?.let { manager.removeItemAtURL(it, error = null) }
        stagedDirectory = null
    }
    DisposableEffect(Unit) { onDispose(::cleanUp) }
    val delegate = remember {
        object : NSObject(), UIDocumentPickerDelegateProtocol {
            override fun documentPicker(controller: UIDocumentPickerViewController, didPickDocumentsAtURLs: List<*>) {
                cleanUp()
                deliver(AttachmentTransfer.Download, Result.success(didPickDocumentsAtURLs.isNotEmpty()))
            }

            override fun documentPickerWasCancelled(controller: UIDocumentPickerViewController) {
                cleanUp()
                deliver(AttachmentTransfer.Download, Result.success(false))
            }
        }
    }

    return { file, action, download ->
        scope.launch {
            val directory = Path(NSTemporaryDirectory(), "anchor-export-${Uuid.random()}")
            val directoryUrl = NSURL.fileURLWithPath(directory.toString(), isDirectory = true)
            try {
                if (action == AttachmentTransfer.Photo) {
                    require(file.mimeType.startsWith("image/"))
                    val allowed = suspendCancellableCoroutine { continuation ->
                        PHPhotoLibrary.requestAuthorizationForAccessLevel(PHAccessLevelAddOnly) { status ->
                            continuation.resume(status == PHAuthorizationStatusAuthorized)
                        }
                    }
                    if (!allowed) throw PhotoPermissionDenied()
                }
                val bytes = download().also { require(it.isNotEmpty()) }
                val output = Path(directory, attachmentExportName(file.originalFilename))
                withContext(Dispatchers.Default) {
                    SystemFileSystem.createDirectories(directory)
                    SystemFileSystem.sink(output).buffered().use { it.write(bytes) }
                }
                val url = NSURL.fileURLWithPath(output.toString())
                if (action == AttachmentTransfer.Photo) {
                    saveIosPhoto(url)
                    manager.removeItemAtURL(directoryUrl, error = null)
                    deliver(action, Result.success(true))
                    return@launch
                }
                check(controller.view.window != null && controller.presentedViewController == null)
                val presentation = if (action == AttachmentTransfer.Download) {
                    UIDocumentPickerViewController(forExportingURLs = listOf(url), asCopy = true)
                        .apply { this.delegate = delegate }
                } else {
                    UIActivityViewController(listOf(url), applicationActivities = null).apply {
                        popoverPresentationController?.apply {
                            sourceView = controller.view
                            sourceRect = controller.view.bounds
                            permittedArrowDirections = 0uL
                        }
                        completionWithItemsHandler = { _, completed, _, error ->
                            cleanUp()
                            deliver(action, if (error == null) Result.success(completed)
                                else Result.failure(IllegalStateException(error.localizedDescription)))
                        }
                    }
                }
                stagedDirectory = directoryUrl
                controller.presentViewController(presentation, animated = true, completion = null)
            } catch (error: Exception) {
                manager.removeItemAtURL(directoryUrl, error = null)
                stagedDirectory = null
                if (error is CancellationException) throw error
                deliver(action, Result.failure(error))
            }
        }
    }
}

private suspend fun saveIosPhoto(url: NSURL): Unit = suspendCoroutine { continuation ->
    PHPhotoLibrary.sharedPhotoLibrary().performChanges({
        PHAssetCreationRequest.creationRequestForAsset().addResourceWithType(
            PHAssetResourceTypePhoto, fileURL = url, options = null,
        )
    }, completionHandler = { success, error ->
        if (success) continuation.resume(Unit)
        else continuation.resumeWithException(IllegalStateException(error?.localizedDescription ?: "Photo import failed."))
    })
}

@Composable
internal actual fun rememberPickAttachment(
    profileImage: Boolean,
    onResult: (Result<PickedAttachment?>) -> Unit,
): () -> Unit {
    val controller = LocalUIViewController.current
    val scope = rememberCoroutineScope()
    val deliver by rememberUpdatedState(onResult)
    val delegate = remember {
        object : NSObject(), UIDocumentPickerDelegateProtocol {
            override fun documentPicker(controller: UIDocumentPickerViewController, didPickDocumentsAtURLs: List<*>) {
                val url = didPickDocumentsAtURLs.firstOrNull() as? NSURL ?: run {
                    deliver(Result.success(null))
                    return
                }
                scope.launch {
                    try {
                        val file = withContext(Dispatchers.Default) { readPickedAttachment(url, profileImage) }
                        deliver(Result.success(file))
                    } catch (error: CancellationException) {
                        throw error
                    } catch (error: Exception) {
                        deliver(Result.failure(error))
                    }
                }
            }

            override fun documentPickerWasCancelled(controller: UIDocumentPickerViewController) {
                deliver(Result.success(null))
            }
        }
    }
    return {
        val picker = UIDocumentPickerViewController(forOpeningContentTypes = if (profileImage) listOf(UTTypeImage) else listOf(UTTypeImage, UTTypeAudio), asCopy = true)
        picker.delegate = delegate
        controller.presentViewController(picker, animated = true, completion = null)
    }
}

private fun readPickedAttachment(url: NSURL, profileImage: Boolean): PickedAttachment {
    val limit = if (profileImage) maxProfileImageBytes else maxAttachmentBytes
    try {
        val name = url.lastPathComponent ?: error("Missing filename")
        val mimeType = attachmentMimeType(name) ?: error("Unsupported file type")
        require(!profileImage || mimeType in profileImageTypes)
        val handle = NSFileHandle.fileHandleForReadingFromURL(url, error = null) ?: error("Could not open file")
        val data = try {
            handle.readDataOfLength((limit + 1).toULong())
        } finally {
            handle.closeFile()
        }
        require(data.length in 1uL..limit.toULong())
        val bytes = ByteArray(data.length.toInt())
        bytes.usePinned { data.getBytes(it.addressOf(0), length = data.length) }
        return PickedAttachment(name, mimeType, bytes)
    } finally {
        NSFileManager.defaultManager.removeItemAtURL(url, error = null)
    }
}

internal actual suspend fun decodeAttachmentImage(bytes: ByteArray, maxDimension: Int?): ImageBitmap? = withContext(Dispatchers.Default) {
    try {
        val image = Image.makeFromEncoded(bytes)
        try {
            val dimension = maxOf(image.width, image.height)
            if (image.width.toLong() * image.height > 16L * 1024 * 1024) return@withContext null
            if (maxDimension == null || dimension <= maxDimension) return@withContext image.toComposeImageBitmap()
            val width = (image.width * maxDimension / dimension).coerceAtLeast(1)
            val height = (image.height * maxDimension / dimension).coerceAtLeast(1)
            val surface = Surface.makeRasterN32Premul(width, height)
            try {
                surface.canvas.drawImageRect(image, Rect.makeWH(width.toFloat(), height.toFloat()))
                val thumbnail = surface.makeImageSnapshot()
                try { thumbnail.toComposeImageBitmap() } finally { thumbnail.close() }
            } finally {
                surface.close()
            }
        } finally {
            image.close()
        }
    } catch (_: IllegalArgumentException) {
        null
    }
}

@Composable
@OptIn(kotlinx.cinterop.BetaInteropApi::class)
internal actual fun AttachmentAudio(bytes: ByteArray) {
    val player = remember(bytes) {
        val data = bytes.usePinned { NSData.create(bytes = it.addressOf(0), length = bytes.size.toULong()) }
        runCatching { AVAudioPlayer(data = data, error = null) }.getOrNull()
    }
    var playing by remember(bytes) { mutableStateOf(false) }
    var failed by remember(bytes) { mutableStateOf(false) }
    var position by remember(bytes) { mutableStateOf(0L) }
    val delegate = remember(player) {
        object : NSObject(), AVAudioPlayerDelegateProtocol {
            override fun audioPlayerDidFinishPlaying(player: AVAudioPlayer, successfully: Boolean) {
                playing = false
                failed = !successfully
                player.currentTime = 0.0
                position = 0
            }
        }
    }
    DisposableEffect(player, delegate) {
        player?.delegate = delegate
        onDispose {
            player?.delegate = null
            player?.stop()
        }
    }
    LaunchedEffect(player, playing) {
        if (player != null && playing) {
            while (player.playing) {
                position = (player.currentTime * 1000).toLong()
                delay(250)
            }
            playing = false
        }
    }
    if (player == null || failed) {
        Text("This audio file could not be played.")
    } else {
        AudioPlaybackControls(
            ready = true,
            playing = playing,
            positionMillis = position,
            durationMillis = (player.duration * 1000).toLong(),
            onToggle = {
                if (playing) {
                    player.pause()
                    position = (player.currentTime * 1000).toLong()
                    playing = false
                } else {
                    playing = player.play()
                    failed = !playing
                }
            },
            onSeek = { millis ->
                player.currentTime = millis / 1000.0
                position = (player.currentTime * 1000).toLong()
            },
        )
    }
}
