package anchor

import android.content.Context
import android.content.ContextWrapper
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.useReaderConnection
import androidx.room.useWriterConnection
import androidx.sqlite.driver.bundled.BundledSQLiteDriver
import androidx.sqlite.execSQL
import java.io.File
import java.security.MessageDigest
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.flow.first
import kotlinx.io.files.Path
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

// Failure cases: version mismatch, late read failure, exhausted retry and lost account separation.
class LegacyUpgradeRoomTest {
    @get:Rule val temporaryFolder = TemporaryFolder()

    @Test
    fun failedImportRollsBackAndSuccessfulRetryKeepsOfflineChanges(): Unit = runBlocking {
        assumeTrue(System.getProperty("androidx.sqlite.driver.bundled.path") != null)
        val directory = temporaryFolder.newFolder()
        val support = File(directory, "support").apply { mkdir() }
        val documents = File(directory, "documents").apply { mkdir() }
        val account = AnchorSession("https://anchor.example", "owner", "", null)
        val stagedAccount = "acfd5e93c78aa1e23dd25220ced3baaeec510c77dd27822056f6f4c4c6aa7cf7"
        val bundle = File(support, "legacy-upgrade/$stagedAccount").apply { mkdirs() }
        val files = File(bundle, "files").apply { mkdir() }
        val localUpload = File(files, "0")
        val expectedBytes = ByteArray(attachmentPartSize + 5) { (it % 137).toByte() }
        localUpload.writeBytes(expectedBytes)
        val cachedBytes = ByteArray(20) { (it * 3).toByte() }
        val cachedFile = File(files, "1").apply { writeBytes(cachedBytes) }
        val newNote = "c15f6861-d78c-4141-98b8-5a70f50e9879"
        val offlineArchived = "a25f6861-d78c-4141-98b8-5a70f50e9879"
        val offlineTrashed = "b25f6861-d78c-4141-98b8-5a70f50e9879"
        val offlineDeleted = "c25f6861-d78c-4141-98b8-5a70f50e9879"
        val editedNote = "e15f6861-d78c-4141-98b8-5a70f50e9879"
        val deletedNote = "d15f6861-d78c-4141-98b8-5a70f50e9879"
        val upload = "b15f6861-d78c-4141-98b8-5a70f50e9879"
        val archivedUpload = "d25f6861-d78c-4141-98b8-5a70f50e9879"
        val trashedUpload = "e25f6861-d78c-4141-98b8-5a70f50e9879"
        val removedUpload = "a15f6861-d78c-4141-98b8-5a70f50e9879"
        val sharedNote = "715f6861-d78c-4141-98b8-5a70f50e9879"
        val shareFile = File(files, "3").apply { writeBytes(byteArrayOf(1, 4, 9, 16)) }
        val archiveBytes = byteArrayOf(2, 4, 6, 8)
        val archiveFile = File(files, "4").apply { writeBytes(archiveBytes) }
        val trashBytes = byteArrayOf(3, 6, 9, 12)
        val trashFile = File(files, "5").apply { writeBytes(trashBytes) }
        val shareManifest = File(files, "2").apply {
            writeText("""{"version":1,"id":"$sharedNote","userId":"owner","savedAt":"2026-11-23T09:00:00Z",
                "title":"Shared item","text":"See https://anchor.example.\r\n","link":"example.test","tagIds":["tag","removed-tag"],
                "files":[{"file":"clip.wav","name":"voice.wav","mime":"audio/wav"}]}""")
        }
        fun receipt(file: File): String {
            val hash = MessageDigest.getInstance("SHA-256").digest(file.readBytes()).toHexString()
            return """{"path":"files/${file.name}","size":${file.length()},"sha256":"$hash"}"""
        }
        val database = File(bundle, "collection.sqlite")
        val installedDatabase = File(documents, "db_owner.sqlite")
        fun writeManifest() {
            val digest = MessageDigest.getInstance("SHA-256").digest(database.readBytes()).toHexString()
            File(bundle, "manifest.json").writeText(
                """{"version":1,"schemaVersion":12,"installed":true,"installedShareInbox":true,"userId":"owner","origin":"https://anchor.example",
                "database":{"path":"collection.sqlite","size":${database.length()},"sha256":"$digest"},
                "attachments":{"$upload":{"path":"files/0","size":${localUpload.length()},
                "sha256":"${MessageDigest.getInstance("SHA-256").digest(expectedBytes).toHexString()}"},
                "cached":${receipt(cachedFile)},"$archivedUpload":${receipt(archiveFile)},"$trashedUpload":${receipt(trashFile)}},
                "shares":{"$sharedNote":{"manifest":${receipt(shareManifest)},"files":{"clip.wav":${receipt(shareFile)}}}}}""",
            )
        }
        BundledSQLiteDriver().open(database.absolutePath).use { source ->
            source.execSQL("PRAGMA user_version=12")
            source.execSQL("""CREATE TABLE notes (id TEXT PRIMARY KEY, content TEXT, is_synced INTEGER, synced_content TEXT,
                state TEXT, local_rev INTEGER, title TEXT, version INTEGER, is_pinned INTEGER, is_archived INTEGER,
                reminder_at TEXT, reminder_recurrence TEXT, reminder_version INTEGER, background TEXT, permission TEXT, is_pin_synced INTEGER, is_reminder_synced INTEGER)""")
            source.execSQL("""INSERT INTO notes VALUES
                ('$editedNote', 'new delta', 0, 'base delta', 'active', 42, 'Local edit', 7, 1, 0, '2026-11-24T12:00', NULL, 2, NULL, 'owner', 0, 0),
                ('$deletedNote', NULL, 0, NULL, 'deleted', 43, 'Removed', 8, 0, 0, NULL, NULL, NULL, '#345678', 'owner', 1, 1),
                ('$newNote', '{"ops":[{"insert":"Offline"}]}', 0, NULL, 'active', 1, 'Offline note', NULL, 1, 0, NULL, NULL, NULL, NULL, 'owner', 0, 1),
                ('archived', NULL, 1, NULL, 'active', 0, 'Archive', 3, 0, 1, NULL, NULL, NULL, NULL, 'owner', 1, 1),
                ('trashed', NULL, 1, NULL, 'trashed', 0, 'Removed', 4, 0, 1, NULL, NULL, NULL, NULL, 'owner', 1, 1),
                ('$offlineArchived', 'stored body', 0, NULL, 'active', 2, 'Stored without network', NULL, 0, 1, NULL, NULL, NULL, '#654321', 'owner', 1, 1),
                ('$offlineTrashed', 'trashed body', 0, NULL, 'trashed', 2, 'Discarded without network', NULL, 0, 0, NULL, NULL, NULL, NULL, 'owner', 1, 1),
                ('$offlineDeleted', NULL, 0, NULL, 'deleted', 3, '', NULL, 0, 0, NULL, NULL, NULL, NULL, 'owner', 1, 1)""")
            source.execSQL("ALTER TABLE notes ADD COLUMN created_at INTEGER")
            source.execSQL("UPDATE notes SET created_at = 1700000000, background = '#123456' WHERE id = '$newNote'")
            source.execSQL("CREATE TABLE tags (id TEXT, name TEXT, color TEXT, version INTEGER, is_deleted INTEGER, is_synced INTEGER)")
            source.execSQL("INSERT INTO tags VALUES ('tag', 'Keep', NULL, 3, 0, 0), ('removed-tag', 'Hidden', NULL, 4, 1, 1)")
            source.execSQL("CREATE TABLE note_tags (note_id TEXT, tag_id TEXT)")
            source.execSQL("INSERT INTO note_tags VALUES ('$editedNote', 'tag'), ('$newNote', 'tag'), ('$editedNote', 'removed-tag'), ('$deletedNote', 'tag')")
            source.execSQL("""CREATE TABLE note_attachments (id TEXT, note_id TEXT, sync_status TEXT, server_attachment_id TEXT,
                type TEXT, original_filename TEXT, mime_type TEXT, file_size INTEGER, uploaded_by_user_id TEXT,
                created_at INTEGER, position INTEGER)""")
            source.execSQL("""INSERT INTO note_attachments VALUES
                ('cached', '$editedNote', 'synced', 'server-file', 'image', 'test.png', 'image/png', 20, 'owner', 200, 1),
                ('removed', '$editedNote', 'pending_delete', '$removedUpload', 'image', 'remove.png', 'image/png', 21, 'owner', 201, 2),
                ('$upload', '$newNote', 'pending_upload', NULL, 'audio', 'queued.wav', 'audio/wav', ${expectedBytes.size},
                    NULL, 202, 0),
                ('$archivedUpload', '$offlineArchived', 'pending_upload', NULL, 'audio', 'archived.wav', 'audio/wav', 4, NULL, 203, 0),
                ('$trashedUpload', '$offlineTrashed', 'pending_upload', NULL, 'audio', 'trashed.wav', 'audio/wav', 4, NULL, 204, 0)""")
            for (name in listOf("note_history_state", "sync_state")) {
                source.execSQL("CREATE TABLE $name (id TEXT)")
            }
            source.execSQL("""CREATE TABLE note_revisions (id TEXT, note_id TEXT, title TEXT, content TEXT,
                version INTEGER, cause TEXT, created_at INTEGER, is_synced INTEGER, author_name TEXT)""")
            source.execSQL("""INSERT INTO note_revisions VALUES
                ('offline-revision', '$newNote', 'Earlier copy', 'old delta', 0, 'restore', 1700000000123, 0, 'Note owner'),
                ('local-conflict', '$newNote', 'Conflict', NULL, 0, 'conflict', 1700000000000, 1, NULL)""")
        }
        writeManifest()
        database.copyTo(installedDatabase)
        val sourceDocuments = Path(documents.absolutePath)
        val sourceShareFolder = File(directory, "share").apply { mkdir() }
        val sourceShare = File(sourceShareFolder, "inbox/$sharedNote").apply { mkdirs() }
        shareManifest.copyTo(File(sourceShare, "manifest.json"))
        shareFile.copyTo(File(sourceShare, "clip.wav"))
        val sourceShares = Path(sourceShareFolder.absolutePath)
        val destination = File(directory, "room.sqlite").absolutePath
        val context = object : ContextWrapper(null) {
            override fun getApplicationContext(): Context = this
            override fun getDatabasePath(name: String): File = File(name)
        }
        suspend fun withRoom(block: suspend (DraftDatabase) -> Unit) {
            val room = openDraftDatabase(Room.databaseBuilder(
                context = context, name = destination, factory = { DraftDatabaseConstructor.initialize() },
            ).setJournalMode(RoomDatabase.JournalMode.WRITE_AHEAD_LOGGING))
            try {
                block(room)
            } finally {
                room.close()
            }
        }

        withRoom { room ->
            val failure = runCatching { room.importLegacyUpgrade(Path(bundle.absolutePath), account, sourceDocuments, sourceShares) }
            assertTrue(failure.isFailure)
            assertNull(room.legacyUpgrade().imported(account.origin, account.userId))
            assertTrue(room.legacyUpgrade().rows(account.origin, account.userId, "notes").isEmpty())
            assertTrue(room.notes().list(account.origin, account.userId).isEmpty())
            assertTrue(room.attachmentOutbox().observe(account.origin, account.userId).first().isEmpty())
        }

        val missingSupport = Path(File(directory, "missing-support").absolutePath)
        val emptySupport = Path(File(directory, "empty-support").apply { mkdir() }.absolutePath)
        withRoom { room ->
            val other = AnchorSession(account.origin, "different-owner", "", null)
            assertFalse(room.importStagedLegacyUpgrade(emptySupport, other, sourceDocuments, sourceShares))
            val installedBytes = installedDatabase.readBytes()
            val otherServer = AnchorSession("https://other.example", account.userId, "", null)
            for ((location, active) in listOf(
                missingSupport to account, emptySupport to account, Path(support.absolutePath) to otherServer,
            )) {
                val failure = runCatching {
                    room.importStagedLegacyUpgrade(location, active, sourceDocuments, sourceShares)
                }
                assertEquals("LegacyUpgradeExportRequired", failure.exceptionOrNull()?.javaClass?.simpleName)
            }
            assertNull(room.legacyUpgrade().imported(account.origin, account.userId))
            assertTrue(room.notes().list(account.origin, account.userId).isEmpty())
            assertTrue(installedDatabase.readBytes().contentEquals(installedBytes))
        }

        BundledSQLiteDriver().open(database.absolutePath).use { source ->
            source.execSQL("CREATE TABLE sync_sweep (id TEXT)")
        }
        writeManifest()
        val original = database.readBytes()
        database.copyTo(installedDatabase, overwrite = true)
        BundledSQLiteDriver().open(installedDatabase.absolutePath).use { source ->
            source.execSQL("UPDATE notes SET title = 'Edited after preparation' WHERE id = '$newNote'")
        }
        withRoom { room ->
            val stale = runCatching {
                room.importStagedLegacyUpgrade(Path(support.absolutePath), account, sourceDocuments, sourceShares)
            }
            assertEquals("Flutter data changed after the backup was prepared.", stale.exceptionOrNull()?.message)
            assertNull(room.legacyUpgrade().imported(account.origin, account.userId))
        }
        BundledSQLiteDriver().open(installedDatabase.absolutePath).use { source ->
            source.execSQL("PRAGMA journal_mode=WAL")
            source.execSQL("UPDATE notes SET title = 'Offline note' WHERE id = '$newNote'")
            source.execSQL("PRAGMA wal_checkpoint(TRUNCATE)")
        }
        assertFalse(installedDatabase.readBytes().contentEquals(original))
        val lateShare = File(sourceShareFolder, "inbox/late-share").apply { mkdir() }
        File(lateShare, "manifest.json").writeText("""{"id":"late-share","userId":"owner","files":[]}""")
        withRoom { room ->
            val stale = runCatching {
                room.importStagedLegacyUpgrade(Path(support.absolutePath), account, sourceDocuments, sourceShares)
            }
            assertEquals("Flutter share inbox changed after the backup was prepared.", stale.exceptionOrNull()?.message)
            assertNull(room.legacyUpgrade().imported(account.origin, account.userId))
        }
        lateShare.deleteRecursively()
        val selected = File(support, "legacy-upgrade/$stagedAccount.current")
        selected.writeText("../other-account")
        withRoom { room ->
            val invalid = runCatching {
                room.importStagedLegacyUpgrade(Path(support.absolutePath), account, sourceDocuments, sourceShares)
            }
            assertEquals("Invalid Flutter upgrade selection.", invalid.exceptionOrNull()?.message)
            assertNull(room.legacyUpgrade().imported(account.origin, account.userId))
        }
        val generation = "0123456789abcdef0123456789abcdef"
        val refreshed = File(support, "legacy-upgrade/$stagedAccount.$generation")
        assertTrue(bundle.copyRecursively(refreshed))
        selected.writeText(generation)
        withRoom { room ->
            val privateSupport = Path(support.absolutePath)
            val otherServer = AnchorSession("https://second.example", account.userId, "", null)
            assertFalse(room.importStagedLegacyUpgrade(privateSupport, otherServer))
            assertTrue(room.notes().list(otherServer.origin, otherServer.userId).isEmpty())
            assertTrue(room.importStagedLegacyUpgrade(privateSupport, account, sourceDocuments, sourceShares))
            assertEquals(refreshed.name, room.legacyUpgrade().imported(account.origin, account.userId)?.directory)
            val attachment = room.notes().attachments(account.origin, account.userId, editedNote).first().single()
            assertTrue(room.readFlutterAttachment(account, attachment, privateSupport)?.contentEquals(cachedBytes) == true)
            val outbox = room.attachmentOutbox()
            val deferred = outbox.observeNote(account.origin, account.userId, offlineTrashed).first().single()
            assertEquals(trashedUpload, deferred.id)
            assertTrue(deferred.deferUntilRestored)
            assertEquals(1, outbox.discard(account.origin, account.userId, trashedUpload))
            room.useWriterConnection { writer ->
                writer.usePrepared("UPDATE legacy_upgrade_imports SET directory = ? WHERE origin = ? AND userId = ?") {
                    it.bindText(1, refreshed.canonicalPath)
                    it.bindText(2, account.origin)
                    it.bindText(3, account.userId)
                    it.step()
                }
            }
        }
        // Recreate a database whose importer had already committed on v27.
        BundledSQLiteDriver().open(destination).use { installed ->
            installed.execSQL("ALTER TABLE pending_attachment_uploads DROP COLUMN deferUntilRestored")
            installed.execSQL("ALTER TABLE legacy_upgrade_imports DROP COLUMN trashUploadsPrepared")
            installed.execSQL("UPDATE room_master_table SET identity_hash = '17c7cbf7e43461c32147538c8232d678' WHERE id = 42")
            installed.execSQL("PRAGMA user_version = 27")
        }
        selected.writeText("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        installedDatabase.delete()
        val expectedShare = shareFile.readBytes()
        val relocatedSupport = File(directory, "relocated-support")
        assertTrue(support.renameTo(relocatedSupport))
        val relocatedBundle = File(relocatedSupport, "legacy-upgrade/${refreshed.name}")
        val relocatedOriginal = File(relocatedSupport, "legacy-upgrade/$stagedAccount")
        val currentSupport = Path(relocatedSupport.absolutePath)
        withRoom { room ->
            assertFalse(room.importStagedLegacyUpgrade(currentSupport, account))
            assertEquals(true, room.legacyUpgrade().imported(account.origin, account.userId)?.trashUploadsPrepared)
            val notes = room.legacyUpgrade().rows(account.origin, account.userId, "notes")
            assertEquals(8, notes.size)
            assertTrue(notes[0].payload.contains("\"synced_content\":\"base delta\""))
            assertTrue(notes[0].payload.contains("\"is_synced\":0"))
            assertTrue(notes[1].payload.contains("\"state\":\"deleted\""))
            assertEquals(2, room.legacyUpgrade().rows(account.origin, account.userId, "note_revisions").size)
            assertTrue(room.legacyUpgrade().rows(account.origin, "other", "notes").isEmpty())
            assertTrue(File(relocatedOriginal, "collection.sqlite").readBytes().contentEquals(original))
            assertNull(room.notes().cursor(account.origin, account.userId))
            val library = room.notes().list(account.origin, account.userId)
            val searchTags = room.notes().searchTags(account.origin, account.userId).first()
                .groupBy({ it.noteId }, { it.name })
            assertEquals(listOf(editedNote, newNote), searchNotes(library, NoteFolder.Notes, " KEEP ", searchTags).map { it.id })
            assertTrue(room.notes().searchTags(account.origin, "other").first().isEmpty())
            assertEquals(listOf(newNote), searchNotes(library, NoteFolder.Notes, "offline", searchTags).map { it.id })
            assertEquals(listOf("archived"), searchNotes(library, NoteFolder.Notes, "archive", searchTags).map { it.id })
            assertEquals(emptyList<CachedNote>(), searchNotes(library, NoteFolder.Notes, "removed", searchTags))
            assertEquals(listOf("trashed"), searchNotes(library, NoteFolder.Trash, "removed", searchTags).map { it.id })
            val linked = library.first().copy(content = """{"ops":[{"insert":"Visible","attributes":{"link":"https://hidden.test"}}]}""")
            assertEquals(listOf(linked), searchNotes(listOf(linked), NoteFolder.Notes, "visible", emptyMap()))
            assertEquals(emptyList<CachedNote>(), searchNotes(listOf(linked), NoteFolder.Notes, "hidden.test", emptyMap()))
            assertEquals(listOf("archived", offlineArchived), library.filter { it.folder == NoteFolder.Archive }.map { it.id })
            assertEquals(listOf(offlineTrashed, "trashed"), library.filter { it.folder == NoteFolder.Trash }.map { it.id })
            assertTrue(library.none { it.id == deletedNote })
            val offline = library.filter { it.folder == NoteFolder.Notes }
            assertEquals(listOf(editedNote, newNote), offline.map { it.id })
            assertEquals("new delta", offline.first().content)
            assertEquals(7L, offline.first().version)
            assertEquals("2026-11-24T12:00", offline.first().remindAt)
            assertEquals("""{"ops":[{"insert":"Offline"}]}""", offline.last().content)
            assertTrue(offline.none { it.canEdit || it.isOwner })
            val localHistory = room.readFlutterRevisions(account, newNote)
            assertEquals(listOf("offline-revision", "local-conflict"), localHistory.map { it.id })
            assertEquals("Note owner", localHistory.first().author)
            assertEquals("old delta", localHistory.first().content)
            assertEquals("2023-11-14T22:13:20.123Z", localHistory.first().createdAt.toString())
            assertTrue(room.readFlutterRevisions(account, editedNote).isEmpty())
            assertTrue(room.readFlutterRevisions(AnchorSession(account.origin, "other", "", null), newNote).isEmpty())
            val offlineHistory = loadNoteHistory(offline.last(), localHistory) { throw AnchorHttpFailure(503) }
            assertTrue(offlineHistory.offline)
            assertFalse(offlineHistory.current.canRestore)
            assertEquals(localHistory, offlineHistory.page.entries)
            val forbidden = AnchorHttpFailure(403)
            assertEquals(forbidden, runCatching {
                loadNoteHistory(offline.last(), localHistory) { throw forbidden }
            }.exceptionOrNull())
            assertTrue(room.notes().list(account.origin, "other").isEmpty())
            val drafts = room.drafts().list(account.origin, account.userId).associateBy { it.id }
            assertEquals(setOf(newNote, editedNote, deletedNote, sharedNote, offlineArchived, offlineTrashed), drafts.keys)
            assertEquals(Json.parseToJsonElement(
                """{"type":"note","id":"$offlineArchived","title":"Stored without network","content":"stored body",
                "isArchived":true,"background":"#654321","state":"active"}""",
            ), drafts.getValue(offlineArchived).syncNoteChange())
            assertEquals(Json.parseToJsonElement(
                """{"type":"note","id":"$offlineTrashed","title":"Discarded without network","content":"trashed body",
                "isArchived":false,"background":null,"state":"trashed"}""",
            ), drafts.getValue(offlineTrashed).syncNoteChange())
            val edit = drafts.getValue(editedNote).syncNoteChange()
            val deletion = drafts.getValue(deletedNote).syncNoteChange()
            assertEquals(Json.parseToJsonElement(
                """{"type":"note","id":"$editedNote","title":"Local edit","baseVersion":7,"content":"new delta",
                "isArchived":false,"background":null,"state":"active"}""",
            ), edit)
            assertEquals(JsonNull, deletion["content"])
            assertEquals(Json.parseToJsonElement(
                """{"type":"note","id":"$deletedNote","title":"Removed","baseVersion":8,"content":null,
                "isArchived":false,"background":"#345678","state":"deleted"}""",
            ), deletion)
            room.drafts().markRejected(account.origin, account.userId, editedNote)
            room.drafts().acknowledge(account.origin, account.userId, deletedNote)
            val shared = drafts.getValue(sharedNote)
            assertEquals("Shared item", shared.title)
            assertEquals(Json.parseToJsonElement(
                """{"ops":[{"insert":"See "},{"insert":"https://anchor.example","attributes":{"link":"https://anchor.example"}},
                {"insert":".\n"},{"insert":"example.test","attributes":{"link":"https://example.test"}},{"insert":"\n"}]}""",
            ), Json.parseToJsonElement(checkNotNull(shared.deltaContent)))
            assertEquals("2026-11-23T09:00:00Z", shared.syncNoteChange()["createdAt"]?.jsonPrimitive?.content)
            val draft = drafts.getValue(newNote)
            assertEquals(newNote, draft.id)
            assertEquals(offline.last().content, draft.deltaContent)
            assertNull(draft.baseVersion)
            assertEquals("2023-11-14T22:13:20Z", draft.syncNoteChange()["createdAt"]?.jsonPrimitive?.content)
            assertEquals("#123456", draft.syncNoteChange()["background"]?.jsonPrimitive?.content)
            val outbox = room.attachmentOutbox()
            val pendingUploads = outbox.observe(account.origin, account.userId).first()
            val migrated = pendingUploads.single { it.noteId == newNote }
            assertFalse(migrated.deferUntilRestored)
            val archiveUpload = pendingUploads.single { it.noteId == offlineArchived }
            val trashUpload = pendingUploads.single { it.noteId == offlineTrashed }
            assertEquals(trashedUpload, trashUpload.id)
            assertTrue(trashUpload.deferUntilRestored)
            assertTrue(outbox.readPart(account.origin, account.userId, trashedUpload, 0)?.contentEquals(trashBytes) == true)
            val sharedUpload = pendingUploads.single { it.noteId == sharedNote }
            assertEquals("voice.wav", sharedUpload.filename)
            assertTrue(outbox.readPart(account.origin, account.userId, sharedUpload.id, 0)?.contentEquals(expectedShare) == true)
            assertEquals(upload, migrated.id)
            assertEquals(expectedBytes.size, migrated.fileSize)
            assertTrue(outbox.observeReady(account.origin, account.userId).first().isEmpty())
            val firstPart = checkNotNull(outbox.readPart(account.origin, account.userId, upload, 0))
            val lastPart = checkNotNull(outbox.readPart(account.origin, account.userId, upload, 1))
            assertTrue((firstPart + lastPart).contentEquals(expectedBytes))
            val operations = room.legacyUpgrade()
            assertEquals(listOf("tag", "pin", "reminder", "attachmentDelete"), operations.readyMetadata(account.origin, account.userId).map { it.kind })
            assertTrue(operations.readyMetadata(account.origin, "other").isEmpty())
            val sent = mutableListOf<String>()
            assertTrue(room.sendFlutterMetadata(account) { payload, _ ->
                val kind = payload.getValue("type").jsonPrimitive.content
                sent += kind
                if (kind == "reminder") {
                    assertEquals(Json.parseToJsonElement(
                        """{"type":"reminder","id":"$editedNote","baseVersion":2,"remindAt":"2026-11-24T12:00","recurrence":"none"}""",
                    ), payload)
                    "conflict"
                } else {
                    if (kind == "attachmentDelete") {
                        assertEquals(Json.parseToJsonElement(
                            """{"type":"attachmentDelete","id":"$removedUpload","noteId":"$editedNote"}""",
                        ), payload)
                    }
                    "applied"
                }
            })
            assertEquals(listOf("tag", "pin", "reminder", "attachmentDelete"), sent)
            assertEquals("conflict", operations.metadata(account.origin, account.userId).first { it.kind == "reminder" }.rejection)
            assertEquals(editedNote, operations.readyMetadata(account.origin, account.userId).single().entityId)
            assertFalse(room.sendFlutterMetadata(account) { payload, _ ->
                assertEquals(Json.parseToJsonElement(
                    """{"type":"noteTags","id":"$editedNote","tagIds":["tag"]}""",
                ), payload)
                "applied"
            })
            room.drafts().acknowledge(account.origin, account.userId, newNote)
            assertEquals(listOf(migrated), outbox.observeReady(account.origin, account.userId).first())
            val newMetadata = operations.readyMetadata(account.origin, account.userId)
            assertEquals(listOf("noteTags", "pin", "revision"), newMetadata.map { it.kind })
            assertFalse(room.sendFlutterMetadata(account) { payload, _ ->
                if (payload.getValue("type").jsonPrimitive.content == "revision") {
                    assertEquals(Json.parseToJsonElement(
                        """{"type":"note","id":"$newNote","title":"Earlier copy","revisionsOnly":true,"requireRevisionWrite":true,
                        "revisions":[{"id":"offline-revision","title":"Earlier copy","content":"old delta",
                        "version":0,"cause":"restore","createdAt":"2023-11-14T22:13:20.123Z"}]}""",
                    ), flutterRevisionChange(payload))
                }
                "applied"
            })
            outbox.discard(account.origin, account.userId, upload)
            assertTrue(outbox.observeReady(account.origin, account.userId).first().isEmpty())
            room.drafts().acknowledge(account.origin, account.userId, sharedNote)
            assertEquals(listOf(sharedUpload), outbox.observeReady(account.origin, account.userId).first())
            assertFalse(room.sendFlutterMetadata(account) { payload, _ ->
                assertEquals(Json.parseToJsonElement(
                    """{"type":"noteTags","id":"$sharedNote","tagIds":["tag"]}""",
                ), payload)
                "applied"
            })
            outbox.discard(account.origin, account.userId, sharedUpload.id)
            room.drafts().acknowledge(account.origin, account.userId, offlineArchived)
            room.drafts().acknowledge(account.origin, account.userId, offlineTrashed)
            assertEquals(listOf(archiveUpload), outbox.observeReady(account.origin, account.userId).first())
            assertEquals(archivedUpload, archiveUpload.id)
            assertTrue(outbox.readPart(account.origin, account.userId, archivedUpload, 0)?.contentEquals(archiveBytes) == true)
            outbox.discard(account.origin, account.userId, archivedUpload)
            assertFalse(room.sendFlutterMetadata(account) { _, _ -> "applied" })
            val attachment = room.notes().attachments(account.origin, account.userId, editedNote).first().single()
            assertEquals("server-file", attachment.id)
            assertEquals("1970-01-01T00:03:20Z", attachment.createdAt)
            assertTrue(room.readFlutterAttachment(account, attachment, currentSupport)?.contentEquals(cachedBytes) == true)
            assertNull(room.readFlutterAttachment(account, attachment.copy(noteId = newNote), currentSupport))
            val otherAccount = AnchorSession(account.origin, "other", "", null)
            assertNull(room.readFlutterAttachment(otherAccount, attachment.copy(userId = otherAccount.userId), currentSupport))
            val importedAttachment = File(relocatedBundle, "files/1")
            importedAttachment.writeBytes(cachedBytes.reversedArray())
            assertNull(room.readFlutterAttachment(account, attachment, currentSupport))
            importedAttachment.writeBytes(cachedBytes)
            assertTrue(room.readFlutterAttachment(account, attachment, currentSupport)?.contentEquals(cachedBytes) == true)
            room.useReaderConnection { reader ->
                reader.usePrepared("SELECT tagId FROM cached_note_tags WHERE noteId = ?") { rows ->
                    rows.bindText(1, editedNote)
                    assertTrue(rows.step())
                    assertEquals("tag", rows.getText(0))
                    assertFalse(rows.step())
                }
            }
            val current = CachedNote(account.origin, account.userId, editedNote, "Current server title", "Current", 8)
            val restored = CachedNote(
                account.origin, account.userId, offlineTrashed, "Restored", null, 2, canEdit = true, isOwner = true,
            )
            room.notes().applyPage(account.origin, account.userId, NoteFeedPage.Data("first-page", false, listOf(
                FeedEntry.Upsert(current, emptyList(), emptyList()),
                FeedEntry.Upsert(restored, emptyList(), emptyList()),
            )))
            assertEquals(listOf(current, restored), room.notes().list(account.origin, account.userId))
            assertEquals(listOf(trashUpload), outbox.observeReady(account.origin, account.userId).first())
            assertTrue(outbox.observeReady(account.origin, "other").first().isEmpty())
            assertEquals(1, outbox.discard(account.origin, account.userId, trashedUpload))
            assertTrue(room.notes().attachments(account.origin, account.userId, editedNote).first().isEmpty())
            assertFalse(room.importLegacyUpgrade(Path(relocatedOriginal.absolutePath), account))
            assertTrue(outbox.observe(account.origin, account.userId).first().isEmpty())
            val retained = room.drafts().list(account.origin, account.userId).single()
            assertEquals(editedNote, retained.id)
            assertTrue(retained.rejected)
            assertEquals(edit, retained.syncNoteChange())
            assertEquals("conflict", operations.metadata(account.origin, account.userId).single().rejection)
            val nativeId = "615f6861-d78c-4141-98b8-5a70f50e9879"
            val native = IncomingShare(nativeId, "Incoming share", "Read https://example.test", listOf(
                { error("The source revoked the second file") },
                { PickedAttachment("one.wav", "audio/wav", byteArrayOf(7, 8)) },
            ))
            assertTrue(runCatching { room.saveIncomingShare(account, native) }.isFailure)
            assertTrue(room.drafts().list(account.origin, account.userId).none { it.id == nativeId })
            assertTrue(outbox.observe(account.origin, account.userId).first().none { it.noteId == nativeId })
            val saved = checkNotNull(room.saveIncomingShare(account, native.copy(files = native.files.takeLast(1))))
            assertTrue(saved.deltaContent.orEmpty().contains("https://example.test"))
            assertTrue(outbox.observeReady(account.origin, account.userId).first().none { it.noteId == nativeId })
            room.drafts().acknowledge(account.origin, account.userId, nativeId)
            val ready = outbox.observeReady(account.origin, account.userId).first().single { it.noteId == nativeId }
            assertTrue(outbox.readPart(account.origin, account.userId, ready.id, 0)?.contentEquals(byteArrayOf(7, 8)) == true)
            val iosRoot = File(directory, "compose-share").apply { mkdir() }
            val iosPath = Path(iosRoot.absolutePath)
            val iosId = "515f6861-d78c-4141-98b8-5a70f50e9879"
            fun writeIosShare(id: String, origin: String): File {
                val folder = File(iosRoot, "inbox/$id").apply { mkdirs() }
                File(folder, "picture.png").writeBytes(byteArrayOf(1, 3, 5))
                File(folder, "manifest.json").writeText(
                    """{"version":1,"id":"$id","userId":"owner","origin":"$origin","savedAt":"2026-11-23T09:00:00Z",
                    "title":"iOS share","text":"Shared","link":"example.test","tagIds":[],
                    "files":[{"file":"picture.png","name":"picture.png","mime":"image/png"}]}""",
                )
                return folder
            }
            val contextFile = File(iosRoot, "context.json")
            for ((theme, encoded) in listOf(
                AnchorAppearance.Dark to "dark",
                AnchorAppearance.Light to "light",
                AnchorAppearance.System to "system",
            )) {
                publishShareContext(iosPath, account, emptyList(), theme)
                val context = Json.parseToJsonElement(contextFile.readText()).jsonObject
                assertEquals(account.origin, context["origin"]?.jsonPrimitive?.content)
                assertEquals(encoded, context["theme"]?.jsonPrimitive?.content)
            }
            val iosEntry = writeIosShare(iosId, account.origin)
            val otherServerEntry = writeIosShare("415f6861-d78c-4141-98b8-5a70f50e9879", "https://another.example")
            val consumed = room.importNativeShareInbox(account, iosPath).single()
            assertEquals(iosId, consumed.id)
            assertTrue(consumed.deltaContent.orEmpty().contains("https://example.test"))
            assertFalse(iosEntry.exists())
            assertTrue(otherServerEntry.exists())
            val iosUpload = outbox.observeNote(account.origin, account.userId, iosId).first().single()
            assertTrue(outbox.readPart(account.origin, account.userId, iosUpload.id, 0)?.contentEquals(byteArrayOf(1, 3, 5)) == true)
            room.drafts().acknowledge(account.origin, account.userId, iosId)
            outbox.discard(account.origin, account.userId, iosUpload.id)
            writeIosShare(iosId, account.origin)
            assertTrue(room.importNativeShareInbox(account, iosPath).isEmpty())
            assertTrue(room.drafts().list(account.origin, account.userId).none { it.id == iosId })
            publishShareContext(iosPath, null, emptyList(), AnchorAppearance.Dark)
            assertEquals("{}", contextFile.readText())
            assertEquals(listOf(current, restored), room.notes().list(account.origin, account.userId))
            assertEquals(notes, room.legacyUpgrade().rows(account.origin, account.userId, "notes"))
        }
    }
}
