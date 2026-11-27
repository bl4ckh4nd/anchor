package anchor

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Process
import androidx.core.content.IntentCompat
import kotlin.uuid.Uuid
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update

class AndroidShareCallbacks {
    internal val pending = MutableStateFlow<List<IncomingShare>>(emptyList())

    fun accept(context: Context, intent: Intent) {
        val share = runCatching { readShare(context.applicationContext, intent) }.getOrNull() ?: return
        pending.update { if (it.size < 8) it + share else it }
    }

    private fun readShare(context: Context, intent: Intent): IncomingShare? {
        val multiple = when (intent.action) {
            Intent.ACTION_SEND -> false
            Intent.ACTION_SEND_MULTIPLE -> true
            else -> return null
        }
        val mime = intent.type ?: return null
        val media = mime.startsWith("image/") || mime.startsWith("audio/")
        if (!media && (mime != "text/plain" || multiple)) return null
        val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString().orEmpty()
        val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT).orEmpty()
        if (text.length > 128_000 || subject.length > 2048) return null
        val uris = if (!media) emptyList() else if (multiple) {
            IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java).orEmpty()
        } else {
            listOfNotNull(IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java))
        }
        val files = if (media && uris.isEmpty()) {
            val clip = intent.clipData
            if (clip == null) emptyList() else {
                if (clip.itemCount > 20) return null
                List(clip.itemCount) { clip.getItemAt(it).uri ?: return null }
            }
        } else uris
        if (media && files.isEmpty() || files.size > 20 || text.isBlank() && files.isEmpty()) return null
        if (files.any { uri ->
                val authority = uri.authority
                uri.scheme != "content" || authority.isNullOrBlank() ||
                    context.packageManager.resolveContentProvider(authority, 0)?.packageName == context.packageName ||
                    context.checkUriPermission(uri, Process.myPid(), Process.myUid(), Intent.FLAG_GRANT_READ_URI_PERMISSION) !=
                    PackageManager.PERMISSION_GRANTED
            }) return null
        return IncomingShare(
            Uuid.random().toString(), subject.ifBlank { "Shared note" }, text,
            files.map { uri -> { readAndroidAttachment(context.contentResolver, uri) } },
        )
    }
}
