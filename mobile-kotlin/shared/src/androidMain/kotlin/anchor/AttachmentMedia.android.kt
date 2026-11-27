package anchor

import android.Manifest
import android.app.Activity
import android.content.ClipData
import android.content.ContentResolver
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.graphics.BitmapFactory
import android.media.MediaDataSource
import android.media.MediaPlayer
import android.media.MediaScannerConnection
import android.os.Build
import android.os.Environment
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
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
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.FileProvider
import java.io.ByteArrayOutputStream
import java.io.File
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine
import kotlin.time.Duration.Companion.days
import kotlin.uuid.Uuid
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class AttachmentShareProvider : FileProvider()

@Composable
internal actual fun rememberTransferAttachment(
    onResult: (AttachmentTransfer, Result<Boolean>) -> Unit,
): (CachedAttachment, AttachmentTransfer, suspend () -> ByteArray) -> Unit {
    val context = LocalContext.current
    val resolver = context.contentResolver
    val scope = rememberCoroutineScope()
    val deliver by rememberUpdatedState(onResult)
    var load by remember { mutableStateOf<(suspend () -> ByteArray)?>(null) }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val download = load
        load = null
        val uri = result.data?.data?.takeIf { result.resultCode == Activity.RESULT_OK }
        if (uri == null) {
            deliver(AttachmentTransfer.Download, Result.success(false))
            return@rememberLauncherForActivityResult
        }
        scope.launch {
            try {
                val bytes = checkNotNull(download)().also { require(it.isNotEmpty()) }
                withContext(Dispatchers.IO) {
                    checkNotNull(resolver.openOutputStream(uri)).use { it.write(bytes) }
                }
                deliver(AttachmentTransfer.Download, Result.success(true))
            } catch (error: Exception) {
                withContext(NonCancellable + Dispatchers.IO) {
                    runCatching { DocumentsContract.deleteDocument(resolver, uri) }
                }
                if (error is CancellationException) throw error
                deliver(AttachmentTransfer.Download, Result.failure(error))
            }
        }
    }
    val shared = remember(context) { File(context.cacheDir, "shared-attachments") }
    fun removeExpiredShares() {
        val cutoff = System.currentTimeMillis() - 1.days.inWholeMilliseconds
        shared.listFiles()?.filter { it.lastModified() < cutoff }?.forEach { it.deleteRecursively() }
    }
    LaunchedEffect(shared) { withContext(Dispatchers.IO) { removeExpiredShares() } }
    fun savePhoto(file: CachedAttachment, download: suspend () -> ByteArray) {
        scope.launch {
            try {
                val bytes = download().also { require(it.isNotEmpty()) }
                withContext(Dispatchers.IO) { saveAndroidPhoto(context, file, bytes) }
                deliver(AttachmentTransfer.Photo, Result.success(true))
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                deliver(AttachmentTransfer.Photo, Result.failure(error))
            }
        }
    }
    var afterPhotoPermission by remember { mutableStateOf<(() -> Unit)?>(null) }
    val photoPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val save = afterPhotoPermission
        afterPhotoPermission = null
        if (granted && save != null) save()
        else deliver(AttachmentTransfer.Photo, Result.failure(PhotoPermissionDenied()))
    }
    return { file, action, download ->
        if (action == AttachmentTransfer.Photo) {
            if (Build.VERSION.SDK_INT < 29 &&
                context.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED
            ) {
                afterPhotoPermission = { savePhoto(file, download) }
                try {
                    photoPermission.launch(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                } catch (error: Exception) {
                    afterPhotoPermission = null
                    deliver(action, Result.failure(error))
                }
            } else {
                savePhoto(file, download)
            }
        } else if (action == AttachmentTransfer.Share) {
            scope.launch {
                val directory = File(shared, Uuid.random().toString())
                try {
                    val bytes = download().also { require(it.isNotEmpty()) }
                    val target = File(directory, attachmentExportName(file.originalFilename))
                    withContext(Dispatchers.IO) {
                        removeExpiredShares()
                        check(directory.mkdirs())
                        target.writeBytes(bytes)
                    }
                    val uri = FileProvider.getUriForFile(context, "${context.packageName}.shared-attachments", target)
                    val send = Intent(Intent.ACTION_SEND).apply {
                        type = file.mimeType
                        putExtra(Intent.EXTRA_STREAM, uri)
                        clipData = ClipData.newRawUri(target.name, uri)
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    }
                    context.startActivity(Intent.createChooser(send, null))
                    deliver(action, Result.success(false))
                } catch (error: Exception) {
                    withContext(NonCancellable + Dispatchers.IO) { directory.deleteRecursively() }
                    if (error is CancellationException) throw error
                    deliver(action, Result.failure(error))
                }
            }
        } else {
            load = download
            try {
                picker.launch(Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = file.mimeType
                    putExtra(Intent.EXTRA_TITLE, attachmentExportName(file.originalFilename))
                })
            } catch (error: Exception) {
                load = null
                deliver(action, Result.failure(error))
            }
        }
    }
}

