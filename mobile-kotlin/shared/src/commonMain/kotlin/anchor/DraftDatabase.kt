package anchor

import androidx.room.AutoMigration
import androidx.room.ColumnInfo
import androidx.room.ConstructedBy
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.RoomDatabase
import androidx.room.RoomDatabaseConstructor
import androidx.room.Transaction
import androidx.room.Transactor
import androidx.room.migration.Migration
import androidx.room.useWriterConnection
import androidx.sqlite.SQLiteConnection
import androidx.sqlite.driver.bundled.BundledSQLiteDriver
import androidx.sqlite.execSQL

@Entity(tableName = "pending_notes", primaryKeys = ["origin", "userId", "id"])
internal data class PendingNote(
    val origin: String,
    val userId: String,
    val id: String,
    val title: String,
    val content: String,
    val baseVersion: Long? = null,
    val deltaContent: String? = null,
    @ColumnInfo(defaultValue = "0") val rejected: Boolean = false,
    val flutterFields: String? = null,
    val backgroundChange: String? = null, // Null omits the change. An empty string clears the background.
    val outboxScope: String? = null,
)

@Dao
internal abstract class DraftDao {
    @Query("SELECT * FROM pending_notes WHERE origin = :origin AND userId = :userId ORDER BY rowid")
    abstract suspend fun list(origin: String, userId: String): List<PendingNote>

    @Query("SELECT * FROM pending_notes WHERE origin = :origin AND userId = :userId AND id = :id AND rejected = 0")
    abstract suspend fun ready(origin: String, userId: String, id: String): PendingNote?

    @Insert
    protected abstract suspend fun insert(note: PendingNote)

    @Query(outboxScopeSql)
    protected abstract suspend fun scope(origin: String, userId: String): String?

    @Transaction
    open suspend fun enqueue(note: PendingNote) {
        insert(note.copy(outboxScope = scope(note.origin, note.userId)))
    }

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    abstract suspend fun recordShare(receipt: NativeShareReceipt): Long

    @Query("DELETE FROM native_share_receipts WHERE origin = :origin AND userId = :userId")
    abstract suspend fun clearShareReceipts(origin: String, userId: String)

    @Query("DELETE FROM pending_notes WHERE origin = :origin AND userId = :userId AND id = :id")
    abstract suspend fun acknowledge(origin: String, userId: String, id: String)

    @Query("UPDATE pending_notes SET rejected = 1 WHERE origin = :origin AND userId = :userId AND id = :id")
    abstract suspend fun markRejected(origin: String, userId: String, id: String)

    @Query("DELETE FROM pending_notes WHERE origin = :origin AND userId = :userId")
    abstract suspend fun clearAccount(origin: String, userId: String)
}

@Database(
    entities = [
        PendingNote::class, CachedNote::class, CachedTag::class, CachedNoteTag::class, CachedAttachment::class,
        NoteCheckpoint::class, PendingAttachmentUpload::class, PendingAttachmentPart::class,
        LegacyUpgradeImport::class, LegacyUpgradeRow::class,
        LegacyMetadataChange::class,
        NativeShareReceipt::class, CachedAttachmentPart::class,
    ],
    version = 28,
    autoMigrations = [
        AutoMigration(from = 1, to = 2),
        AutoMigration(from = 3, to = 4),
        AutoMigration(from = 4, to = 5),
        AutoMigration(from = 5, to = 6),
        AutoMigration(from = 6, to = 7),
        AutoMigration(from = 7, to = 8),
        AutoMigration(from = 8, to = 9),
        AutoMigration(from = 9, to = 10),
        AutoMigration(from = 10, to = 11),
        AutoMigration(from = 11, to = 12),
        AutoMigration(from = 12, to = 13),
        AutoMigration(from = 13, to = 14),
        AutoMigration(from = 14, to = 15),
        AutoMigration(from = 15, to = 16),
        AutoMigration(from = 16, to = 17),
        AutoMigration(from = 17, to = 18),
        AutoMigration(from = 18, to = 19),
        AutoMigration(from = 19, to = 20),
        AutoMigration(from = 20, to = 21),
        AutoMigration(from = 24, to = 25),
        AutoMigration(from = 26, to = 27),
        AutoMigration(from = 27, to = 28),
    ],
)
@ConstructedBy(DraftDatabaseConstructor::class)
internal abstract class DraftDatabase : RoomDatabase() {
    abstract fun drafts(): DraftDao
    abstract fun notes(): NoteCacheDao
    abstract fun attachmentOutbox(): AttachmentOutbox
    abstract fun legacyUpgrade(): LegacyUpgradeDao

