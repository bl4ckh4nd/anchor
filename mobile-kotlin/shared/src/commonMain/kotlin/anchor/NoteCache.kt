package anchor

import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index
import androidx.room.Insert
import androidx.room.Query
import androidx.room.Transaction
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

internal enum class NoteFolder { Notes, Archive, Trash }

internal data class SearchTag(val noteId: String, val tagId: String, val name: String)

@Entity(tableName = "cached_notes", primaryKeys = ["origin", "userId", "id"])
internal data class CachedNote(
    val origin: String,
    val userId: String,
    val id: String,
    val title: String,
    val content: String?,
    val version: Long,
    @ColumnInfo(defaultValue = "0") val isPinned: Boolean = false,
    val remindAt: String? = null,
    val reminderRecurrence: String? = null,
    val reminderVersion: Long? = null,
    val position: String? = null,
    val background: String? = null,
    val updatedAt: String? = null,
    val createdAt: Long? = null,
    @ColumnInfo(defaultValue = "0") val canEdit: Boolean = false,
    @ColumnInfo(defaultValue = "0") val isOwner: Boolean = false,
    @ColumnInfo(defaultValue = "0") val isArchived: Boolean = false,
    @ColumnInfo(defaultValue = "0") val isTrashed: Boolean = false,
) {
    val folder: NoteFolder
        get() = when {
            isTrashed -> NoteFolder.Trash
            isArchived -> NoteFolder.Archive
            else -> NoteFolder.Notes
        }
}

@Entity(tableName = "note_checkpoints", primaryKeys = ["origin", "userId"])
internal data class NoteCheckpoint(val origin: String, val userId: String, val cursor: String, val outboxScope: String? = null)

internal const val outboxScopeSql = "SELECT outboxScope FROM note_checkpoints WHERE origin = :origin AND userId = :userId"

@Entity(tableName = "cached_tags", primaryKeys = ["origin", "userId", "id"])
internal data class CachedTag(
    val origin: String,
    val userId: String,
    val id: String,
    val name: String,
    val color: String?,
    val position: String?,
    val version: Long,
)

@Entity(
    tableName = "cached_note_tags",
    primaryKeys = ["origin", "userId", "noteId", "tagId"],
    indices = [Index(value = ["origin", "userId", "tagId"])],
)
internal data class CachedNoteTag(val origin: String, val userId: String, val noteId: String, val tagId: String)

@Entity(tableName = "cached_attachments", primaryKeys = ["origin", "userId", "noteId", "id"])
internal data class CachedAttachment(
    val origin: String,
    val userId: String,
    val noteId: String,
    val id: String,
    val type: String,
    val originalFilename: String,
    val mimeType: String,
    val fileSize: Long,
    val uploadedByUserId: String,
    val createdAt: String,
    @ColumnInfo(defaultValue = "0") val position: Int,
)

internal fun CachedAttachment.matchesFile(other: CachedAttachment?): Boolean =
    other != null && copy(position = other.position) == other

@Entity(
    tableName = "cached_attachment_parts",
    primaryKeys = ["origin", "userId", "noteId", "attachmentId", "partNumber"],
    foreignKeys = [ForeignKey(
        entity = CachedAttachment::class,
        parentColumns = ["origin", "userId", "noteId", "id"],
        childColumns = ["origin", "userId", "noteId", "attachmentId"],
        onDelete = ForeignKey.CASCADE,
    )],
)
internal data class CachedAttachmentPart(
    val origin: String,
    val userId: String,
    val noteId: String,
    val attachmentId: String,
    val partNumber: Int,
    val bytes: ByteArray,
)

private const val maxCachedAttachmentBytes = 500L * 1024 * 1024

internal data class CachedReminder(val remindAt: String, val recurrence: String, val version: Long)

internal sealed interface FeedEntry {
    data class Upsert(
        val note: CachedNote,
        val tagIds: List<String>,
        val attachments: List<CachedAttachment>,
    ) : FeedEntry
    data class Remove(val id: String) : FeedEntry
    data class Pin(val id: String, val isPinned: Boolean) : FeedEntry
    data class Reminder(val id: String, val reminder: CachedReminder?) : FeedEntry
    data class TagUpsert(val tag: CachedTag) : FeedEntry
    data class TagRemove(val id: String) : FeedEntry
}

