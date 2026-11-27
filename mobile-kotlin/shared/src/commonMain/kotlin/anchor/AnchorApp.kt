package anchor

import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.height
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.lazy.staggeredgrid.LazyVerticalStaggeredGrid
import androidx.compose.foundation.lazy.staggeredgrid.StaggeredGridCells
import androidx.compose.foundation.lazy.staggeredgrid.StaggeredGridItemSpan
import androidx.compose.foundation.lazy.staggeredgrid.rememberLazyStaggeredGridState
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.currentStateAsState
import androidx.sqlite.SQLiteException
import io.ktor.client.plugins.HttpRequestTimeoutException
import kotlin.uuid.ExperimentalUuidApi
import kotlin.uuid.Uuid
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.IO
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.random.Random
import kotlinx.io.IOException
import kotlinx.io.files.Path
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.PermanentDrawerSheet
import androidx.compose.material3.PermanentNavigationDrawer
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.rememberDrawerState

@OptIn(ExperimentalUuidApi::class)
@Composable
internal fun AnchorApp(
    sessionStore: SessionStore,
    oidcCallbacks: OidcBrowserCallbacks,
    legacyUpgradeSupport: Path,
    legacyUpgradeDocuments: Path,
    legacyUpgradeShareFolder: Path?,
    serverHeaderStore: SessionStore,
    incomingShares: MutableStateFlow<List<IncomingShare>>? = null,
    nativeShareFolder: Path? = null,
    publishReminders: (suspend (AnchorSession?, List<CachedNote>) -> Unit)? = null,
    publishWidget: (suspend (AnchorSession?, List<CachedNote>) -> Unit)? = null,
    noteLaunch: MutableStateFlow<NoteLaunch?>? = null,
    requestReminderPermission: (() -> Unit)? = null,
    onAppearanceChanged: ((AnchorAppearance, Boolean) -> Unit)? = null,
    createDatabase: () -> DraftDatabase,
) {
    val database = remember { createDatabase() }
    val api = remember(sessionStore, serverHeaderStore, database) {
        AnchorApi(sessionStore, serverHeaderStore, database::clearAccount)
    }
    val outbox = remember(database) { database.attachmentOutbox() }
    DisposableEffect(api, database) {
        onDispose {
            api.close()
            database.close()
        }
    }
    val scope = rememberCoroutineScope()
    var server by remember { mutableStateOf("") }
    var headersServer by remember { mutableStateOf<String?>(null) }
    var headerRevision by remember { mutableStateOf(0) }
    var oidc by remember(server) { mutableStateOf<AnchorOidcConfiguration?>(null) }
    var waitingForOidc by remember { mutableStateOf(false) }
    val openBrowser = rememberOpenBrowser()
    val oidcReturn by oidcCallbacks.pending.collectAsState()
    val incomingShare = incomingShares?.collectAsState()?.value?.firstOrNull()
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var signup by remember { mutableStateOf(false) }
    var signupName by remember { mutableStateOf("") }
    var signupServer by remember { mutableStateOf("") }
    var challenge by remember { mutableStateOf<AnchorSignIn.Challenge?>(null) }
    var browserPasskey by remember { mutableStateOf<AnchorSignIn.BrowserPasskey?>(null) }
    var enrollment by remember { mutableStateOf<AnchorSignIn.Enrollment?>(null) }
    var enrollmentKey by remember { mutableStateOf<String?>(null) }
    var enrolled by remember { mutableStateOf<EnrollmentResult?>(null) }
    var recovery by remember { mutableStateOf(false) }
    var signInCode by remember { mutableStateOf("") }
    var session by remember { mutableStateOf<AnchorSession?>(null) }
    var sessionResolved by remember { mutableStateOf(false) }
    var editorAccount by remember { mutableStateOf<Pair<String, String>?>(null) }
    val title = remember { mutableStateOf("") }
    val newNoteBody = remember { mutableStateOf<EditableDelta?>(EditableDelta.empty()) }
    val newNoteBackground = remember { mutableStateOf<String?>(null) }
    var newNoteEditorGeneration by remember { mutableStateOf(0) }
    var cachedNotes by remember { mutableStateOf(emptyList<CachedNote>()) }
    var folder by remember { mutableStateOf(NoteFolder.Notes) }
    var searchQuery by remember { mutableStateOf("") }
    var tagFilterId by remember(session) { mutableStateOf<String?>(null) }
    var selectedNoteIds by remember(session, folder, searchQuery, tagFilterId) { mutableStateOf<Set<String>?>(null) }
    var taggingSelection by remember(session, folder, searchQuery, tagFilterId) { mutableStateOf<List<CachedNote>?>(null) }
    var removingSelection by remember(session, folder, searchQuery, tagFilterId) { mutableStateOf<PendingSelectionRemoval?>(null) }
    var confirmDeletion by remember { mutableStateOf<CachedNote?>(null) }
    var openedNoteId by remember { mutableStateOf<String?>(null) }
    // True while the opened note has unsaved edits; nothing may swap or close it then.
    var openedDirty by remember { mutableStateOf(false) }
    var jumpToNote by remember { mutableStateOf<String?>(null) }
    var composerOpen by remember { mutableStateOf(false) }
    var noteLibraryPreferences by remember { mutableStateOf(NoteLibraryPreferences()) }
    val noteLayout = noteLibraryPreferences.layout
    var noteLibraryPreferencesReady by remember { mutableStateOf(false) }
    var localHistory by remember(session, openedNoteId) { mutableStateOf(emptyList<NoteRevision>()) }
    var historyNoteId by remember { mutableStateOf<String?>(null) }
    var reviewingDraft by remember { mutableStateOf<PendingNote?>(null) }
    var pending by remember { mutableStateOf(emptyList<PendingNote>()) }
    var sendingAttachmentId by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(true) }
    var manualSync by remember { mutableStateOf(false) }
    var syncFailed by remember { mutableStateOf(false) }
    var firstPullDone by remember { mutableStateOf(false) }
    var factorSettingsOpen by remember { mutableStateOf(false) }
    var accountSettingsOpen by remember { mutableStateOf(false) }
    var deletingAccount by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf("") }
    val transferAttachment = rememberTransferAttachment { action, result ->
        busy = false
        val error = result.exceptionOrNull()
        message = when {
            error == null -> if (result.getOrNull() == true) when (action) {
                AttachmentTransfer.Download -> "Attachment saved."
                AttachmentTransfer.Photo -> "Saved to Photos."
                AttachmentTransfer.Share -> ""
            } else ""
            error is AnchorHttpFailure && error.status in setOf(403, 404) -> "This attachment is no longer available."
            error is PhotoPermissionDenied -> "Allow photo access in Settings to save this image."
            action == AttachmentTransfer.Share -> "Could not share the attachment."
            action == AttachmentTransfer.Photo -> "Could not save to Photos."
            else -> "Could not save the attachment."
        }
    }
    var undoCopy by remember { mutableStateOf<Pair<String, NoteCopy>?>(null) }
    var legacyUpgradeRequired by remember { mutableStateOf(false) }

    suspend fun downloadAttachment(active: AnchorSession, file: CachedAttachment, expectedScope: String?): ByteArray =
        try {
            api.downloadAttachment(active, file)
        } catch (error: AnchorHttpFailure) {
            if (error.status in setOf(403, 404)) database.notes().discardUnavailableAttachment(file, expectedScope)
            throw error
        }

    suspend fun previewAttachment(active: AnchorSession, file: CachedAttachment): ByteArray {
        val cache = database.notes()
        cache.readCachedAttachment(file)?.let { return it }
        database.readFlutterAttachment(active, file, legacyUpgradeSupport)?.let { return it }
        val currentScope = cache.scope(active.origin, active.userId)
        val bytes = downloadAttachment(active, file, currentScope)
        check(session === active && !deletingAccount)
        val stillAvailable = try {
            cache.cacheAttachment(file, currentScope, bytes)
        } catch (_: SQLiteException) {
            cache.stillHasAttachment(file, currentScope)
        }
        if (!stillAvailable) throw AnchorHttpFailure(404)
        return bytes
    }

    val cardPictureLock = remember { Mutex() }
    suspend fun previewCardPicture(active: AnchorSession, file: CachedAttachment) = cardPictureLock.withLock {
        val dao = database.notes()
        val scope = dao.scope(active.origin, active.userId)
        val picture = decodeAttachmentImage(previewAttachment(active, file), maxDimension = 512)
        picture.takeIf { session === active && !deletingAccount && dao.stillHasAttachment(file, scope) }
    }

    LaunchedEffect(legacyUpgradeSupport, legacyUpgradeShareFolder) {
        val path = Path(legacyUpgradeSupport, "note-layout")
        noteLibraryPreferences = withContext(Dispatchers.IO) { readNoteLibraryPreferences(path, legacyUpgradeShareFolder) }
        noteLibraryPreferencesReady = true
        snapshotFlow { noteLibraryPreferences }.drop(1).collect { preferences ->
            withContext(Dispatchers.IO) { runCatching { saveNoteLibraryPreferences(path, preferences) } }
                .onFailure { message = "Could not save the library view on this device." }
        }
    }

    LaunchedEffect(session, openedNoteId) {
        val active = session ?: return@LaunchedEffect
        val id = openedNoteId ?: return@LaunchedEffect
        localHistory = database.readFlutterRevisions(active, id)
    }

    fun clearNewNote() {
        title.value = ""
        newNoteBody.value = EditableDelta.empty()
        newNoteBackground.value = null
        newNoteEditorGeneration++
    }

    suspend fun activate(active: AnchorSession) {
        val account = active.origin to active.userId
        if (editorAccount != account) {
            clearNewNote()
            undoCopy = null
            editorAccount = account
        }
        legacyUpgradeRequired = try {
            database.importStagedLegacyUpgrade(legacyUpgradeSupport, active, legacyUpgradeDocuments, legacyUpgradeShareFolder)
            false
        } catch (_: LegacyUpgradeExportRequired) {
            true
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            message = "Could not import notes from the previous app. The local backup is still available."
            false
        }
        pending = database.drafts().list(active.origin, active.userId)
        cachedNotes = database.notes().list(active.origin, active.userId)
        session = active
    }

    fun detachSession() {
        factorSettingsOpen = false
        accountSettingsOpen = false
        session = null
        headersServer = null
        undoCopy = null
        legacyUpgradeRequired = false
        cachedNotes = emptyList()
        folder = NoteFolder.Notes
        searchQuery = ""
        confirmDeletion = null
        openedNoteId = null
        jumpToNote = null
        composerOpen = false
        historyNoteId = null
        syncFailed = false
        firstPullDone = false
        reviewingDraft = null
        pending = emptyList()
    }

    suspend fun acceptSignIn(result: AnchorSignIn) {
        password = ""
        when (result) {
            is AnchorSignIn.Complete -> activate(result.session)
            is AnchorSignIn.Challenge -> challenge = result
            is AnchorSignIn.Enrollment -> enrollment = result
            is AnchorSignIn.BrowserPasskey -> browserPasskey = result
            AnchorSignIn.PendingApproval -> message = "Your account is waiting for administrator approval."
        }
    }

    LaunchedEffect(api) {
        try {
            try {
                api.restoreServerHeaders()
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                message = "Could not read saved server headers."
            }
            val restored = api.restoreSession()
            if (restored != null) {
                server = restored.origin
                activate(restored)
            } else api.pendingOidcOrigin()?.let {
                server = it
                waitingForOidc = true
            }
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            message = "Could not restore your session. Sign in again."
        } finally {
            busy = false
            sessionResolved = true
        }
    }

    val lifecycle by LocalLifecycleOwner.current.lifecycle.currentStateAsState()
    val foreground = lifecycle.isAtLeast(Lifecycle.State.RESUMED)
    LaunchedEffect(sessionResolved, session, cachedNotes, foreground, publishReminders) {
        if (!sessionResolved || publishReminders == null || (!foreground && session != null)) return@LaunchedEffect
        try {
            publishReminders(session, cachedNotes)
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            message = "Could not schedule reminders on this device."
        }
    }

    LaunchedEffect(sessionResolved, session, cachedNotes, foreground, publishWidget) {
        if (!sessionResolved || !foreground || publishWidget == null) return@LaunchedEffect
        try {
            publishWidget(session, cachedNotes)
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            message = "Could not update the home screen widget."
        }
    }

    val requestedNote = noteLaunch?.collectAsState()?.value
    LaunchedEffect(sessionResolved, session, cachedNotes, requestedNote) {
        val request = requestedNote ?: return@LaunchedEffect
        if (!sessionResolved) return@LaunchedEffect
        val active = session
        if (active?.origin == request.origin && active.userId == request.userId) {
            val note = request.noteId?.let { id ->
                cachedNotes.firstOrNull { it.id == id } ?: return@LaunchedEffect
            }
            if (openedDirty && openedNoteId != note?.id) {
                message = "Save or discard your changes before opening another note."
                noteLaunch.value = null
                return@LaunchedEffect
            }
            factorSettingsOpen = false
            accountSettingsOpen = false
            historyNoteId = null
            folder = note?.folder ?: NoteFolder.Notes
            searchQuery = ""
            tagFilterId = null
            openedNoteId = note?.id
            jumpToNote = note?.id
            if (note == null) composerOpen = true
        }
        noteLaunch.value = null
    }

    fun resetChallenge() {
        challenge = null
        browserPasskey = null
        enrollment = null
        enrollmentKey = null
        enrolled = null
        signInCode = ""
        recovery = false
    }

    fun request(failure: (Exception) -> String, work: suspend () -> Unit) {
        if (busy) return
        busy = true
        message = ""
        scope.launch {
            try {
                work()
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                message = failure(error)
            } finally {
                busy = false
            }
        }
    }

    LaunchedEffect(server, session, headerRevision) {
        if (server.isBlank() || session != null) return@LaunchedEffect
        delay(350)
        oidc = try {
            api.oidcConfiguration(server)
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            null
        }
    }

    LaunchedEffect(oidcReturn, waitingForOidc, busy) {
        val returned = oidcReturn ?: return@LaunchedEffect
        if (busy) return@LaunchedEffect
        oidcCallbacks.pending.value = null
        if (!waitingForOidc || session != null) return@LaunchedEffect
        request({ error ->
            when ((error as? AnchorHttpFailure)?.code) {
                "ACCOUNT_PENDING" -> "Your account is waiting for administrator approval."
                "ADDITIONAL_FACTOR_REQUIRED" -> "Sign in with your password and second factor."
                else -> "Could not complete browser sign-in. Try again."
            }
        }) {
            val restored = api.completeOidc(returned)
            if (restored == null) {
                waitingForOidc = false
                message = "Browser sign-in expired. Try again."
            } else {
                waitingForOidc = false
                server = restored.origin
                acceptSignIn(AnchorSignIn.Complete(restored))
            }
        }
    }

    val sendLock = remember { Mutex() }

    suspend fun queueNewNote(
        activeSession: AnchorSession,
        recording: PickedAttachment? = null,
    ): PendingNote = sendLock.withLock {
        check(session === activeSession && !deletingAccount)
        val draft = PendingNote(
            activeSession.origin, activeSession.userId, Uuid.random().toString(),
            title.value.ifBlank { if (recording != null) "Audio note" else "" },
            content = "", deltaContent = checkNotNull(newNoteBody.value).encode(),
            backgroundChange = newNoteBackground.value,
        )
        if (recording == null) database.drafts().enqueue(draft)
        else database.enqueueNoteWithRecording(draft, recording)
        pending = pending + draft
        clearNewNote()
        draft
    }

    suspend fun sendDraft(activeSession: AnchorSession, queued: PendingNote): String? = sendLock.withLock {
        if (session !== activeSession) return@withLock null
        val draft = database.drafts().ready(activeSession.origin, activeSession.userId, queued.id)
            ?: return@withLock null
        var rejectionMessage = "The note changed on the server. Your draft is still on this device."
        val stored = try {
            if (draft.baseVersion == null && draft.flutterFields == null) api.createNote(activeSession, draft)
            else draft.title.takeIf { api.sendNoteEdit(activeSession, draft) }
        } catch (error: AnchorHttpFailure) {
            if (!error.outboxScopeChanged) throw error
            rejectionMessage = "This draft belongs to the previous server. It is still on this device."
            null
        }
        if (stored == null) {
            database.drafts().markRejected(draft.origin, draft.userId, draft.id)
            pending = pending.map { if (it.id == draft.id) it.copy(rejected = true) else it }
            message = rejectionMessage
            return@withLock null
        }
        database.drafts().acknowledge(draft.origin, draft.userId, draft.id)
        pending = pending.filterNot { it.id == draft.id }
        stored
    }

    suspend fun sendPending(activeSession: AnchorSession): Boolean {
        var retryable = false
        for (draft in pending.filterNot { it.rejected }) {
            try {
                sendDraft(activeSession, draft)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                retryable = retryable || isTemporarySyncFailure(error)
            }
        }
        return retryable
    }

    val pullLock = remember { Mutex() }

    suspend fun pullNotes(activeSession: AnchorSession) = pullLock.withLock {
        val opened = cachedNotes.firstOrNull { it.id == openedNoteId && it.canEdit }
        try {
            api.syncNotes(activeSession, database.notes())
            if (session === activeSession) syncFailed = false
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            if (session === activeSession && isTemporarySyncFailure(error)) syncFailed = true
            throw error
        } finally {
            if (session === activeSession) {
                cachedNotes = database.notes().list(activeSession.origin, activeSession.userId)
                firstPullDone = true
            }
        }
        if (session === activeSession && opened != null && openedNoteId == opened.id && cachedNotes.none { it.id == opened.id && it.canEdit }) {
            message = "You can no longer edit this note."
        }
    }

    suspend fun hasPendingCopyChanges(active: AnchorSession, noteId: String): Boolean =
        database.drafts().list(active.origin, active.userId).any { it.id == noteId } ||
            outbox.observeNote(active.origin, active.userId, noteId).first().isNotEmpty() ||
            database.legacyUpgrade().hasCopyChanges(active.origin, active.userId, noteId)

    fun canReadDraft(draft: PendingNote): Boolean =
        draft.baseVersion == null || cachedNotes.any {
            it.id == draft.id && it.origin == draft.origin && it.userId == draft.userId
        }

    fun copyNote(active: AnchorSession, note: CachedNote) =
        request({ "Could not confirm the copy. Sync notes before trying again." }) copy@{
            if (hasPendingCopyChanges(active, note.id)) {
                message = "Sync this note's local changes before making a copy."
                return@copy
            }
            val result = api.copyNote(active, note)
            undoCopy = result.undoSequence?.let { note.id to result }
            message = "Note copied. Sync notes to open it on this device."
            try {
                pullNotes(active)
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                return@copy
            }
            if (session === active && !openedDirty && cachedNotes.any { it.id == result.id }) {
                folder = NoteFolder.Notes
                searchQuery = ""
                tagFilterId = null
                openedNoteId = result.id
                jumpToNote = result.id
                message = "Note copied."
            }
        }

    fun undoNoteCopy(active: AnchorSession, sourceId: String, copy: NoteCopy) =
        request({ "Could not undo the copy. Try again when connected." }) undo@{
            if (hasPendingCopyChanges(active, copy.id) || openedNoteId == copy.id && openedDirty) {
                message = "The copy has local changes. Keep it or discard those changes before undoing."
                return@undo
            }
            try {
                api.undoNoteCopy(active, copy)
            } catch (error: AnchorHttpFailure) {
                if (error.code != "NOTE_CHANGED") throw error
                undoCopy = null
                message = "The copy has changed. It was kept."
                return@undo
            }
            undoCopy = null
            val reopenSource = openedNoteId == copy.id
            if (reopenSource) openedNoteId = null
            message = "Copy removed. Sync notes to update this device."
            try {
                pullNotes(active)
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                return@undo
            }
            if (reopenSource && session === active && openedNoteId == null) cachedNotes.firstOrNull { it.id == sourceId }?.let { source ->
                folder = source.folder
                searchQuery = ""
                tagFilterId = null
                openedNoteId = source.id
                jumpToNote = source.id
            }
            message = "Copy undone."
        }

    fun updateLibraryNote(
        active: AnchorSession,
        conflictMessage: String? = null,
        successMessage: String? = null,
        onSynced: () -> Unit = {},
        update: suspend () -> Unit,
    ) {
        request({ error ->
            val failure = error as? AnchorHttpFailure
            when {
                failure?.code == "TAG_NAME_EXISTS" -> "A tag with that name already exists."
                failure?.status == 409 -> conflictMessage ?: "The note changed. Sync before trying again."
                else -> "Could not save the change. Try again."
            }
        }) {
            update()
            try {
                pullNotes(active)
                onSynced()
                if (successMessage != null) message = successMessage
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                message = "Change saved on the server. Sync to update this device."
            }
        }
    }

    fun reorderNote(active: AnchorSession, notes: List<CachedNote>, note: CachedNote, step: Int, otherGroup: List<CachedNote>) {
        val previousSort = noteLibraryPreferences.sort
        updateLibraryNote(
            active,
            conflictMessage = "The order changed. Sync notes before moving this note.",
            successMessage = if (step < 0) "Note moved up." else "Note moved down.",
            onSynced = {
                if (session === active && previousSort != NoteSort.Custom && noteLibraryPreferences.sort == previousSort) {
                    noteLibraryPreferences = noteLibraryPreferences.copy(sort = NoteSort.Custom)
                }
            },
        ) {
            api.moveNote(active, notes, note.id, step, otherGroup)
        }
    }

    fun updateSelectedNotes(active: AnchorSession, notes: List<CachedNote>, action: suspend (CachedNote) -> Unit) {
        val selection = selectedNoteIds
        request({ "Could not confirm all changes. Sync notes before trying again." }) {
            val failed = mutableSetOf<String>()
            for (note in notes) {
                if (session !== active) return@request
                try {
                    action(note)
                } catch (error: CancellationException) {
                    throw error
                } catch (_: Exception) {
                    failed.add(note.id)
                }
            }
            pullNotes(active)
            if (session !== active) return@request
            if (selection != null && selectedNoteIds === selection) selectedNoteIds = failed.takeIf { it.isNotEmpty() }
            val updated = notes.size - failed.size
            val summary = if (updated == 1) "1 note updated." else "$updated notes updated."
            message = if (failed.isEmpty()) summary else "$summary ${failed.size} changes could not be confirmed."
        }
    }

    fun removeSelectedNotes(active: AnchorSession, removal: PendingSelectionRemoval) {
        updateSelectedNotes(active, removal.notes) { note ->
            sendLock.withLock {
                check(!hasPendingCopyChanges(active, note.id))
                check(session === active)
                if (removal.action != SelectionRemoval.Trash) api.changeNoteFolder(active, note, null)
                else if (note.isOwner) api.changeNoteFolder(active, note, NoteFolder.Trash)
                else api.leaveSharedNote(active, note)
            }
        }
    }

    fun moveNote(active: AnchorSession, note: CachedNote, destination: NoteFolder?) =
        updateLibraryNote(active) {
            api.changeNoteFolder(active, note, destination)
            // Restoring or unarchiving keeps the note open; other moves return to the list.
            if (openedNoteId == note.id && destination != NoteFolder.Notes) openedNoteId = null
        }

    val attachmentSendLock = remember { Mutex() }

    LaunchedEffect(nativeShareFolder, session, deletingAccount) {
        val shareFolder = nativeShareFolder ?: return@LaunchedEffect
        val active = session
        try {
            if (active == null || deletingAccount) {
                publishShareContext(shareFolder, null, emptyList(), AnchorAppearance.System)
            } else {
                combine(
                    database.notes().tags(active.origin, active.userId),
                    snapshotFlow { noteLibraryPreferences.theme to noteLibraryPreferences.density },
                    ::Pair,
                ).collect { (tags, appearance) ->
                    val (theme, density) = appearance
                    publishShareContext(shareFolder, active, tags, theme, density)
                }
            }
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            message = "Could not update the share extension."
        }
    }

    LaunchedEffect(nativeShareFolder, session, foreground, deletingAccount) {
        val shareFolder = nativeShareFolder ?: return@LaunchedEffect
        val active = session ?: return@LaunchedEffect
        if (!foreground || deletingAccount) return@LaunchedEffect
        try {
            sendLock.withLock {
                if (session !== active || deletingAccount) return@withLock
                val saved = database.importNativeShareInbox(active, shareFolder)
                if (session === active && saved.isNotEmpty()) {
                    pending = pending + saved
                    message = "Shared notes saved on this device."
                }
            }
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            message = "Could not open the share inbox."
        }
    }

    suspend fun deleteCurrentAccount(active: AnchorSession, password: String?) {
        deletingAccount = true
        try {
            api.deleteAccount(active, password)
            withContext(NonCancellable) {
                val cleaned = try {
                    sendLock.withLock {
                        pullLock.withLock {
                            api.forgetDeletedAccount(active)
                        }
                    }
                    true
                } catch (_: Exception) {
                    false
                }
                detachSession()
                clearNewNote()
                editorAccount = null
                message = if (cleaned) "Account deleted." else "Account deleted. Restart Anchor to retry clearing local data."
            }
        } finally {
            deletingAccount = false
        }
    }

    LaunchedEffect(session, deletingAccount) {
        val activeSession = session ?: return@LaunchedEffect
        if (deletingAccount) return@LaunchedEffect
        activeSession.expired.first { it }
        if (session !== activeSession || deletingAccount) return@LaunchedEffect
        detachSession()
        message = "Your session expired. Sign in again."
    }

    LaunchedEffect(session, foreground, deletingAccount, headerRevision) {
        val activeSession = session ?: return@LaunchedEffect
        if (!foreground || deletingAccount) return@LaunchedEffect
        val origin = activeSession.origin
        val userId = activeSession.userId
        val uploads = outbox.observeReady(origin, userId)
        var retryMillis = 3_000L
        while (true) {
            val queued = uploads.first { it.isNotEmpty() }
            var sent = false
            var retry = false
            for (queuedUpload in queued) {
                val item = attachmentSendLock.withLock {
                    val current = uploads.first().firstOrNull { it.id == queuedUpload.id } ?: return@withLock null
                    sendingAttachmentId = current.id
                    current
                } ?: continue
                try {
                    api.uploadAttachment(activeSession, item, outbox)
                    outbox.discard(origin, userId, item.id)
                    sent = true
                } catch (error: CancellationException) {
                    throw error
                } catch (error: Exception) {
                    val failure = error as? AnchorHttpFailure
                    when {
                        failure?.outboxScopeChanged == true -> {
                            outbox.reject(origin, userId, item.id)
                            message = "The attachment is still on this device."
                        }
                        failure?.code == "ATTACHMENT_NOT_FOUND" || failure?.code == "ATTACHMENT_DELETED" -> {
                            if (item.retainOnMissingNote) {
                                outbox.reject(origin, userId, item.id)
                                message = "An attachment from Flutter could not be uploaded. Its local copy is still available."
                            } else {
                                outbox.discard(origin, userId, item.id)
                                message = "Upload removed because the note or attachment is no longer available."
                            }
                        }
                        failure?.status in listOf(400, 411, 413, 415) -> outbox.reject(origin, userId, item.id)
                        else -> retry = true
                    }
                } finally {
                    sendingAttachmentId = null
                }
            }
            if (sent) {
                try {
                    pullNotes(activeSession)
                } catch (error: CancellationException) {
                    throw error
                } catch (_: Exception) {
                    message = "Attachments uploaded. Sync to update the list."
                }
            }
            if (retry) {
                delay(retryMillis)
                retryMillis = (retryMillis * 2).coerceAtMost(30_000L)
            } else {
                retryMillis = 3_000L
            }
        }
    }

    LaunchedEffect(session, foreground, deletingAccount, headerRevision) {
        val activeSession = session ?: return@LaunchedEffect
        if (!foreground || deletingAccount) return@LaunchedEffect
        while (true) {
            snapshotFlow { pending }.first { drafts -> drafts.any { !it.rejected } }
            var waitMillis = 3_000L
            do {
                delay(waitMillis)
                if (pending.none { !it.rejected }) break
                val retryable = sendPending(activeSession)
                if (pending.isEmpty()) {
                    message = "Pending notes sent."
                } else if (!retryable) {
                    val remaining = pending
                    snapshotFlow { pending }.first { it != remaining }
                    break
                }
                waitMillis = (waitMillis * 2).coerceAtMost(30_000L)
            } while (pending.any { !it.rejected })
        }
    }

    val syncSignals = remember(session, foreground, deletingAccount, headerRevision) { Channel<Unit>(Channel.CONFLATED) }
    LaunchedEffect(session, foreground, deletingAccount, headerRevision) {
        val active = session ?: return@LaunchedEffect
        if (!foreground || deletingAccount) return@LaunchedEffect
        val ready = database.legacyUpgrade().observeReadyMetadata(active.origin, active.userId)
        var retryMillis = 3_000L
        while (true) {
            ready.first { it.isNotEmpty() }
            try {
                val rejected = pullLock.withLock {
                    if (session !== active || deletingAccount) return@LaunchedEffect
                    database.sendFlutterMetadata(active) { change, scope -> api.pushFlutterMetadata(active, change, scope) }
                }
                if (rejected) message = "Some changes from Flutter could not be synced. Their local copies are still available."
                syncSignals.trySend(Unit)
                retryMillis = 3_000L
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                if (!isTemporarySyncFailure(error)) return@LaunchedEffect
                delay(retryMillis)
                retryMillis = (retryMillis * 2).coerceAtMost(30_000L)
            }
        }
    }

    LaunchedEffect(session, foreground, deletingAccount, headerRevision) {
        val activeSession = session ?: return@LaunchedEffect
        if (!foreground || deletingAccount) return@LaunchedEffect
        var retryMillis = 1_000L
        while (!activeSession.expired.value) {
            try {
                val supported = api.receiveSyncSignals(activeSession) {
                    retryMillis = 1_000L
                    syncSignals.trySend(Unit)
                }
                if (!supported) return@LaunchedEffect
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                if ((error as? AnchorHttpFailure)?.status != 401 && !isTemporarySyncFailure(error))
                    return@LaunchedEffect
            }
            delay(retryMillis + Random.nextLong(retryMillis / 4))
            retryMillis = (retryMillis * 2).coerceAtMost(30_000L)
        }
    }

    LaunchedEffect(session, foreground, deletingAccount, headerRevision) {
        val activeSession = session ?: return@LaunchedEffect
        if (!foreground || deletingAccount) return@LaunchedEffect
        var retryMillis = 3_000L
        while (true) {
            try {
                pullNotes(activeSession)
                retryMillis = 3_000L
                withTimeoutOrNull(10_000L) { syncSignals.receive() }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                if (!isTemporarySyncFailure(error)) return@LaunchedEffect
                delay(retryMillis)
                retryMillis = (retryMillis * 2).coerceAtMost(30_000L)
            }
        }
    }

    val appearance = noteLibraryPreferences.theme
    val darkTheme = when (appearance) {
        AnchorAppearance.Light -> false
        AnchorAppearance.Dark -> true
        AnchorAppearance.System -> isSystemInDarkTheme()
    }
    LaunchedEffect(appearance, darkTheme) { onAppearanceChanged?.invoke(appearance, darkTheme) }
    val density = noteLibraryPreferences.density
    val undoOffered = undoCopy != null && message in copyMessages
    val editingCopy = undoOffered && openedNoteId == undoCopy?.second?.id
    LaunchedEffect(message, session, undoOffered, editingCopy) {
        if (message.isEmpty() || session == null || editingCopy) return@LaunchedEffect
        delay(if (undoOffered) 15_000L else 8_000L)
        message = ""
        undoCopy = null
    }

    fun syncNow(active: AnchorSession) = request({ "Could not finish syncing notes. Try again." }) {
        manualSync = true
        try {
            pullNotes(active)
        } finally {
            manualSync = false
        }
    }

    val toastSession = session
    val toast = message.takeIf { it.isNotEmpty() && toastSession != null }?.let { text ->
        val undo = undoCopy
        when {
            toastSession != null && undo != null && undoOffered -> Toast(text, "Undo") { undoNoteCopy(toastSession, undo.first, undo.second) }
            toastSession != null && text == "Could not finish syncing notes. Try again." -> Toast(text, "Retry") { syncNow(toastSession) }
            else -> Toast(text)
        }
    }

    AnchorTheme(darkTheme, noteLibraryPreferences.noteFont, noteLibraryPreferences.noteTextSize, density) {
        val activeSession = session
        headersServer?.let { address ->
            ServerHeadersDialog(address, api.headersFor(address), onClose = { headersServer = null }) {
                api.saveServerHeaders(address, it)
                headerRevision++
            }
        }
        var profile by remember(activeSession) { mutableStateOf<AccountProfile?>(null) }
        LaunchedEffect(activeSession, accountSettingsOpen) {
            val active = activeSession ?: return@LaunchedEffect
            if (accountSettingsOpen) return@LaunchedEffect
            profile = try {
                api.accountProfile(active)
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                profile
            }
        }
        if (incomingShares != null && incomingShare != null && activeSession != null && !deletingAccount) {
            val share = incomingShare
            fun dismiss() { incomingShares.update { items -> items.filterNot { it.id == share.id } } }
            AnchorSheet(onDismiss = { if (!busy) dismiss() }, title = share.title.ifBlank { null }) {
                if (share.text.isNotBlank()) SelectionContainer(
                    Modifier.heightIn(max = 280.dp).verticalScroll(rememberScrollState()),
                ) { Text(share.text) }
                if (share.files.isNotEmpty()) NoteChip(
                    if (share.files.size == 1) "1 attachment" else "${share.files.size} attachments", AnchorIcons.Paperclip,
                )
                Row(Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    AnchorButton("Cancel", ::dismiss, Modifier.weight(1f), ButtonTone.Secondary, enabled = !busy)
                    AnchorButton(if (busy) "Saving…" else "Save note", {
                        request({ "Could not save the shared note. Check that its attachments are still available." }) {
                            sendLock.withLock {
                                check(session === activeSession && !deletingAccount)
                                val draft = database.saveIncomingShare(activeSession, share)
                                dismiss()
                                if (draft != null && session === activeSession) {
                                    pending = pending + draft
                                    message = "Shared note saved on this device."
                                }
                            }
                        }
                    }, Modifier.weight(1f), enabled = !busy)
                }
            }
        }
        val rejectedDraft = reviewingDraft
        if (rejectedDraft != null) {
            ReviewNoteEdit(rejectedDraft.takeIf(::canReadDraft), onClose = { reviewingDraft = null }) {
                sendLock.withLock {
                    database.discardDraft(rejectedDraft)
                    pending = pending.filterNot { it.id == rejectedDraft.id }
                    reviewingDraft = null
                }
            }
        }
        val deletion = confirmDeletion
        if (activeSession != null && deletion != null) {
            ConfirmDialog(
                title = "Delete note permanently?",
                text = "This can’t be undone.",
                confirmLabel = "Delete permanently",
                onDismiss = { confirmDeletion = null },
                onConfirm = {
                    confirmDeletion = null
                    moveNote(activeSession, deletion, null)
                },
            )
        }
        val libraryShown = activeSession != null && enrolled == null && enrollment == null &&
            challenge == null && !accountSettingsOpen && !factorSettingsOpen
        if (libraryShown) {
            taggingSelection?.let { notes ->
                SelectedNoteTags(database.notes(), activeSession, onTag = { tag ->
                    taggingSelection = null
                    updateSelectedNotes(activeSession, notes) { api.assignTag(activeSession, it, tag, true) }
                }, onDismiss = { taggingSelection = null })
            }
            removingSelection?.let { removal ->
                val count = removal.notes.size
                val notes = if (count == 1) "1 note" else "$count notes"
                val shared = removal.notes.count { !it.isOwner }
                val sharedNotes = if (shared == 1) "1 shared note" else "$shared shared notes"
                ConfirmDialog(
                    title = removal.action.title,
                    text = when {
                        removal.action != SelectionRemoval.Trash -> "$notes will be permanently deleted. This can’t be undone."
                        shared == count -> "This removes your access to $sharedNotes."
                        shared > 0 -> "This removes your access to $sharedNotes and moves ${count - shared} of your notes to trash."
                        else -> "$notes will be moved to trash."
                    },
                    confirmLabel = removal.action.button,
                    enabled = !busy,
                    onDismiss = { removingSelection = null },
                    onConfirm = {
                        removingSelection = null
                        removeSelectedNotes(activeSession, removal)
                    },
                )
            }
        }
        val grid = rememberLazyStaggeredGridState()
        val orderDrag = remember(grid, activeSession) { NoteOrderDrag(grid) }
        val term = searchQuery.trim()
        val tags = if (activeSession == null) null else key(activeSession) {
            val cached by remember(database, activeSession) {
                database.notes().tags(activeSession.origin, activeSession.userId)
            }.collectAsState(null)
            cached
        }
        val assignments = if (activeSession == null) emptyList() else key(activeSession) {
            val cached by remember(database, activeSession) {
                database.notes().searchTags(activeSession.origin, activeSession.userId)
            }.collectAsState(emptyList())
            cached
        }
        val tagNames = remember(assignments) { assignments.groupBy({ it.noteId }, { it.name }) }
        val filter = tagFilterId
        LaunchedEffect(filter, tags) {
            if (filter != null && tags != null && tags.none { it.id == filter }) tagFilterId = null
        }
        val visible = if (!libraryShown) emptyList() else if (term.isEmpty() && filter == null) {
            remember(cachedNotes, folder) { cachedNotes.filter { it.folder == folder } }
        } else {
            val searchFolder = folder
            val notes = cachedNotes
            key(searchFolder, term, notes, assignments, filter) {
                val result by produceState<List<CachedNote>?>(null) {
                    value = withContext(Dispatchers.Default) {
                        val scope = if (filter == null) notes else {
                            val ids = assignments.filter { it.tagId == filter }.mapTo(mutableSetOf()) { it.noteId }
                            notes.filter { it.id in ids }
                        }
                        searchNotes(scope, searchFolder, term, if (term.isEmpty()) emptyMap() else tagNames)
                            .sortedBy { it.folder }
                    }
                }
                result
            }
        }
        val sort = noteLibraryPreferences.sort
        val selection = selectedNoteIds
        val selectable = remember(visible, folder, pending) {
            val pendingIds = pending.mapTo(mutableSetOf()) { it.id }
            visible.orEmpty().filter { it.folder == folder && it.version > 0 && it.id !in pendingIds }
        }
        val selectableIds = remember(selectable) { selectable.mapTo(mutableSetOf()) { it.id } }
        val selected = if (selection == null) emptyList() else selectable.filter { it.id in selection }
        val sections = remember(visible, folder, sort) {
            noteSections(sortLibraryNotes(visible.orEmpty(), sort), folder)
        }
        fun reorderKeysOf(section: NoteSection): Set<String> =
            if (selection == null && filter == null && folder == NoteFolder.Notes && term.isEmpty() &&
                section.notes.size > 1 && section.notes.first().folder == NoteFolder.Notes) {
                section.notes.mapTo(mutableSetOf()) { "note/${it.id}" }
            } else emptySet()
        fun otherGroupOf(section: NoteSection): List<CachedNote> = if (sort != NoteSort.Custom) {
            sections.firstOrNull { it !== section && it.notes.firstOrNull()?.folder == NoteFolder.Notes }?.notes.orEmpty()
        } else emptyList()
        LaunchedEffect(jumpToNote, sections, libraryShown) {
            val requested = jumpToNote ?: return@LaunchedEffect
            if (!libraryShown) return@LaunchedEffect
            var index = 1 // The status item occupies the first full-width row.
            for (section in sections) {
                if (section.title != null) index++
                val position = section.notes.indexOfFirst { it.id == requested }
                if (position >= 0) {
                    grid.scrollToItem(index + position)
                    jumpToNote = null
                    break
                }
                index += section.notes.size
            }
        }

        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            Box(Modifier.fillMaxSize().safeDrawingPadding()) {
                when {
                    !sessionResolved -> LaunchScreen()
                    activeSession != null && factorSettingsOpen -> key(activeSession) {
                        AuthenticatorSettings(api, activeSession) { factorSettingsOpen = false }
                    }
                    activeSession != null && accountSettingsOpen -> StackedScreen(
                        "Settings", { accountSettingsOpen = false }, backLabel = "Back to notes",
                    ) {
                        SystemBackHandler(true) { accountSettingsOpen = false }
                        key(activeSession) {
                            AccountSettings(
                                api, activeSession,
                                appearance = appearance.takeIf { noteLibraryPreferencesReady },
                                onAppearance = { noteLibraryPreferences = noteLibraryPreferences.copy(theme = it) },
                                density = density,
                                onDensity = { noteLibraryPreferences = noteLibraryPreferences.copy(density = it) },
                                showCardPictures = noteLibraryPreferences.showCardPictures,
                                onShowCardPictures = { noteLibraryPreferences = noteLibraryPreferences.copy(showCardPictures = it) },
                                startNewNotesInBody = noteLibraryPreferences.startNewNotesInBody,
                                onStartNewNotesInBody = {
                                    noteLibraryPreferences = noteLibraryPreferences.copy(startNewNotesInBody = it)
                                },
                                noteFont = noteLibraryPreferences.noteFont,
                                onNoteFont = { noteLibraryPreferences = noteLibraryPreferences.copy(noteFont = it) },
                                noteTextSize = noteLibraryPreferences.noteTextSize,
                                onNoteTextSize = { noteLibraryPreferences = noteLibraryPreferences.copy(noteTextSize = it) },
                                sortChecklistItems = noteLibraryPreferences.sortChecklistItems,
                                onSortChecklistItems = {
                                    noteLibraryPreferences = noteLibraryPreferences.copy(sortChecklistItems = it)
                                },
                                onDelete = { deleteCurrentAccount(activeSession, it) },
                            )
                        }
                    }
                    libraryShown -> BoxWithConstraints(Modifier.fillMaxSize()) {
                        val wide = maxWidth >= 768.dp
                        val drawerState = rememberDrawerState(DrawerValue.Closed)
                        var viewOptions by remember { mutableStateOf(false) }
                        var accountMenu by remember { mutableStateOf(false) }
                        var searchOpen by remember { mutableStateOf(false) }
                        val sync = when {
                            syncFailed -> SyncState.Offline
                            manualSync -> SyncState.Syncing
                            else -> SyncState.Synced
                        }
                        val accountName = profile?.name?.ifBlank { null } ?: profile?.email ?: "Account"
                        val accountDetail = profile?.email?.takeIf { it != accountName } ?: activeSession.origin.substringAfter("://")
                        fun closeDrawer() { scope.launch { drawerState.close() } }
                        // Back closes the drawer, then leaves search or selection, before leaving the app.
                        SystemBackHandler(enabled = drawerState.isOpen || selection != null || searchOpen || searchQuery.isNotEmpty()) {
                            when {
                                drawerState.isOpen -> closeDrawer()
                                selection != null -> selectedNoteIds = null
                                else -> {
                                    searchQuery = ""
                                    searchOpen = false
                                }
                            }
                        }
                        val drawer: @Composable () -> Unit = {
                            LibraryDrawer(
                                folder = folder,
                                tagFilter = filter,
                                folderCounts = remember(cachedNotes) { cachedNotes.groupingBy { it.folder }.eachCount() },
                                tags = tags.orEmpty(),
                                tagCounts = remember(assignments) { assignments.groupingBy { it.tagId }.eachCount() },
                                sync = sync,
                                accountName = accountName,
                                accountDetail = accountDetail,
                                accountColor = avatarColor(activeSession.userId),
                                onNewNote = {
                                    closeDrawer()
                                    composerOpen = true
                                },
                                onFolder = {
                                    closeDrawer()
                                    folder = it
                                    searchQuery = ""
                                    searchOpen = false
                                    tagFilterId = null
                                    openedNoteId = null
                                },
                                onTag = {
                                    closeDrawer()
                                    // A tag filters the current folder; trash has no tag filter.
                                    if (folder == NoteFolder.Trash) folder = NoteFolder.Notes
                                    searchQuery = ""
                                    searchOpen = false
                                    tagFilterId = it
                                    openedNoteId = null
                                },
                                onSync = {
                                    closeDrawer()
                                    syncNow(activeSession)
                                },
                                onAccount = {
                                    closeDrawer()
                                    accountMenu = true
                                },
                            )
                        }
                        val content: @Composable () -> Unit = {
                            Box(Modifier.fillMaxSize()) {
                                Column(Modifier.fillMaxSize()) {
                                    if (selection != null) {
                                        AnchorTopBar(
                                            "${selected.size} selected",
                                            Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                                            navigation = { AnchorIconButton(AnchorIcons.X, "Done", { selectedNoteIds = null }) },
                                        ) {
                                            val allSelected = selectableIds.isNotEmpty() && selected.size == selectableIds.size
                                            AnchorButton(
                                                if (allSelected) "Deselect all" else "Select all",
                                                { selectedNoteIds = if (allSelected) emptySet() else selectableIds },
                                                tone = ButtonTone.Ghost, small = true, enabled = !busy && selectableIds.isNotEmpty(),
                                            )
                                        }
                                    } else if (searchOpen || searchQuery.isNotEmpty()) {
                                        Row(
                                            Modifier.fillMaxWidth().height(56.dp).padding(horizontal = 8.dp),
                                            verticalAlignment = Alignment.CenterVertically,
                                            horizontalArrangement = Arrangement.spacedBy(4.dp),
                                        ) {
                                            AnchorIconButton(AnchorIcons.ArrowLeft, "Close search", {
                                                searchQuery = ""
                                                searchOpen = false
                                            })
                                            SearchField(searchQuery, { searchQuery = it }, Modifier.weight(1f))
                                        }
                                    } else {
                                        AnchorTopBar(
                                            tags?.firstOrNull { it.id == filter }?.name ?: folder.name,
                                            count = visible?.size,
                                            navigation = if (wide) null else {
                                                { AnchorIconButton(AnchorIcons.Menu, "Open menu", { scope.launch { drawerState.open() } }) }
                                            },
                                        ) {
                                            AnchorIconButton(AnchorIcons.Search, "Search notes", { searchOpen = true })
                                            AnchorIconButton(AnchorIcons.SlidersHorizontal, "View options", { viewOptions = true })
                                            AnchorIconButton(AnchorIcons.CircleCheck, "Select", {
                                                selectedNoteIds = emptySet()
                                                openedNoteId = null
                                            }, enabled = !busy && selectable.isNotEmpty())
                                        }
                                    }
                                    Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.TopCenter) {
                                        val listLayout = noteLayout == NoteLayout.List
                                        LazyVerticalStaggeredGrid(
                                            columns = if (listLayout) StaggeredGridCells.Fixed(1) else StaggeredGridCells.Adaptive(150.dp),
                                            modifier = Modifier.widthIn(max = if (listLayout) 720.dp else 1120.dp).fillMaxWidth(),
                                            state = grid,
                                            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 104.dp),
                                            verticalItemSpacing = density.space12,
                                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                                        ) {
                                            item(key = "status", span = StaggeredGridItemSpan.FullLine) {
                                                Column(verticalArrangement = Arrangement.spacedBy(density.space8)) {
                                                    if (legacyUpgradeRequired) AnchorBanner(
                                                        "Local data from Flutter is still on this device. To import it, prepare a Compose upgrade in the previous app for this account and server.",
                                                    )
                                                    if (syncFailed) AnchorBanner(
                                                        "You’re offline. Changes stay on this device until Anchor reconnects.",
                                                        icon = AnchorIcons.CloudOff, actionLabel = "Retry",
                                                        onAction = { syncNow(activeSession) },
                                                    )
                                                    if (folder == NoteFolder.Trash && selection == null && term.isEmpty() && selectable.isNotEmpty()) {
                                                        AnchorBanner(
                                                            "Notes stay in trash until you delete them.",
                                                            tone = BannerTone.Info, icon = AnchorIcons.Trash2, actionLabel = "Empty trash",
                                                            onAction = {
                                                                if (!busy) removingSelection = PendingSelectionRemoval(SelectionRemoval.EmptyTrash, selectable)
                                                            },
                                                        )
                                                    }
                                                    if (pending.isNotEmpty() && folder == NoteFolder.Notes && term.isEmpty() && filter == null) {
                                                        Row(verticalAlignment = Alignment.CenterVertically) {
                                                            SectionLabel("Pending notes", Modifier.weight(1f), pending.size)
                                                            AnchorButton(
                                                                "Send pending notes", {
                                                                    request({ "Could not finish sending pending notes. Try again." }) {
                                                                        sendPending(activeSession)
                                                                        message = if (pending.isEmpty()) "Pending notes sent."
                                                                            else "Some notes are still pending."
                                                                    }
                                                                },
                                                                tone = ButtonTone.Ghost, small = true, icon = AnchorIcons.RefreshCw,
                                                                enabled = !busy && pending.any { !it.rejected },
                                                            )
                                                        }
                                                        for (draft in pending) PendingNoteCard(draft, canReadDraft(draft)) { reviewingDraft = draft }
                                                    }
                                                }
                                            }
                                            if (visible == null) {
                                                item(key = "searching", span = StaggeredGridItemSpan.FullLine) {
                                                    Text("Searching…", color = MaterialTheme.colorScheme.onSurfaceVariant)
                                                }
                                            } else if (visible.isEmpty()) {
                                                if (!firstPullDone && term.isEmpty() && filter == null && cachedNotes.isEmpty()) {
                                                    items(3, key = { "skeleton/$it" }) { SkeletonCard() }
                                                } else item(key = "empty", span = StaggeredGridItemSpan.FullLine) {
                                                    when {
                                                        term.isNotEmpty() -> EmptyState(AnchorIcons.Search, "No matching notes", "Try another word or check the spelling.")
                                                        filter != null -> EmptyState(AnchorIcons.Hash, "No notes with this tag", "Add the tag to a note from its menu.")
                                                        folder == NoteFolder.Archive -> EmptyState(AnchorIcons.Archive, "Archive is empty", "Archived notes stay here, out of your list.")
                                                        folder == NoteFolder.Trash -> EmptyState(AnchorIcons.Trash2, "Trash is empty", "Notes you delete stay here until you empty the trash.")
                                                        else -> EmptyState(AnchorIcons.NotebookPen, "No notes yet", "Tap New note to write your first one.")
                                                    }
                                                }
                                            }
                                            for (section in sections) {
                                                val reorderKeys = reorderKeysOf(section)
                                                val otherGroup = if (reorderKeys.isEmpty()) emptyList() else otherGroupOf(section)
                                                section.title?.let { title ->
                                                    item(key = "section/$title", span = StaggeredGridItemSpan.FullLine) {
                                                        NoteSectionTitle(title, section.notes.size)
                                                    }
                                                }
                                                for ((noteIndex, note) in section.notes.withIndex()) {
                                                    val noteKey = "note/${note.id}"
                                                    item(key = noteKey, contentType = "card") {
                                                        val openNote = {
                                                            if (selection == null) openedNoteId = note.id
                                                            else selectedNoteIds = if (note.id in selection) selection - note.id else selection + note.id
                                                        }
                                                        val handle: (@Composable (Modifier) -> Unit)? =
                                                            if (noteKey in reorderKeys) {
                                                                { modifier ->
                                                                    NoteDragHandle(
                                                                        note.title.ifBlank { "Untitled note" },
                                                                        noteKey, orderDrag, reorderKeys, modifier,
                                                                        enabled = noteLibraryPreferencesReady && !busy && note.version > 0 &&
                                                                            pending.none { it.id == note.id },
                                                                        openActions = openNote,
                                                                    ) { target ->
                                                                        val index = section.notes.indexOfFirst { "note/${it.id}" == target }
                                                                        if (index >= 0 && index != noteIndex)
                                                                            reorderNote(activeSession, section.notes, note, index - noteIndex, otherGroup)
                                                                    }
                                                                }
                                                            } else null
                                                        val pictures = if (foreground && noteLibraryPreferencesReady && noteLibraryPreferences.showCardPictures) {
                                                            noteCardPictures(database.notes(), note, noteLayout) { previewCardPicture(activeSession, it) }
                                                        } else emptyList()
                                                        LibraryNoteCard(
                                                            note, noteLayout, orderDrag.cardModifier(noteKey),
                                                            dropTarget = orderDrag.target == noteKey, dragHandle = handle,
                                                            pictures = pictures,
                                                            picked = selection?.contains(note.id),
                                                            enabled = selection == null || !busy && note.id in selectableIds,
                                                            tags = tagNames[note.id].orEmpty(),
                                                            footnote = reminderLabel(note),
                                                            onClick = openNote,
                                                        )
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                                val fab = !wide && folder == NoteFolder.Notes && selection == null
                                if (fab) FloatingActionButton(
                                    onClick = { composerOpen = true },
                                    modifier = Modifier.align(Alignment.BottomEnd).padding(20.dp),
                                    shape = RoundedCornerShape(18.dp),
                                    containerColor = MaterialTheme.colorScheme.primary,
                                    contentColor = MaterialTheme.colorScheme.onPrimary,
                                ) { Icon(AnchorIcons.Plus, "New note", Modifier.size(24.dp)) }
                                if (selection != null) {
                                    val actions = buildList {
                                        if (folder == NoteFolder.Notes) {
                                            val pin = selected.isEmpty() || selected.any { !it.isPinned }
                                            add(DockAction(
                                                if (pin) "Pin" else "Unpin", if (pin) "Pin selected" else "Unpin selected",
                                                if (pin) AnchorIcons.Pin else AnchorIcons.PinOff,
                                            ) { updateSelectedNotes(activeSession, selected) { api.setNotePin(activeSession, it, pin) } })
                                            add(DockAction("Tag", "Tag selected", AnchorIcons.Tag) { taggingSelection = selected })
                                        }
                                        when (folder) {
                                            NoteFolder.Notes -> add(DockAction("Archive", "Archive selected", AnchorIcons.Archive) {
                                                updateSelectedNotes(activeSession, selected) { api.changeNoteFolder(activeSession, it, NoteFolder.Archive) }
                                            })
                                            NoteFolder.Archive -> add(DockAction("Unarchive", "Unarchive selected", AnchorIcons.ArchiveRestore) {
                                                updateSelectedNotes(activeSession, selected) { api.changeNoteFolder(activeSession, it, NoteFolder.Notes) }
                                            })
                                            NoteFolder.Trash -> add(DockAction("Restore", "Restore selected", AnchorIcons.RotateCcw) {
                                                updateSelectedNotes(activeSession, selected) { api.changeNoteFolder(activeSession, it, NoteFolder.Notes) }
                                            })
                                        }
                                        val removal = if (folder == NoteFolder.Trash) SelectionRemoval.Permanent else SelectionRemoval.Trash
                                        add(DockAction(
                                            "Delete",
                                            if (removal == SelectionRemoval.Trash) "Delete selected" else "Delete selected permanently",
                                            AnchorIcons.Trash2, danger = true,
                                        ) { removingSelection = PendingSelectionRemoval(removal, selected) })
                                    }
                                    SelectionDock(
                                        actions, enabled = !busy && selected.isNotEmpty(),
                                        modifier = Modifier.align(Alignment.BottomCenter).padding(16.dp),
                                    )
                                }
                                toast?.let {
                                    AnchorToast(
                                        it.text,
                                        Modifier.align(Alignment.BottomCenter)
                                            .padding(start = 16.dp, end = 16.dp, bottom = if (fab || selection != null) 92.dp else 16.dp),
                                        it.actionLabel, it.onAction,
                                    )
                                }
                            }
                        }
                        if (wide) PermanentNavigationDrawer(
                            drawerContent = {
                                PermanentDrawerSheet(
                                    Modifier.width(272.dp),
                                    drawerContainerColor = MaterialTheme.colorScheme.surfaceContainerLow,
                                ) { drawer() }
                            },
                            content = content,
                        ) else ModalNavigationDrawer(
                            drawerContent = {
                                ModalDrawerSheet(
                                    Modifier.width(300.dp),
                                    drawerContainerColor = MaterialTheme.colorScheme.surfaceContainerLow,
                                ) { drawer() }
                            },
                            drawerState = drawerState,
                            content = content,
                        )
                        if (viewOptions) ViewOptionsSheet(
                            noteLayout, sort, noteLibraryPreferencesReady,
                            onLayout = { noteLibraryPreferences = noteLibraryPreferences.copy(layout = it) },
                            onSort = { noteLibraryPreferences = noteLibraryPreferences.copy(sort = it) },
                            onClose = { viewOptions = false },
                        )
                        if (accountMenu) AccountSheet(
                            accountName, accountDetail, avatarColor(activeSession.userId), activeSession.origin,
                            appearance = appearance.takeIf { noteLibraryPreferencesReady },
                            sync = sync,
                            enabled = !busy,
                            onAppearance = { noteLibraryPreferences = noteLibraryPreferences.copy(theme = it) },
                            onSettings = {
                                accountMenu = false
                                accountSettingsOpen = true
                                message = ""
                            },
                            onTwoFactor = {
                                accountMenu = false
                                factorSettingsOpen = true
                                message = ""
                            },
                            onServerHeaders = {
                                accountMenu = false
                                headersServer = activeSession.origin
                            },
                            onSync = { syncNow(activeSession) },
                            onSignOut = {
                                accountMenu = false
                                request({ "Could not sign out. Try again." }) {
                                    val revoked = api.signOut(activeSession)
                                    detachSession()
                                    if (!revoked) message = "Signed out on this device."
                                }
                            },
                            onClose = { accountMenu = false },
                        )
                    }
                    else -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
                        Column(
                            Modifier.widthIn(max = 420.dp).fillMaxWidth().verticalScroll(rememberScrollState())
                                .padding(horizontal = 24.dp, vertical = 32.dp),
                            verticalArrangement = Arrangement.spacedBy(14.dp),
                        ) {
                            val activeChallenge = challenge
                            val activePasskey = browserPasskey
                            val activeEnrollment = enrollment
                            val enrollmentResult = enrolled
                            val enrollmentKeyValue = enrollmentKey
                            AuthHeader(
                                when {
                                    enrollmentResult != null -> "Save your recovery codes"
                                    activeEnrollment != null -> "Set up an authenticator"
                                    activeChallenge != null -> "Verify your sign-in"
                                    activePasskey?.setup == true -> "Set up a passkey"
                                    activePasskey != null -> "Sign in with a passkey"
                                    signup -> "Create an Anchor account"
                                    else -> "Sign in to Anchor"
                                },
                                when {
                                    enrollmentResult != null -> "Keep these codes somewhere safe. Each code can be used once."
                                    activeEnrollment != null && enrollmentKeyValue == null -> "Your server requires an authenticator to sign in."
                                    activeEnrollment != null -> "Enter this setup key in your authenticator app."
                                    activeChallenge != null && recovery -> "Enter one of your recovery codes."
                                    activeChallenge != null -> "Enter the code from your authenticator app."
                                    activePasskey?.setup == true -> "Your server requires a passkey. Open the sign-in page to finish setup."
                                    activePasskey != null -> "Use your passkey to sign in through your browser."
                                    signup -> null
                                    waitingForOidc -> "Finish signing in in your browser."
                                    else -> "Use the address of your Anchor server."
                                },
                            )
                            if (message.isNotEmpty()) {
                                AnchorBanner(message, Modifier.semantics { liveRegion = LiveRegionMode.Polite }, tone = BannerTone.Info)
                            }
                            val field = Modifier.fillMaxWidth()
                            if (enrollmentResult != null) {
                                SelectionContainer(
                                    Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp))
                                        .background(MaterialTheme.colorScheme.surface).padding(16.dp),
                                ) { Text(enrollmentResult.recoveryCodes.joinToString("\n"), fontFamily = LocalAnchorCodeFont.current) }
                                AnchorButton("I saved the codes", {
                                    request({ "Could not save your session. Try again." }) {
                                        api.acceptEnrollment(enrollmentResult)
                                        activate(enrollmentResult.session)
                                        resetChallenge()
                                    }
                                }, field, enabled = !busy)
                            } else if (activeEnrollment != null) {
                                if (enrollmentKeyValue == null) {
                                    AnchorButton("Set up", {
                                        request({ "Could not start setup. Try again or return to sign in." }) {
                                            enrollmentKey = api.setupEnrollment(activeEnrollment)
                                        }
                                    }, field, enabled = !busy)
                                } else {
                                    SelectionContainer(
                                        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp))
                                            .background(MaterialTheme.colorScheme.surface).padding(16.dp),
                                    ) { Text(enrollmentKeyValue, fontFamily = LocalAnchorCodeFont.current) }
                                    AnchorField(
                                        signInCode, { signInCode = it.filter { digit -> digit in '0'..'9' }.take(6) },
                                        "Authenticator code", field, icon = AnchorIcons.KeyRound, enabled = !busy, password = true,
                                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                                    )
                                    AnchorButton("Verify code", {
                                        request({ error ->
                                            val http = error as? AnchorHttpFailure
                                            when (http?.status) {
                                                400 -> "The code was not accepted. Try again."
                                                401 -> {
                                                    resetChallenge()
                                                    "The setup request expired. Sign in again."
                                                }
                                                429 -> "Too many attempts. Try again later."
                                                else -> "Could not verify the code. Try again."
                                            }
                                        }) {
                                            val code = signInCode
                                            signInCode = ""
                                            enrolled = api.confirmEnrollment(activeEnrollment, code)
                                            enrollmentKey = null
                                        }
                                    }, field, enabled = !busy && signInCode.length == 6)
                                }
                                AnchorButton("Back to sign in", {
                                    resetChallenge()
                                    message = ""
                                }, field, ButtonTone.Ghost, enabled = !busy)
                            } else if (activeChallenge != null) {
                                AnchorField(
                                    signInCode, { input ->
                                        signInCode = if (recovery) input.take(32) else input.filter { it in '0'..'9' }.take(6)
                                    },
                                    if (recovery) "Recovery code" else "Authenticator code", field,
                                    icon = AnchorIcons.KeyRound, enabled = !busy, password = true,
                                    keyboardOptions = KeyboardOptions(
                                        keyboardType = if (recovery) KeyboardType.Password else KeyboardType.NumberPassword,
                                    ),
                                )
                                val codeLength = signInCode.count { !it.isWhitespace() && it != '-' }
                                AnchorButton(if (busy) "Verifying…" else "Verify code", {
                                    request({ error ->
                                        val http = error as? AnchorHttpFailure
                                        when {
                                            http?.code == "INVALID_CHALLENGE" -> {
                                                resetChallenge()
                                                "The sign-in request expired. Enter your password again."
                                            }
                                            http?.status == 429 -> "Too many attempts. Try again later."
                                            http?.status == 401 -> "The code was not accepted. Try again."
                                            else -> "Could not verify the code. Try again."
                                        }
                                    }) {
                                        val code = signInCode
                                        signInCode = ""
                                        val signedIn = api.verifySignIn(activeChallenge, code, recovery)
                                        activate(signedIn)
                                        resetChallenge()
                                    }
                                }, field, enabled = !busy && codeLength == (if (recovery) 10 else 6))
                                AnchorButton(if (recovery) "Use an authenticator code" else "Use a recovery code", {
                                    recovery = !recovery
                                    signInCode = ""
                                    message = ""
                                }, field, ButtonTone.Ghost, enabled = !busy)
                                AnchorButton("Back to sign in", {
                                    resetChallenge()
                                    message = ""
                                }, field, ButtonTone.Ghost, enabled = !busy)
                            } else if (activePasskey != null) {
                                AnchorButton("Open sign-in in browser", {
                                    request({ "Could not open the browser. Try again." }) {
                                        openBrowser(activePasskey.origin + "/login")
                                    }
                                }, field, icon = AnchorIcons.FingerprintPattern, enabled = !busy)
                                AnchorButton("Back to sign in", {
                                    resetChallenge()
                                    message = ""
                                }, field, ButtonTone.Ghost, enabled = !busy)
                            } else if (signup) {
                                AnchorField(signupServer, {}, "Server address", field, icon = AnchorIcons.Server, readOnly = true)
                                AnchorField(signupName, { signupName = it }, "Name", field, icon = AnchorIcons.User, enabled = !busy)
                                AnchorField(
                                    email, { email = it }, "Email", field, icon = AnchorIcons.Mail, enabled = !busy,
                                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
                                )
                                AnchorField(
                                    password, { password = it }, "Password", field, icon = AnchorIcons.Lock, enabled = !busy,
                                    password = true, hint = "At least 8 characters.",
                                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                                )
                                AnchorButton(if (busy) "Creating account…" else "Create account", {
                                    request({ error ->
                                        when ((error as? AnchorHttpFailure)?.status) {
                                            403 -> "Registration is disabled on this server."
                                            409 -> "An account already uses that email address."
                                            429 -> "Too many attempts. Try again later."
                                            else -> "Could not create the account. Check your details and try again."
                                        }
                                    }) {
                                        val result = api.register(signupServer, signupName, email, password)
                                        signup = false
                                        signupName = ""
                                        acceptSignIn(result)
                                    }
                                }, field, enabled = !busy && signupName.isNotBlank() && email.isNotBlank() && password.length >= 8)
                                AnchorButton("Back to sign in", {
                                    signup = false
                                    signupName = ""
                                    password = ""
                                    message = ""
                                }, field, ButtonTone.Ghost, enabled = !busy)
                            } else if (waitingForOidc) {
                                AnchorButton("Cancel browser sign-in", {
                                    request({ "Could not cancel browser sign-in. Try again." }) {
                                        api.cancelOidc()
                                        waitingForOidc = false
                                    }
                                }, field, ButtonTone.Secondary, enabled = !busy)
                            } else {
                                AnchorField(
                                    server, { server = it }, "Server address", field, icon = AnchorIcons.Server, enabled = !busy,
                                    placeholder = "https://notes.example.com",
                                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                                    trailing = {
                                        AnchorIconButton(AnchorIcons.SlidersHorizontal, "Server headers", {
                                            try {
                                                api.headersFor(server)
                                                headersServer = server
                                            } catch (_: Exception) {
                                                message = "Enter a valid server address before adding headers."
                                            }
                                        }, enabled = !busy && server.isNotBlank())
                                    },
                                )
                                val provider = oidc
                                if (provider != null) {
                                    AnchorButton("Continue with ${provider.provider}", {
                                        request({ "Could not open the browser for sign-in. Try again." }) {
                                            val url = api.startOidc(server)
                                            try {
                                                openBrowser(url)
                                                password = ""
                                                waitingForOidc = true
                                            } catch (error: Exception) {
                                                api.cancelOidc()
                                                throw error
                                            }
                                        }
                                    }, field, ButtonTone.Secondary, icon = AnchorIcons.Globe, enabled = !busy)
                                }
                                if (provider?.passwordAllowed != false) {
                                    AnchorField(
                                        email, { email = it }, "Email", field, icon = AnchorIcons.Mail, enabled = !busy,
                                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
                                    )
                                    AnchorField(
                                        password, { password = it }, "Password", field, icon = AnchorIcons.Lock, enabled = !busy,
                                        password = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                                    )
                                    AnchorButton(if (busy) "Signing in…" else "Sign in", {
                                        request({ "Sign-in failed. Check the server address and your credentials." }) {
                                            acceptSignIn(api.signIn(server, email, password))
                                        }
                                    }, field, enabled = !busy && server.isNotBlank() && email.isNotBlank() && password.isNotEmpty())
                                    AnchorButton("Create account", {
                                        request({ "Could not check registration on this server. Try again." }) {
                                            when (api.registrationMode(server)) {
                                                "enabled", "review" -> {
                                                    signupServer = server
                                                    password = ""
                                                    signup = true
                                                }
                                                "disabled" -> message = "Registration is disabled on this server."
                                                else -> error("Unexpected registration mode")
                                            }
                                        }
                                    }, field, ButtonTone.Ghost, enabled = !busy && server.isNotBlank())
                                }
                            }
                        }
                    }
                }
                if (toast != null && (accountSettingsOpen || factorSettingsOpen)) AnchorToast(
                    toast.text, Modifier.align(Alignment.BottomCenter).padding(16.dp), toast.actionLabel, toast.onAction,
                )
            }
        }

        val openedNote = if (libraryShown) cachedNotes.firstOrNull { it.id == openedNoteId } else null
        if (activeSession != null && openedNote != null) key(activeSession, openedNote.id) {
            val note = openedNote
            // The editor stays on the version it opened with until it has no unsaved or unsent changes.
            var snapshot by remember { mutableStateOf(note) }
            var dirty by remember { mutableStateOf(false) }
            DisposableEffect(Unit) { onDispose { openedDirty = false } }
            var sheet by remember { mutableStateOf<NoteSheet?>(null) }
            var adding by remember { mutableStateOf(false) }
            val draft = pending.firstOrNull { it.id == note.id }
            LaunchedEffect(note.version, dirty, draft == null) {
                if (!dirty && draft == null && note.version != snapshot.version) snapshot = note
            }
            val editable = note.canEdit && note.folder != NoteFolder.Trash && draft == null
            val noteSection = sections.firstOrNull { section -> section.notes.any { it.id == note.id } }
            val reorderKeys = noteSection?.let(::reorderKeysOf).orEmpty()
            EditNote(
                snapshot, editable,
                status = when {
                    draft?.rejected == true -> SaveStatus.Failed
                    draft != null -> SaveStatus.OnDevice
                    note.canEdit -> SaveStatus.Saved
                    else -> null
                },
                sortChecklistItems = noteLibraryPreferences.sortChecklistItems,
                onClose = { openedNoteId = null },
                onSave = { change ->
                    sendLock.withLock {
                        check(session === activeSession)
                        check(cachedNotes.any { it.id == change.id && it.canEdit })
                        database.drafts().enqueue(change)
                        pending = pending + change
                    }
                },
                onMessage = { message = it },
                onDirtyChange = {
                    dirty = it
                    openedDirty = it
                },
                toast = toast,
                attach = if (editable) ({ adding = true }) else null,
                actions = { controls ->
                    if (note.folder != NoteFolder.Trash) AnchorIconButton(
                        AnchorIcons.Bell, if (note.remindAt != null) "Edit reminder" else "Set reminder",
                        { sheet = NoteSheet.Reminder }, selected = note.remindAt != null,
                    )
                    if (note.folder == NoteFolder.Notes) AnchorIconButton(
                        if (note.isPinned) AnchorIcons.PinOff else AnchorIcons.Pin, if (note.isPinned) "Unpin" else "Pin", {
                            updateLibraryNote(activeSession) { api.setNotePin(activeSession, note, !note.isPinned) }
                        }, enabled = !busy && note.version > 0,
                    )
                    if (note.isOwner && note.folder != NoteFolder.Trash) {
                        AnchorIconButton(AnchorIcons.Users, "Share note", { sheet = NoteSheet.Share })
                    }
                    AnchorIconButton(AnchorIcons.Ellipsis, "More actions", { sheet = NoteSheet.More })
                    if (sheet == NoteSheet.More) AnchorSheet(onDismiss = { sheet = null }) {
                        fun act(work: () -> Unit): () -> Unit = {
                            sheet = null
                            work()
                        }
                        val canMove = note.version > 0 && !busy && draft == null && !controls.dirty
                        if (editable) MenuRow("Background", act(controls.openBackground), icon = AnchorIcons.Palette)
                        if (note.folder != NoteFolder.Trash) {
                            MenuRow("Tags", act { sheet = NoteSheet.Tags }, icon = AnchorIcons.Tag)
                        }
                        if (note.canEdit || note.isOwner || localHistory.isNotEmpty()) {
                            MenuRow("Version history", act { historyNoteId = note.id }, icon = AnchorIcons.History)
                        }
                        if (note.version > 0 && note.folder != NoteFolder.Trash) {
                            MenuRow("Make a copy", act { copyNote(activeSession, note) }, icon = AnchorIcons.Copy, enabled = !busy && !controls.dirty)
                        }
                        val index = noteSection?.notes?.indexOfFirst { it.id == note.id } ?: -1
                        if (noteSection != null && reorderKeys.isNotEmpty()) for (step in listOf(-1, 1)) {
                            MenuRow(
                                if (step < 0) "Move up" else "Move down",
                                act { reorderNote(activeSession, noteSection.notes, note, step, otherGroupOf(noteSection)) },
                                icon = if (step < 0) AnchorIcons.ArrowUp else AnchorIcons.ArrowDown,
                                enabled = noteLibraryPreferencesReady && canMove && index + step in noteSection.notes.indices,
                            )
                        }
                        MenuDivider()
                        if (note.folder != NoteFolder.Trash) {
                            val archived = note.folder == NoteFolder.Archive
                            MenuRow(
                                if (archived) "Unarchive" else "Archive note",
                                act { moveNote(activeSession, note, if (archived) NoteFolder.Notes else NoteFolder.Archive) },
                                icon = if (archived) AnchorIcons.ArchiveRestore else AnchorIcons.Archive, enabled = canMove,
                            )
                        }
                        if (note.isOwner) {
                            if (note.folder == NoteFolder.Trash) {
                                MenuRow("Restore", act { moveNote(activeSession, note, NoteFolder.Notes) }, icon = AnchorIcons.RotateCcw, enabled = canMove)
                                MenuRow("Delete permanently", act { confirmDeletion = note }, icon = AnchorIcons.Trash2, danger = true, enabled = canMove)
                            } else {
                                MenuRow("Move to trash", act { moveNote(activeSession, note, NoteFolder.Trash) }, icon = AnchorIcons.Trash2, danger = true, enabled = canMove)
                            }
                        }
                    }
                },
                details = {
                    when {
                        note.folder == NoteFolder.Trash -> AnchorBanner(
                            "In trash. Restore the note to edit it.", tone = BannerTone.Info, icon = AnchorIcons.Trash2,
                            actionLabel = if (note.isOwner) "Restore" else null,
                            onAction = { if (!busy) moveNote(activeSession, note, NoteFolder.Notes) },
                        )
                        !note.canEdit -> AnchorBanner("View only. Shared with you.", tone = BannerTone.Info, icon = AnchorIcons.Eye)
                        note.folder == NoteFolder.Archive -> AnchorBanner(
                            "Archived. It’s hidden from your notes list.", tone = BannerTone.Info, icon = AnchorIcons.Archive,
                            actionLabel = "Unarchive", onAction = { if (!busy && !dirty) moveNote(activeSession, note, NoteFolder.Notes) },
                        )
                    }
                    if (draft?.rejected == true) AnchorBanner(
                        "The server couldn’t apply this change.", actionLabel = "Review", onAction = { reviewingDraft = draft },
                    )
                    val reminder = reminderLabel(note)
                    val names = tagNames[note.id].orEmpty()
                    if (reminder != null || names.isNotEmpty()) {
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            if (reminder != null) NoteChip(reminder, AnchorIcons.Bell)
                            for (name in names) NoteChip(name, AnchorIcons.Hash)
                        }
                    }
                },
                footer = {
                    NoteAttachments(
                        note = note,
                        session = activeSession,
                        cache = database.notes(),
                        outbox = outbox,
                        sendingId = sendingAttachmentId,
                        discardUpload = { id ->
                            attachmentSendLock.withLock {
                                if (sendingAttachmentId != id) {
                                    outbox.discard(activeSession.origin, activeSession.userId, id)
                                }
                            }
                        },
                        readAttachment = { file -> previewAttachment(activeSession, file) },
                        transferAttachment = if (busy) null else transfer@{ file, action ->
                            if (busy) return@transfer
                            busy = true
                            message = ""
                            transferAttachment(file, action) {
                                check(session === activeSession && !deletingAccount)
                                message = "Downloading attachment…"
                                val currentScope = database.notes().scope(file.origin, file.userId)
                                val bytes = downloadAttachment(activeSession, file, currentScope)
                                check(session === activeSession && !deletingAccount)
                                bytes
                            }
                        },
                        api = api,
                        foreground = foreground,
                        pull = { pullNotes(activeSession) },
                        adding = adding,
                        onAddingClose = { adding = false },
                    )
                },
            )
            when (sheet) {
                NoteSheet.Reminder -> NoteReminder(
                    note = note, busy = busy, message = message, onClose = { sheet = null },
                    onUpdate = { current, at, repeat, done ->
                        updateLibraryNote(activeSession, "The reminder changed. Sync and reopen it before trying again.") {
                            api.updateReminder(activeSession, current, at, repeat)
                            if (at != null) requestReminderPermission?.invoke()
                            done()
                        }
                    },
                )
                NoteSheet.Share -> ShareNoteSheet(api, activeSession, note, onClose = { sheet = null })
                NoteSheet.Tags -> NoteTags(
                    notes = database.notes(), note = note, busy = busy, message = message, onClose = { sheet = null },
                    onCreate = { name, clear ->
                        updateLibraryNote(activeSession, "A tag with that name already exists.") {
                            api.createTag(activeSession, name)
                            clear()
                        }
                    },
                    onAssign = { tag, assigned ->
                        updateLibraryNote(activeSession) { api.assignTag(activeSession, note, tag, assigned) }
                    },
                    onRename = { tag, name, done ->
                        updateLibraryNote(activeSession, "The tag changed. Close and reopen Tags before trying again.") {
                            api.renameTag(activeSession, tag, name)
                            done()
                        }
                    },
                    onDelete = { tag, done ->
                        updateLibraryNote(activeSession, "The tag changed. Close and reopen Tags before trying again.") {
                            api.deleteTag(activeSession, tag)
                            done()
                        }
                    },
                )
                NoteSheet.More, null -> {}
            }
        }

        // Composed after the note screen so its dialog stays on top when both are recreated.
        val historyNote = cachedNotes.firstOrNull {
            it.id == historyNoteId && (it.canEdit || it.isOwner || it.id == openedNoteId && localHistory.isNotEmpty())
        }
        if (activeSession != null && historyNote != null) {
            key(activeSession, historyNote.id) {
                NoteHistory(
                    api, activeSession, historyNote, localHistory,
                    onClose = { historyNoteId = null },
                    pull = { pullNotes(activeSession) },
                )
            }
        }
        if (activeSession != null && libraryShown && composerOpen) key(activeSession, newNoteEditorGeneration) {
            var recording by remember { mutableStateOf(false) }
            NewNote(
                title, newNoteBody, newNoteBackground, busy,
                startInBody = noteLibraryPreferences.startNewNotesInBody.takeIf { noteLibraryPreferencesReady },
                sortChecklistItems = noteLibraryPreferences.sortChecklistItems,
                onClose = { composerOpen = false },
                onSave = {
                    request({ "The note could not be saved on this device." }) {
                        val draft = queueNewNote(activeSession)
                        composerOpen = false
                        val stored = try {
                            sendDraft(activeSession, draft)
                        } catch (error: CancellationException) {
                            throw error
                        } catch (_: Exception) {
                            message = "Saved on this device. Waiting to send."
                            return@request
                        }
                        if (stored != null) message = if (stored.isBlank()) "Note saved." else "Saved: $stored"
                    }
                },
                onMessage = { message = it },
                attach = { recording = true },
                toast = toast,
            )
            if (recording) RecordAudio(
                foreground, onClose = { recording = false }, failed = { message = it },
                confirmationLabel = "Save note with recording",
            ) { picked ->
                queueNewNote(activeSession, picked)
                composerOpen = false
                message = "Saved on this device. Waiting to send."
            }
        }
    }
}


private enum class NoteSheet { More, Reminder, Share, Tags }

/** Messages after which the copy can still be undone. */
private val copyMessages = setOf(
    "Note copied.",
    "Note copied. Sync notes to open it on this device.",
    "Could not undo the copy. Try again when connected.",
    "The copy has local changes. Keep it or discard those changes before undoing.",
)

internal fun isTemporarySyncFailure(error: Exception): Boolean = when (error) {
    is AnchorHttpFailure -> error.status == 408 || error.status == 429 || error.status in 500..599
    is HttpRequestTimeoutException, is IOException -> true
    else -> false
}
