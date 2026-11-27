package anchor

import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive

internal suspend fun searchNotes(
    notes: List<CachedNote>,
    folder: NoteFolder,
    query: String,
    tagNames: Map<String, List<String>>,
): List<CachedNote> {
    val term = query.trim()
    val context = currentCoroutineContext()
    return notes.filter { note ->
        context.ensureActive()
        val inSearchScope = note.folder == folder ||
            (term.isNotEmpty() && folder == NoteFolder.Notes && note.folder == NoteFolder.Archive)
        inSearchScope && (term.isEmpty() ||
            note.title.contains(term, ignoreCase = true) ||
            tagNames[note.id].orEmpty().any { it.contains(term, ignoreCase = true) } ||
            (EditableDelta.read(note.content, preview = true)?.text ?: note.content.orEmpty())
                .contains(term, ignoreCase = true))
    }
}