internal sealed interface NoteFeedPage {
    data object Reset : NoteFeedPage
    data class Data(val cursor: String, val hasMore: Boolean, val entries: List<FeedEntry>, val scope: String? = null) : NoteFeedPage
}

@Dao
internal abstract class NoteCacheDao {
    @Query("SELECT * FROM cached_notes WHERE origin = :origin AND userId = :userId ORDER BY isPinned DESC, position IS NOT NULL, position COLLATE BINARY, title, id")
    abstract suspend fun list(origin: String, userId: String): List<CachedNote>

    @Query("SELECT * FROM cached_tags WHERE origin = :origin AND userId = :userId ORDER BY position IS NULL, position, name, id")
    abstract fun tags(origin: String, userId: String): Flow<List<CachedTag>>

    @Query("SELECT tagId FROM cached_note_tags WHERE origin = :origin AND userId = :userId AND noteId = :noteId")
    abstract fun assignedTags(origin: String, userId: String, noteId: String): Flow<List<String>>

    @Query("""
        SELECT assignment.noteId, assignment.tagId, tag.name
        FROM cached_note_tags AS assignment
        JOIN cached_tags AS tag ON tag.origin = assignment.origin
            AND tag.userId = assignment.userId AND tag.id = assignment.tagId
        WHERE assignment.origin = :origin AND assignment.userId = :userId
    """)
    abstract fun searchTags(origin: String, userId: String): Flow<List<SearchTag>>

    @Query("SELECT * FROM cached_attachments WHERE origin = :origin AND userId = :userId AND noteId = :noteId ORDER BY position, createdAt, id")
    abstract fun attachments(origin: String, userId: String, noteId: String): Flow<List<CachedAttachment>>

    @Query("SELECT cursor FROM note_checkpoints WHERE origin = :origin AND userId = :userId")
    abstract suspend fun cursor(origin: String, userId: String): String?

    @Query(outboxScopeSql)
    abstract suspend fun scope(origin: String, userId: String): String?

    @Upsert
    protected abstract suspend fun upsert(note: CachedNote)

    @Upsert
    protected abstract suspend fun upsertTag(tag: CachedTag)

    @Insert
    protected abstract suspend fun insertInitialNotes(notes: List<CachedNote>)

    @Insert
    protected abstract suspend fun insertInitialTags(tags: List<CachedTag>)

    @Insert
    protected abstract suspend fun insertNoteTags(tags: List<CachedNoteTag>)

    @Insert
    protected abstract suspend fun insertAttachments(attachments: List<CachedAttachment>)

    @Upsert
    protected abstract suspend fun upsertAttachments(attachments: List<CachedAttachment>)

    @Query("SELECT * FROM cached_attachments WHERE origin = :origin AND userId = :userId AND noteId = :noteId")
    protected abstract suspend fun attachmentSnapshot(origin: String, userId: String, noteId: String): List<CachedAttachment>

    @Query("SELECT * FROM cached_attachments WHERE origin = :origin AND userId = :userId AND noteId = :noteId AND id = :id")
    protected abstract suspend fun attachment(origin: String, userId: String, noteId: String, id: String): CachedAttachment?

    @Query("DELETE FROM cached_attachments WHERE origin = :origin AND userId = :userId AND noteId = :noteId AND id = :id")
    protected abstract suspend fun removeAttachment(origin: String, userId: String, noteId: String, id: String)

    @Insert
    protected abstract suspend fun insertCachedPart(part: CachedAttachmentPart)

    @Query("""
        SELECT bytes FROM cached_attachment_parts
        WHERE origin = :origin AND userId = :userId AND noteId = :noteId
            AND attachmentId = :id AND partNumber = :number
    """)
    protected abstract suspend fun cachedPart(origin: String, userId: String, noteId: String, id: String, number: Int): ByteArray?

    @Query("DELETE FROM cached_attachment_parts WHERE origin = :origin AND userId = :userId AND noteId = :noteId AND attachmentId = :id")
    protected abstract suspend fun forgetCachedParts(origin: String, userId: String, noteId: String, id: String)

    @Query("SELECT COALESCE(SUM(length(bytes)), 0) FROM cached_attachment_parts")
    protected abstract suspend fun cachedBytes(): Long