    suspend fun enqueueNoteWithRecording(note: PendingNote, recording: PickedAttachment) {
        useWriterConnection { connection ->
            connection.withTransaction(Transactor.SQLiteTransactionType.IMMEDIATE) {
                drafts().enqueue(note)
                attachmentOutbox().enqueue(note.origin, note.userId, note.id, recording)
            }
        }
    }

    suspend fun discardDraft(note: PendingNote) {
        useWriterConnection { connection ->
            connection.withTransaction(Transactor.SQLiteTransactionType.IMMEDIATE) {
                attachmentOutbox().discardPendingNoteUploads(note.origin, note.userId, note.id)
                drafts().acknowledge(note.origin, note.userId, note.id)
            }
        }
    }

    suspend fun clearAccount(origin: String, userId: String) {
        useWriterConnection { connection ->
            connection.withTransaction(Transactor.SQLiteTransactionType.IMMEDIATE) {
                drafts().clearAccount(origin, userId)
                drafts().clearShareReceipts(origin, userId)
                notes().reset(origin, userId)
                notes().clearCheckpoint(origin, userId)
                attachmentOutbox().clearAccount(origin, userId)
                legacyUpgrade().clearRows(origin, userId)
                legacyUpgrade().clearMetadata(origin, userId)
                legacyUpgrade().clearImport(origin, userId)
            }
        }
    }
}

@Suppress("KotlinNoActualForExpect")
internal expect object DraftDatabaseConstructor : RoomDatabaseConstructor<DraftDatabase> {
    override fun initialize(): DraftDatabase
}

private val expandOutbox = object : Migration(2, 3) {
    override fun migrate(connection: SQLiteConnection) {
        connection.execSQL("""
            CREATE TABLE pending_notes_v3 (
                origin TEXT NOT NULL,
                userId TEXT NOT NULL,
                id TEXT NOT NULL,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                PRIMARY KEY (origin, userId, id)
            )
        """.trimIndent())
        connection.execSQL("""
            INSERT INTO pending_notes_v3 (origin, userId, id, title, content)
            SELECT origin, userId, id, title, content FROM pending_notes
        """.trimIndent())
        connection.execSQL("DROP TABLE pending_notes")
        connection.execSQL("ALTER TABLE pending_notes_v3 RENAME TO pending_notes")
    }
}

private val addNoteFolders = object : Migration(21, 22) {
    override fun migrate(connection: SQLiteConnection) {
        connection.execSQL("ALTER TABLE cached_notes ADD COLUMN isArchived INTEGER NOT NULL DEFAULT 0")
        connection.execSQL("ALTER TABLE cached_notes ADD COLUMN isTrashed INTEGER NOT NULL DEFAULT 0")
        // Repull folder state on the next successful sync, keeping offline notes until then.
        connection.execSQL("UPDATE note_checkpoints SET cursor = ''")
    }
}

private val addNoteCardMetadata = object : Migration(22, 23) {
    override fun migrate(connection: SQLiteConnection) {
        connection.execSQL("ALTER TABLE cached_notes ADD COLUMN background TEXT")
        connection.execSQL("ALTER TABLE cached_notes ADD COLUMN updatedAt TEXT")
        connection.execSQL("UPDATE note_checkpoints SET cursor = ''")
    }
}

private val addNoteCreationDate = object : Migration(23, 24) {
    override fun migrate(connection: SQLiteConnection) {
        connection.execSQL("ALTER TABLE cached_notes ADD COLUMN createdAt INTEGER")
        connection.execSQL("UPDATE note_checkpoints SET cursor = ''")
    }
}

private val bindOutboxToFeed = object : Migration(25, 26) {
    override fun migrate(connection: SQLiteConnection) {
        connection.execSQL("ALTER TABLE note_checkpoints ADD COLUMN outboxScope TEXT")
        connection.execSQL("""
            UPDATE note_checkpoints SET outboxScope = substr(cursor, 5, 64)
            WHERE substr(cursor, 1, 4) IN ('n1:@', 'n4:@', 'n5:@')
              AND substr(cursor, 69, 1) = ':' AND substr(cursor, 5, 64) NOT GLOB '*[^0-9a-f]*'
        """.trimIndent())
        for (table in listOf("pending_notes", "pending_attachment_uploads", "legacy_metadata_changes")) {
            connection.execSQL("ALTER TABLE $table ADD COLUMN outboxScope TEXT")
            connection.execSQL("""
                UPDATE $table SET outboxScope = (
                    SELECT outboxScope FROM note_checkpoints
                    WHERE origin = $table.origin AND userId = $table.userId
                )
            """.trimIndent())
        }
    }
}

internal fun openDraftDatabase(builder: RoomDatabase.Builder<DraftDatabase>): DraftDatabase =
    builder.setDriver(BundledSQLiteDriver()).addMigrations(
        expandOutbox, addNoteFolders, addNoteCardMetadata, addNoteCreationDate, bindOutboxToFeed,
    ).build()
