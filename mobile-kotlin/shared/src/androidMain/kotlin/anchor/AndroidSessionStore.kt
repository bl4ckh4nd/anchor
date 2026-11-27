package anchor

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import java.io.File
import java.io.FileNotFoundException
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONObject

private val sessionWrites = Mutex()

internal fun androidSessionFile(context: Context) = File(context.noBackupFilesDir, "anchor-session")

internal class AndroidSessionStore(private val context: Context, private val serverHeaders: Boolean = false) : SessionStore {
    private val file = AtomicFile(
        if (serverHeaders) File(context.noBackupFilesDir, "anchor-server-headers") else androidSessionFile(context),
    )
    private val alias = if (serverHeaders) "anchor.server-headers.v1" else "anchor.session.v1"

    override suspend fun read(): ByteArray? = withContext(Dispatchers.IO) { readRecord() }

    private fun readRecord(): ByteArray? {
        val record = try {
            file.readFully()
        } catch (missing: FileNotFoundException) {
            if (file.baseFile.exists()) throw missing
            return null
        }
        check(record.size > 29 && record[0] == 1.toByte())
        val key = keyStore().getKey(alias, null) as? SecretKey ?: return null
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, record, 1, 12))
        return cipher.doFinal(record, 13, record.size - 13)
    }

    override suspend fun write(value: ByteArray) = withContext(Dispatchers.IO) {
        sessionWrites.withLock { writeRecord(value) }
    }

    private fun writeRecord(value: ByteArray) {
        if (!serverHeaders) {
            val next = JSONObject(value.decodeToString())
            val widget = AndroidWidgetNotes.read(context)
            if (widget != null && !next.matchesAccount(widget.origin, widget.userId)) {
                AndroidWidgetNotes.clear(context)
            }
        }
        val key = keyStore().getKey(alias, null) as? SecretKey ?: createKey()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key)
        check(cipher.iv.size == 12)
        val ciphertext = cipher.doFinal(value)
        val output = file.startWrite()
        try {
            output.write(1)
            output.write(cipher.iv)
            output.write(ciphertext)
            file.finishWrite(output)
        } catch (error: Throwable) {
            file.failWrite(output)
            throw error
        }
    }

    override suspend fun clear() = withContext(Dispatchers.IO) {
        sessionWrites.withLock {
            if (!serverHeaders) AndroidWidgetNotes.clear(context)
            file.delete()
            check(!file.baseFile.exists())
            if (!serverHeaders) runCatching { AndroidReminders.publish(context, null, emptyList()) }
            Unit
        }
    }

    suspend fun publishWidget(session: AnchorSession?, notes: List<CachedNote>) = withContext(Dispatchers.IO) {
        sessionWrites.withLock {
            val record = runCatching { readRecord()?.let { JSONObject(it.decodeToString()) } }.getOrNull()
            if (session != null && record?.matchesAccount(session.origin, session.userId) == true) {
                AndroidWidgetNotes.publish(context, session, notes)
            } else if (record?.has("refresh_token") != true) {
                AndroidWidgetNotes.clear(context)
            }
        }
    }

    private fun JSONObject.matchesAccount(origin: String, userId: String): Boolean =
        has("refresh_token") && optString("origin") == origin && optString("userId") == userId

    private fun keyStore() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private fun createKey(): SecretKey =
        KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(
                KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build(),
            )
        }.generateKey()
}