    @Query("""
        DELETE FROM cached_attachment_parts
        WHERE (origin, userId, noteId, attachmentId) IN (
            SELECT origin, userId, noteId, attachmentId
            FROM cached_attachment_parts ORDER BY rowid LIMIT 1
        )
    """)
    protected abstract suspend fun evictOldestAttachment(): Int

    @Transaction
    open suspend fun readCachedAttachment(file: CachedAttachment): ByteArray? {
        if (file.fileSize !in 1L..maxAttachmentBytes.toLong() ||
            !file.matchesFile(attachment(file.origin, file.userId, file.noteId, file.id))
        ) return null
        var part = cachedPart(file.origin, file.userId, file.noteId, file.id, 0) ?: return null
        val bytes = ByteArray(file.fileSize.toInt())
        for ((number, offset) in (0 until bytes.size step attachmentPartSize).withIndex()) {
            if (number > 0) part = cachedPart(file.origin, file.userId, file.noteId, file.id, number) ?: return null
            if (part.size != minOf(attachmentPartSize, bytes.size - offset)) return null
            part.copyInto(bytes, destinationOffset = offset)
        }
        return bytes
    }

    @Transaction
    open suspend fun stillHasAttachment(file: CachedAttachment, expectedScope: String?): Boolean =
        scope(file.origin, file.userId) == expectedScope &&
            file.matchesFile(attachment(file.origin, file.userId, file.noteId, file.id))

    @Transaction
    open suspend fun discardUnavailableAttachment(file: CachedAttachment, expectedScope: String?) {
        if (stillHasAttachment(file, expectedScope)) removeAttachment(file.origin, file.userId, file.noteId, file.id)
    }

    @Transaction
    open suspend fun cacheAttachment(file: CachedAttachment, expectedScope: String?, bytes: ByteArray): Boolean {
        require(bytes.size.toLong() == file.fileSize && bytes.size in 1..maxAttachmentBytes)
        if (!stillHasAttachment(file, expectedScope)) return false
        if (expectedScope == null) return true
        forgetCachedParts(file.origin, file.userId, file.noteId, file.id)
        while (cachedBytes() + bytes.size > maxCachedAttachmentBytes) check(evictOldestAttachment() > 0)
        for ((number, offset) in (0 until bytes.size step attachmentPartSize).withIndex()) {
            val chunk = bytes.copyOfRange(offset, minOf(offset + attachmentPartSize, bytes.size))
            insertCachedPart(CachedAttachmentPart(file.origin, file.userId, file.noteId, file.id, number, chunk))
        }
        return true
    }

    @Query("DELETE FROM cached_attachments WHERE origin = :origin AND userId = :userId AND noteId = :id")
    protected abstract suspend fun removeAttachments(origin: String, userId: String, id: String)

    @Query("DELETE FROM cached_attachments WHERE origin = :origin AND userId = :userId")
    protected abstract suspend fun clearAttachments(origin: String, userId: String)

    @Query("DELETE FROM cached_note_tags WHERE origin = :origin AND userId = :userId AND noteId = :id")
    protected abstract suspend fun removeTagsFromNote(origin: String, userId: String, id: String)

    @Query("DELETE FROM cached_note_tags WHERE origin = :origin AND userId = :userId AND tagId = :id")
    protected abstract suspend fun removeTagFromNotes(origin: String, userId: String, id: String)

    @Query("DELETE FROM cached_note_tags WHERE origin = :origin AND userId = :userId")
    protected abstract suspend fun clearNoteTags(origin: String, userId: String)

    @Query("DELETE FROM cached_tags WHERE origin = :origin AND userId = :userId AND id = :id")
    protected abstract suspend fun removeTag(origin: String, userId: String, id: String)

    @Query("DELETE FROM cached_tags WHERE origin = :origin AND userId = :userId")
    protected abstract suspend fun clearTags(origin: String, userId: String)

    @Upsert
    protected abstract suspend fun saveCheckpoint(checkpoint: NoteCheckpoint)

    @Query("UPDATE cached_notes SET isPinned = :isPinned WHERE origin = :origin AND userId = :userId AND id = :id")
    protected abstract suspend fun pin(origin: String, userId: String, id: String, isPinned: Boolean)

    @Query("""
        UPDATE cached_notes
        SET remindAt = :remindAt, reminderRecurrence = :recurrence, reminderVersion = :version
        WHERE origin = :origin AND userId = :userId AND id = :id
    """)
    protected abstract suspend fun setReminder(
        origin: String, userId: String, id: String, remindAt: String?, recurrence: String?, version: Long?,
    )

