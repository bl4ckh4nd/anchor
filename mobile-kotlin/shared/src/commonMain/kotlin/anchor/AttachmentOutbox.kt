package anchor

import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index
import androidx.room.Insert
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Transaction
import kotlin.uuid.Uuid
import kotlinx.coroutines.flow.Flow

internal const val attachmentPartSize = 256 * 1024

@Entity(
    tableName = "pending_attachment_uploads",
    indices = [Index(value = ["origin", "userId", "noteId"])],
)
internal data class PendingAttachmentUpload(
    @PrimaryKey val id: String,
    val origin: String,
    val userId: String,
    val noteId: String,
    val filename: String,
    val mimeType: String,
    val fileSize: Int,
    val rejected: Boolean = false,
    @ColumnInfo(defaultValue = "0") val retainOnMissingNote: Boolean = false,
    val outboxScope: String? = null,
    @ColumnInfo(defaultValue = "0") val deferUntilRestored: Boolean = false,
)

@Entity(
    tableName = "pending_attachment_parts",
    primaryKeys = ["uploadId", "partNumber"],
    foreignKeys = [ForeignKey(
        entity = PendingAttachmentUpload::class,
        parentColumns = ["id"],
        childColumns = ["uploadId"],
        onDelete = ForeignKey.CASCADE,
    )],
)
internal data class PendingAttachmentPart(val uploadId: String, val partNumber: Int, val bytes: ByteArray)

@Dao
internal abstract class AttachmentOutbox {
    @Query("SELECT * FROM pending_attachment_uploads WHERE origin = :origin AND userId = :userId ORDER BY rowid")
    abstract fun observe(origin: String, userId: String): Flow<List<PendingAttachmentUpload>>

    @Query("""
        SELECT * FROM pending_attachment_uploads AS upload
        WHERE upload.origin = :origin AND upload.userId = :userId AND upload.rejected = 0
        AND NOT EXISTS (
            SELECT 1 FROM pending_notes AS note
            WHERE note.origin = upload.origin AND note.userId = upload.userId
            AND note.id = upload.noteId AND note.baseVersion IS NULL
        )
        AND (upload.deferUntilRestored = 0 OR EXISTS (
            SELECT 1 FROM cached_notes AS note
            WHERE note.origin = upload.origin AND note.userId = upload.userId
            AND note.id = upload.noteId AND note.isTrashed = 0 AND note.canEdit = 1
        ))
        ORDER BY upload.rowid
    """)
    abstract fun observeReady(origin: String, userId: String): Flow<List<PendingAttachmentUpload>>

    @Query("SELECT * FROM pending_attachment_uploads WHERE origin = :origin AND userId = :userId AND noteId = :noteId ORDER BY rowid")
    abstract fun observeNote(origin: String, userId: String, noteId: String): Flow<List<PendingAttachmentUpload>>

    @Insert
    protected abstract suspend fun insertUpload(upload: PendingAttachmentUpload)

    @Query(outboxScopeSql)
    protected abstract suspend fun scope(origin: String, userId: String): String?

    @Insert
    protected abstract suspend fun insertPart(part: PendingAttachmentPart)

    @Query("""
        SELECT part.bytes FROM pending_attachment_parts AS part
        JOIN pending_attachment_uploads AS upload ON upload.id = part.uploadId
        WHERE upload.origin = :origin AND upload.userId = :userId
            AND upload.id = :id AND part.partNumber = :partNumber
    """)
    abstract suspend fun readPart(origin: String, userId: String, id: String, partNumber: Int): ByteArray?

    @Query("DELETE FROM pending_attachment_uploads WHERE origin = :origin AND userId = :userId AND id = :id")
    abstract suspend fun discard(origin: String, userId: String, id: String): Int

    @Query("""
        DELETE FROM pending_attachment_uploads
        WHERE origin = :origin AND userId = :userId AND noteId = :noteId
            AND retainOnMissingNote = 0
            AND EXISTS (
                SELECT 1 FROM pending_notes
                WHERE origin = :origin AND userId = :userId AND id = :noteId AND baseVersion IS NULL
            )
    """)
    abstract suspend fun discardPendingNoteUploads(origin: String, userId: String, noteId: String)

    @Query("DELETE FROM pending_attachment_uploads WHERE origin = :origin AND userId = :userId")
    abstract suspend fun clearAccount(origin: String, userId: String)

    @Query("UPDATE pending_attachment_uploads SET rejected = 1 WHERE origin = :origin AND userId = :userId AND id = :id")
    abstract suspend fun reject(origin: String, userId: String, id: String)

    open suspend fun enqueue(note: CachedNote, file: PickedAttachment) = enqueue(note.origin, note.userId, note.id, file)

    open suspend fun enqueue(origin: String, userId: String, noteId: String, file: PickedAttachment) {
        val id = Uuid.random().toString()
        val upload = PendingAttachmentUpload(id, origin, userId, noteId, file.name, file.mimeType, file.bytes.size)
        enqueue(upload) { offset, length ->
            file.bytes.copyOfRange(offset, offset + length)
        }
    }

    @Transaction
    open suspend fun enqueue(upload: PendingAttachmentUpload, read: (offset: Int, length: Int) -> ByteArray) {
        require(upload.fileSize in 1..maxAttachmentBytes)
        insertUpload(upload.copy(outboxScope = scope(upload.origin, upload.userId)))
        for ((partNumber, offset) in (0 until upload.fileSize step attachmentPartSize).withIndex()) {
            val length = minOf(attachmentPartSize, upload.fileSize - offset)
            val bytes = read(offset, length)
            require(bytes.size == length)
            insertPart(PendingAttachmentPart(upload.id, partNumber, bytes))
        }
    }
}