private suspend fun saveAndroidPhoto(context: Context, file: CachedAttachment, bytes: ByteArray) {
    require(file.mimeType.startsWith("image/"))
    val name = attachmentExportName(file.originalFilename)
    if (Build.VERSION.SDK_INT < 29) {
        saveLegacyAndroidPhoto(context, name, file.mimeType, bytes)
        return
    }
    val resolver = context.contentResolver
    val values = ContentValues().apply {
        put(MediaStore.MediaColumns.DISPLAY_NAME, name)
        put(MediaStore.MediaColumns.MIME_TYPE, file.mimeType)
        put(MediaStore.MediaColumns.RELATIVE_PATH, "${Environment.DIRECTORY_PICTURES}/Anchor")
        put(MediaStore.MediaColumns.IS_PENDING, 1)
    }
    val uri = checkNotNull(resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values))
    try {
        checkNotNull(resolver.openOutputStream(uri)).use { it.write(bytes) }
        val ready = ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }
        check(resolver.update(uri, ready, null, null) == 1)
    } catch (error: Exception) {
        runCatching { resolver.delete(uri, null, null) }
        throw error
    }
}

@Suppress("DEPRECATION")
private suspend fun saveLegacyAndroidPhoto(context: Context, name: String, mime: String, bytes: ByteArray) {
    val folder = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), "Anchor")
    check(folder.mkdirs() || folder.isDirectory)
    val original = File(folder, name)
    val target = if (original.createNewFile()) original
        else File.createTempFile("Anchor-", ".${name.substringAfterLast('.', "image")}", folder)
    try {
        target.writeBytes(bytes)
        val uri = suspendCoroutine<Uri?> { continuation ->
            MediaScannerConnection.scanFile(context, arrayOf(target.path), arrayOf(mime)) { _, item ->
                continuation.resume(item)
            }
        }
        checkNotNull(uri)
    } catch (error: Exception) {
        target.delete()
        throw error
    }
}

@Composable
internal actual fun rememberPickAttachment(
    profileImage: Boolean,
    onResult: (Result<PickedAttachment?>) -> Unit,
): () -> Unit {
    val resolver = LocalContext.current.contentResolver
    val scope = rememberCoroutineScope()
    val deliver by rememberUpdatedState(onResult)
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri == null) {
            deliver(Result.success(null))
        } else {
            scope.launch {
                try {
                    val file = withContext(Dispatchers.IO) {
                        readAndroidAttachment(resolver, uri, profileImage)
                    }
                    deliver(Result.success(file))
                } catch (error: CancellationException) {
                    throw error
                } catch (error: Exception) {
                    deliver(Result.failure(error))
                }
            }
        }
    }
    return { picker.launch(if (profileImage) profileImageTypes.toTypedArray() else arrayOf("image/*", "audio/*")) }
}