    @Query("DELETE FROM cached_notes WHERE origin = :origin AND userId = :userId AND id = :id")
    protected abstract suspend fun remove(origin: String, userId: String, id: String)

    @Query("DELETE FROM cached_notes WHERE origin = :origin AND userId = :userId")
    protected abstract suspend fun clearNotes(origin: String, userId: String)

    @Query("DELETE FROM note_checkpoints WHERE origin = :origin AND userId = :userId")
    abstract suspend fun clearCheckpoint(origin: String, userId: String)

    @Query("UPDATE note_checkpoints SET cursor = '' WHERE origin = :origin AND userId = :userId")
    protected abstract suspend fun clearCursor(origin: String, userId: String)

    @Query("UPDATE pending_notes SET outboxScope = :scope WHERE origin = :origin AND userId = :userId AND outboxScope IS NULL")
    protected abstract suspend fun bindDrafts(origin: String, userId: String, scope: String)

    @Query("UPDATE pending_attachment_uploads SET outboxScope = :scope WHERE origin = :origin AND userId = :userId AND outboxScope IS NULL")
    protected abstract suspend fun bindUploads(origin: String, userId: String, scope: String)

    @Query("UPDATE legacy_metadata_changes SET outboxScope = :scope WHERE origin = :origin AND userId = :userId AND outboxScope IS NULL")
    protected abstract suspend fun bindLegacyChanges(origin: String, userId: String, scope: String)

    @Transaction
    open suspend fun applyPage(origin: String, userId: String, page: NoteFeedPage.Data) {
        if (cursor(origin, userId).isNullOrEmpty()) reset(origin, userId)
        for (entry in page.entries) {
            when (entry) {
                is FeedEntry.Upsert -> {
                    upsert(entry.note)
                    removeTagsFromNote(origin, userId, entry.note.id)
                    insertNoteTags(entry.tagIds.map { CachedNoteTag(origin, userId, entry.note.id, it) })
                    val byId = entry.attachments.associateBy(CachedAttachment::id)
                    for (previous in attachmentSnapshot(origin, userId, entry.note.id)) {
                        if (!previous.matchesFile(byId[previous.id])) {
                            removeAttachment(origin, userId, entry.note.id, previous.id)
                        }
                    }
                    upsertAttachments(entry.attachments)
                }
                is FeedEntry.Remove -> {
                    removeTagsFromNote(origin, userId, entry.id)
                    removeAttachments(origin, userId, entry.id)
                    remove(origin, userId, entry.id)
                }
                is FeedEntry.Pin -> pin(origin, userId, entry.id, entry.isPinned)
                is FeedEntry.TagUpsert -> upsertTag(entry.tag)
                is FeedEntry.TagRemove -> {
                    removeTagFromNotes(origin, userId, entry.id)
                    removeTag(origin, userId, entry.id)
                }
                is FeedEntry.Reminder -> setReminder(
                    origin, userId, entry.id, entry.reminder?.remindAt,
                    entry.reminder?.recurrence, entry.reminder?.version,
                )
            }
        }
        val previousScope = scope(origin, userId)
        if (page.scope != null && previousScope != page.scope) {
            bindDrafts(origin, userId, page.scope)
            bindUploads(origin, userId, page.scope)
            bindLegacyChanges(origin, userId, page.scope)
        }
        saveCheckpoint(NoteCheckpoint(origin, userId, page.cursor, page.scope ?: previousScope))
    }

    @Transaction
    open suspend fun seedFromFlutter(
        origin: String,
        userId: String,
        entries: List<FeedEntry.Upsert>,
        tags: List<CachedTag>,
    ) {
        if (cursor(origin, userId) != null) return
        reset(origin, userId)
        insertInitialNotes(entries.map { it.note })
        insertInitialTags(tags)
        insertNoteTags(entries.flatMap { entry ->
            entry.tagIds.map { CachedNoteTag(origin, userId, entry.note.id, it) }
        })
        insertAttachments(entries.flatMap { it.attachments })
    }

    @Transaction
    open suspend fun reset(origin: String, userId: String) {
        clearNotes(origin, userId)
        clearTags(origin, userId)
        clearNoteTags(origin, userId)
        clearAttachments(origin, userId)
        clearCursor(origin, userId)
    }
}
