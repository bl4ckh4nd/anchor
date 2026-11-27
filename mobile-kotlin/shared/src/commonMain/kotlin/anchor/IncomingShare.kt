package anchor

import androidx.room.Entity
import androidx.room.Transactor
import androidx.room.useWriterConnection
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.IO
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

@Entity(tableName = "native_share_receipts", primaryKeys = ["origin", "userId", "id"])
internal data class NativeShareReceipt(val origin: String, val userId: String, val id: String)

internal data class IncomingShare(
    val id: String,
    val title: String,
    val text: String,
    val files: List<() -> PickedAttachment>,
    val link: String? = null,
    val savedAt: String? = null,
    val tagIds: List<String> = emptyList(),
)

internal suspend fun DraftDatabase.saveIncomingShare(account: AnchorSession, share: IncomingShare): PendingNote? =
    withContext(Dispatchers.IO) {
        val draft = PendingNote(
            account.origin, account.userId, share.id, share.title,
            content = "", deltaContent = shareNoteContent(share.text, share.link),
            flutterFields = share.savedAt?.let { buildJsonObject { put("createdAt", it) }.toString() },
        )
        useWriterConnection { writer ->
            writer.withTransaction(Transactor.SQLiteTransactionType.IMMEDIATE) {
                val drafts = drafts()
                if (drafts.recordShare(NativeShareReceipt(account.origin, account.userId, share.id)) == -1L) {
                    return@withTransaction null
                }
                drafts.enqueue(draft)
                for (read in share.files.asReversed()) {
                    attachmentOutbox().enqueue(account.origin, account.userId, share.id, read())
                }
                if (share.tagIds.isNotEmpty()) {
                    val payload = buildJsonObject {
                        put("type", "noteTags")
                        put("id", share.id)
                        put("tagIds", JsonArray(share.tagIds.distinct().map(::JsonPrimitive)))
                    }
                    legacyUpgrade().addMetadata(LegacyMetadataChange(
                        account.origin, account.userId, "noteTags", share.id, payload.toString(),
                    ))
                }
                draft
            }
        }
    }
