package anchor

import androidx.room.Room
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.io.buffered
import kotlinx.io.files.Path
import kotlinx.io.files.SystemFileSystem
import kotlinx.io.writeString
import platform.Foundation.NSTemporaryDirectory
import kotlin.io.encoding.Base64
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlin.uuid.ExperimentalUuidApi
import kotlin.uuid.Uuid

private class FixtureSessionStore : SessionStore {
    private var bytes: ByteArray? = null

    override suspend fun read() = bytes
    override suspend fun write(value: ByteArray) { bytes = value }
    override suspend fun clear() { bytes = null }
}

@OptIn(ExperimentalUuidApi::class)
class SimulatorRoundTripTest {
    @Test
    fun formattedNoteRoundTripsThroughConvexAndSurvivesRoomReopen() = runBlocking<Unit> {
        withTimeout(60_000) {
            val id = Uuid.random().toString()
            val path = Path(NSTemporaryDirectory(), "anchor-simulator-$id.db")
            val delta = """{"ops":[{"insert":"Heading","attributes":{"bold":true}},{"insert":"\n","attributes":{"header":2}},{"insert":"Checklist"},{"insert":"\n","attributes":{"list":"checked"}}]}"""
            val sessionStore = FixtureSessionStore()
            val api = AnchorApi(sessionStore, FixtureSessionStore()) { _, _ ->
                error("Fixture did not request account erasure")
            }
            try {
                val origin = "http://localhost:3971"
                val email = "anchor-ios-$id@example.test"
                val password = "Fixture-$id"
                assertTrue(api.register(origin, "iOS round trip", email, password) is AnchorSignIn.Complete)
                val session = (api.signIn(origin, email, password) as AnchorSignIn.Complete).session
                val first = PendingNote(origin, session.userId, id, "Simulator note", "", deltaContent = delta)
                withDatabase(path) { db ->
                    db.drafts().enqueue(first)
                    assertEquals(first.title, api.createNote(session, assertNotNull(db.drafts().ready(origin, session.userId, id))))
                    db.drafts().acknowledge(origin, session.userId, id)
                    api.syncNotes(session, db.notes())
                    val saved = db.notes().list(origin, session.userId).single()
                    assertEquals(id, saved.id)
                    assertEquals(1L, saved.version)
                    assertEquals(delta, saved.content)

                    val edit = first.copy(title = "Updated simulator note", baseVersion = saved.version)
                    db.drafts().enqueue(edit)
                    assertTrue(api.sendNoteEdit(session, assertNotNull(db.drafts().ready(origin, session.userId, id))))
                    db.drafts().acknowledge(origin, session.userId, id)
                    api.syncNotes(session, db.notes())
                }
                withDatabase(path) { reopened ->
                    val note = reopened.notes().list(origin, session.userId).single()
                    assertEquals(id, note.id)
                    assertEquals("Updated simulator note", note.title)
                    assertEquals(2L, note.version)
                    assertEquals(delta, note.content)
                    assertTrue(reopened.drafts().list(origin, session.userId).isEmpty())
                    assertTrue(!reopened.notes().cursor(origin, session.userId).isNullOrEmpty())
                }
            } finally {
                api.close()
                deleteFixtureDatabase(path)
            }
        }
    }