internal fun readAndroidAttachment(resolver: ContentResolver, uri: Uri, profileImage: Boolean = false): PickedAttachment {
    val limit = if (profileImage) maxProfileImageBytes else maxAttachmentBytes
    val name = resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
        ?.use { if (it.moveToFirst()) it.getString(0) else null }
        ?: error("Missing filename")
    val mimeType = attachmentMimeType(name, resolver.getType(uri)) ?: error("Unsupported file type")
    require(!profileImage || mimeType in profileImageTypes)
    val input = resolver.openInputStream(uri) ?: error("Could not open file")
    val bytes = input.use {
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(64 * 1024)
        while (true) {
            val count = it.read(buffer)
            if (count == -1) break
            require(out.size() + count <= limit)
            out.write(buffer, 0, count)
        }
        require(out.size() > 0)
        out.toByteArray()
    }
    return PickedAttachment(name, mimeType, bytes)
}

internal actual suspend fun decodeAttachmentImage(bytes: ByteArray, maxDimension: Int?) = withContext(Dispatchers.Default) {
    val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
    val dimension = maxOf(options.outWidth, options.outHeight)
    if (dimension <= 0) return@withContext null
    options.inJustDecodeBounds = false
    options.inSampleSize = 1
    while (dimension / options.inSampleSize > (maxDimension ?: 2048)) options.inSampleSize *= 2
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)?.asImageBitmap()
}

@Composable
internal actual fun AttachmentAudio(bytes: ByteArray) {
    var player by remember(bytes) { mutableStateOf<MediaPlayer?>(null) }
    var playing by remember(bytes) { mutableStateOf(false) }
    var failed by remember(bytes) { mutableStateOf(false) }
    var position by remember(bytes) { mutableStateOf(0L) }
    var seeking by remember(bytes) { mutableStateOf(false) }
    DisposableEffect(bytes) {
        val audio = MediaPlayer()
        try {
            audio.setDataSource(object : MediaDataSource() {
                override fun getSize() = bytes.size.toLong()
                override fun readAt(position: Long, buffer: ByteArray, offset: Int, size: Int): Int {
                    if (size == 0) return 0
                    if (position !in 0 until bytes.size.toLong()) return -1
                    val start = position.toInt()
                    val count = minOf(size, bytes.size - start)
                    bytes.copyInto(buffer, offset, start, start + count)
                    return count
                }
                override fun close() = Unit
            })
            audio.setOnPreparedListener { player = it }
            audio.setOnCompletionListener {
                playing = false
                position = 0
            }
            audio.setOnSeekCompleteListener {
                position = it.currentPosition.toLong()
                seeking = false
            }
            audio.setOnErrorListener { _, _, _ ->
                failed = true
                playing = false
                true
            }
            audio.prepareAsync()
        } catch (_: Exception) {
            failed = true
        }
        onDispose { audio.release() }
    }
    val audio = player
    LaunchedEffect(audio, playing) {
        while (audio != null && playing) {
            if (!seeking) position = audio.currentPosition.toLong()
            delay(250)
        }
    }
    if (failed) {
        Text("This audio file could not be played.")
    } else {
        AudioPlaybackControls(
            ready = audio != null,
            playing = playing,
            positionMillis = position,
            durationMillis = audio?.duration?.toLong()?.coerceAtLeast(0) ?: 0,
            onToggle = {
                if (audio != null) {
                    if (playing) {
                        audio.pause()
                        position = audio.currentPosition.toLong()
                    } else audio.start()
                    playing = !playing
                }
            },
            onSeek = { millis ->
                if (audio != null) {
                    seeking = true
                    if (Build.VERSION.SDK_INT >= 26) audio.seekTo(millis, MediaPlayer.SEEK_CLOSEST)
                    else audio.seekTo(millis.toInt())
                }
            },
        )
    }
}
