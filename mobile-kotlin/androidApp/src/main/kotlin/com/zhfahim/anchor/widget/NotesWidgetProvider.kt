package com.zhfahim.anchor.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.content.res.Configuration
import android.view.View
import android.widget.RemoteViews
import android.widget.RemoteViewsService
import anchor.AnchorActivity
import anchor.AndroidWidgetNotes
import anchor.R
import anchor.newWidgetNote
import anchor.openWidgetNote

class NotesWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        val account = AndroidWidgetNotes.read(context)
        for (id in ids) {
            val views = RemoteViews(context.packageName, R.layout.widget_notes)
            val adapter = Intent(context, NotesWidgetService::class.java)
                .setData(Uri.parse("anchorwidget://list/$id"))
            views.setRemoteAdapter(R.id.widget_list, adapter)
            views.setEmptyView(R.id.widget_list, R.id.widget_empty)
            views.setTextViewText(R.id.widget_empty,
                context.getString(if (account == null) R.string.widget_logged_out else R.string.widget_empty))
            views.setViewVisibility(R.id.widget_new_note, if (account == null) View.GONE else View.VISIBLE)

            val app = PendingIntent.getActivity(context, 0, launch(context), PendingIntent.FLAG_IMMUTABLE)
            views.setOnClickPendingIntent(R.id.widget_header, app)
            views.setOnClickPendingIntent(R.id.widget_empty, app)
            if (account != null) {
                val create = launch(context).setAction(newWidgetNote)
                    .putExtra("origin", account.origin)
                    .putExtra("userId", account.userId)
                views.setOnClickPendingIntent(R.id.widget_new_note, PendingIntent.getActivity(
                    context, 0, create, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                ))
            }
            views.setPendingIntentTemplate(R.id.widget_list, PendingIntent.getActivity(
                context, 0, launch(context).setAction(openWidgetNote), PendingIntent.FLAG_MUTABLE,
            ))
            manager.updateAppWidget(id, views)
        }
        manager.notifyAppWidgetViewDataChanged(ids, R.id.widget_list)
    }

    private fun launch(context: Context) = Intent(context, AnchorActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
}

class NotesWidgetService : RemoteViewsService() {
    override fun onGetViewFactory(intent: Intent): RemoteViewsFactory = NotesRows(applicationContext)
}

private class NotesRows(private val context: Context) : RemoteViewsService.RemoteViewsFactory {
    private var account: AndroidWidgetNotes? = null

    override fun onDataSetChanged() {
        account = AndroidWidgetNotes.read(context)
    }

    override fun getViewAt(position: Int): RemoteViews? {
        val current = account ?: return null
        val note = current.notes.getOrNull(position) ?: return null
        val dark = context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK ==
            Configuration.UI_MODE_NIGHT_YES
        val colors = note.colors(dark)
        return RemoteViews(context.packageName, R.layout.widget_note_item).apply {
            setInt(R.id.item_fill, "setColorFilter", colors?.first ?: context.getColor(R.color.widget_item_bg))
            setInt(R.id.item_edge, "setColorFilter", colors?.second ?: context.getColor(R.color.widget_item_edge))
            setTextViewText(R.id.item_title, note.title)
            setTextViewText(R.id.item_snippet, note.snippet)
            setViewVisibility(R.id.item_snippet, if (note.snippet.isBlank()) View.GONE else View.VISIBLE)
            setViewVisibility(R.id.item_pin, if (note.pinned) View.VISIBLE else View.GONE)
            setOnClickFillInIntent(R.id.item_root, Intent()
                .putExtra("origin", current.origin)
                .putExtra("userId", current.userId)
                .putExtra("noteId", note.id))
        }
    }

    override fun getCount(): Int = account?.notes?.size ?: 0
    override fun getLoadingView(): RemoteViews? = null
    override fun getViewTypeCount(): Int = 1
    override fun getItemId(position: Int): Long = position.toLong()
    override fun hasStableIds(): Boolean = false
    override fun onCreate() = Unit
    override fun onDestroy() = Unit
}