    @Test
    fun sharedNoteAndAttachmentSurviveRoomReopenAndReachConvexOnce() = runBlocking<Unit> {
        withTimeout(60_000) {
            val id = Uuid.random().toString()
            val root = Path(NSTemporaryDirectory(), "anchor-share-$id")
            val path = Path(root, "room.db")
            val readbackPath = Path(root, "readback.db")
            val inbox = Path(root, "inbox")
            val folder = Path(inbox, id)
            val manifest = Path(folder, "manifest.json")
            val file = Path(folder, "picture.png")
            val bytes = Base64.decode(
                "iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAAH0lEQVR4nGOQ6N5OFcQwatCoQaMGjRo0atCoQQNvEAArIQqu/dnjaAAAAABJRU5ErkJggg==",
            )
            val fs = SystemFileSystem
            val api = AnchorApi(FixtureSessionStore(), FixtureSessionStore()) { _, _ ->
                error("Fixture did not request account erasure")
            }
            try {
                val origin = "http://localhost:3971"
                val email = "anchor-ios-share-$id@example.test"
                val password = "Fixture-$id"
                assertTrue(api.register(origin, "iOS share", email, password) is AnchorSignIn.Complete)
                val session = (api.signIn(origin, email, password) as AnchorSignIn.Complete).session
                val userId = session.userId
                api.createTag(session, "Shared from iOS")
                fs.createDirectories(root)

                fun stage(tagId: String) {
                    fs.createDirectories(folder)
                    fs.sink(file).buffered().use { it.write(bytes) }
                    fs.sink(manifest).buffered().use {
                        it.writeString(
                            """{"version":1,"id":"$id","userId":"$userId","origin":"$origin",
                            "savedAt":"2026-11-23T09:00:00Z","title":"Shared picture","text":"From the share sheet",
                            "link":"https://example.test/anchor","tagIds":["$tagId"],
                            "files":[{"file":"picture.png","name":"Shared picture.png","mime":"image/png"}]}""",
                        )
                    }
                }

                val tagId = withDatabase(path) { db ->
                    api.syncNotes(session, db.notes())
                    val tagId = db.notes().tags(origin, userId).first().single().id
                    stage(tagId)
                    val otherServer = AnchorSession("https://other.example.test", userId, "", null)
                    assertTrue(db.importNativeShareInbox(otherServer, root).isEmpty())
                    assertTrue(fs.exists(manifest) && fs.exists(file))
                    assertEquals(id, db.importNativeShareInbox(session, root).single().id)
                    assertTrue(!fs.exists(folder))
                    tagId
                }
                val uploadId = withDatabase(path) { db ->
                    stage(tagId)
                    assertTrue(db.importNativeShareInbox(session, root).isEmpty())
                    assertTrue(!fs.exists(folder))
                    assertEquals(id, db.drafts().list(origin, userId).single().id)
                    assertTrue(db.legacyUpgrade().readyMetadata(origin, userId).isEmpty())
                    val outbox = db.attachmentOutbox()
                    assertTrue(outbox.observeReady(origin, userId).first().isEmpty())
                    assertEquals(1, outbox.observeNote(origin, userId, id).first().size)

                    val draft = assertNotNull(db.drafts().ready(origin, userId, id))
                    assertTrue(api.sendNoteEdit(session, draft))
                    db.drafts().acknowledge(origin, userId, id)
                    assertEquals(1, db.legacyUpgrade().readyMetadata(origin, userId).size)
                    assertTrue(!db.sendFlutterMetadata(session) { change, scope -> api.pushFlutterMetadata(session, change, scope) })
                    val upload = outbox.observeReady(origin, userId).first().single()
                    api.uploadAttachment(session, upload, outbox)
                    assertEquals(1, outbox.discard(origin, userId, upload.id))
                    assertTrue(db.drafts().list(origin, userId).isEmpty())
                    assertTrue(db.legacyUpgrade().metadata(origin, userId).isEmpty())
                    assertTrue(outbox.observe(origin, userId).first().isEmpty())
                    upload.id
                }
                withDatabase(readbackPath) { db ->
                    api.syncNotes(session, db.notes())
                    val note = db.notes().list(origin, userId).single()
                    assertEquals(id, note.id)
                    assertEquals("Shared picture", note.title)
                    assertEquals(
                        """{"ops":[{"insert":"From the share sheet\n"},{"insert":"https://example.test/anchor","attributes":{"link":"https://example.test/anchor"}},{"insert":"\n"}]}""",
                        note.content,
                    )
                    assertEquals(listOf(tagId), db.notes().assignedTags(origin, userId, id).first())
                    val attachment = db.notes().attachments(origin, userId, id).first().single()
                    assertEquals(uploadId, attachment.id)
                    assertEquals("Shared picture.png", attachment.originalFilename)
                    assertContentEquals(bytes, api.downloadAttachment(session, attachment))
                }
            } finally {
                api.close()
                for (target in listOf(file, manifest, folder, inbox)) {
                    fs.delete(target, mustExist = false)
                }
                deleteFixtureDatabase(path)
                deleteFixtureDatabase(readbackPath)
                fs.delete(root, mustExist = false)
            }
        }
    }

    private fun deleteFixtureDatabase(path: Path) {
        for (suffix in listOf("", "-wal", "-shm", ".lck")) {
            SystemFileSystem.delete(Path("$path$suffix"), mustExist = false)
        }
    }

    private suspend fun <T> withDatabase(path: Path, block: suspend (DraftDatabase) -> T): T {
        val database = openDraftDatabase(Room.databaseBuilder(
            name = path.toString(),
            factory = { DraftDatabaseConstructor.initialize() },
        ))
        return try {
            block(database)
        } finally {
            database.close()
        }
    }
}
