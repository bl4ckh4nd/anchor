package anchor

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import androidx.compose.ui.text.SpanStyle
import org.json.JSONArray
import org.json.JSONObject

const val openWidgetNote = "anchor.widget.OPEN_NOTE"
const val newWidgetNote = "anchor.widget.NEW_NOTE"
private const val providerName = "com.zhfahim.anchor.widget.NotesWidgetProvider"

data class AndroidWidgetNote(
    val id: String,
    val title: String,
    val snippet: String,
    val pinned: Boolean,
    val background: String?,
) {
    fun colors(dark: Boolean): Pair<Int, Int>? {
        val palette = notePalette(background) ?: return null
        return if (dark) palette.darkFill.toInt() to palette.darkEdge.toInt()
        else palette.lightFill.toInt() to palette.lightEdge.toInt()
    }
}

data class AndroidWidgetNotes(val origin: String, val userId: String, val notes: List<AndroidWidgetNote>) {
    companion object {
        fun read(context: Context): AndroidWidgetNotes? = runCatching {
            val raw = preferences(context).getString("notes", null) ?: return null
            val data = JSONObject(raw)
            val rows = data.getJSONArray("notes")
            AndroidWidgetNotes(data.getString("origin"), data.getString("userId"), List(rows.length()) { index ->
                val row = rows.getJSONObject(index)
                AndroidWidgetNote(
                    row.getString("id"), row.getString("title"), row.getString("snippet"), row.getBoolean("pinned"),
                    row.optString("background").takeUnless { row.isNull("background") },
                )
            })
        }.getOrNull()

        internal fun publish(context: Context, session: AnchorSession, notes: List<CachedNote>) {
            val headingStyles = List(3) { SpanStyle() }
            val rows = notes.asSequence()
                .filter { it.origin == session.origin && it.userId == session.userId && it.folder == NoteFolder.Notes }
                .take(20)
                .map { note ->
                    JSONObject()
                        .put("id", note.id)
                        .put("title", note.title.ifBlank { "Untitled note" }.widgetText())
                        .put("snippet", notePreviewText(note.content, headingStyles).text.trim().widgetText())
                        .put("pinned", note.isPinned)
                        .put("background", note.background)
                }.toList()
            save(context, JSONObject()
                .put("origin", session.origin)
                .put("userId", session.userId)
                .put("notes", JSONArray(rows)).toString())
        }

        internal fun clear(context: Context) = save(context, null)

        private fun String.widgetText(): String {
            val end = minOf(length, 160)
            return take(if (end < length && this[end - 1].isHighSurrogate()) end - 1 else end)
        }

        private fun preferences(context: Context) = context.getSharedPreferences("anchor-widget", Context.MODE_PRIVATE)

        private fun save(context: Context, data: String?) {
            val prefs = preferences(context)
            if (prefs.getString("notes", null) == data) return
            check(prefs.edit().putString("notes", data).commit())
            val provider = ComponentName(context, providerName)
            val ids = AppWidgetManager.getInstance(context).getAppWidgetIds(provider)
            if (ids.isNotEmpty()) {
                context.sendBroadcast(Intent(AppWidgetManager.ACTION_APPWIDGET_UPDATE)
                    .setComponent(provider)
                    .putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids))
            }
        }
    }
}
