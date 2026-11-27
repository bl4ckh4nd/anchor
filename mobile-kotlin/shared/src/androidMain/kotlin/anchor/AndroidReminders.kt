package anchor

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.util.Log
import java.util.TimeZone
import kotlinx.coroutines.flow.MutableStateFlow
import org.json.JSONArray
import org.json.JSONObject

private const val reminderAlarm = "anchor.reminder.ALARM"
private const val openReminder = "anchor.reminder.OPEN"
private const val reminderChannel = "anchor_reminders"
private const val reminderTag = "anchor-reminder:"

class AndroidNoteLaunchCallbacks {
    internal val pending = MutableStateFlow<NoteLaunch?>(null)

    fun accept(intent: Intent) {
        val action = intent.action
        if (action != openReminder && action != openWidgetNote && action != newWidgetNote) return
        val origin = intent.getStringExtra("origin") ?: return
        val userId = intent.getStringExtra("userId") ?: return
        val noteId = intent.getStringExtra("noteId")
        if (action != newWidgetNote && noteId.isNullOrBlank()) return
        pending.value = NoteLaunch(origin, userId, noteId)
    }
}

class AndroidReminderReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        try {
            AndroidReminders.receive(context, intent.action)
        } catch (error: Exception) {
            Log.w("AnchorReminders", "Could not process reminder alarm", error)
        }
    }
}

internal object AndroidReminders {
    private data class Entry(
        val id: String,
        val title: String,
        val wallClock: String,
        val repeat: ReminderRepeat,
        val version: Long?,
        val dueAt: Long?,
    ) {
        fun dueInZone(previousZone: String, zone: TimeZone, now: Long): Long? {
            val scheduled = dueAt ?: return null
            if (previousZone == zone.id) return scheduled
            val from = if (repeat == ReminderRepeat.None) now
                else maxOf(now, androidReminderDayStart(scheduled, TimeZone.getTimeZone(previousZone), zone))
            return nextAndroidReminder(wallClock, repeat, from, zone)
        }

        fun json() = JSONObject()
            .put("id", id).put("title", title).put("wallClock", wallClock).put("repeat", repeat.wire)
            .put("version", version ?: JSONObject.NULL).put("dueAt", dueAt ?: JSONObject.NULL)
    }

    private data class Agenda(val origin: String, val userId: String, val zone: String, val entries: List<Entry>)

    @Synchronized
    fun publish(context: Context, session: AnchorSession?, notes: List<CachedNote>) {
        val previous = read(context)
        val sameAccount = previous?.origin == session?.origin && previous?.userId == session?.userId
        if (!sameAccount || session == null) cancelNotifications(context)
        if (session == null) {
            save(context, null)
            schedule(context, emptyList())
            return
        }
        val existing = previous?.takeIf { sameAccount }?.entries.orEmpty().associateBy { it.id }
        val zone = TimeZone.getDefault()
        val now = System.currentTimeMillis()
        val entries = notes.mapNotNull { note ->
            val at = note.remindAt ?: return@mapNotNull null
            if (note.folder != NoteFolder.Notes || note.origin != session.origin || note.userId != session.userId)
                return@mapNotNull null
            val repeat = ReminderRepeat.entries.firstOrNull { it.wire == note.reminderRecurrence } ?: ReminderRepeat.None
            val prior = existing[note.id]
            val unchanged = prior != null && prior.wallClock == at && prior.repeat == repeat && prior.version == note.reminderVersion
            if (!unchanged) cancelNotification(context, note.id)
            val due = if (unchanged && previous != null) prior.dueInZone(previous.zone, zone, now)
                else nextAndroidReminder(at, repeat, now, zone)
            Entry(note.id, note.title, at, repeat, note.reminderVersion, due)
        }
        val retained = entries.mapTo(mutableSetOf()) { it.id }
        for (id in existing.keys - retained) cancelNotification(context, id)
        save(context, Agenda(session.origin, session.userId, zone.id, entries))
        schedule(context, entries)
    }

    @Synchronized
    fun receive(context: Context, action: String?) {
        val previous = read(context) ?: return
        if (!androidSessionFile(context).exists()) {
            publish(context, null, emptyList())
            return
        }
        val zone = TimeZone.getDefault()
        val now = System.currentTimeMillis()
        val due = if (previous.zone == zone.id) previous.entries else previous.entries.map { entry ->
            entry.copy(dueAt = entry.dueInZone(previous.zone, zone, now))
        }
        val deliveries = if (action == reminderAlarm) due.filter { it.dueAt != null && it.dueAt <= now } else emptyList()
        val ids = deliveries.mapTo(mutableSetOf()) { it.id }
        val remaining = due.map { entry ->
            if (entry.id !in ids) entry
            else entry.copy(dueAt = nextAndroidReminder(entry.wallClock, entry.repeat, now + 1, zone))
        }
        save(context, previous.copy(zone = zone.id, entries = remaining))
        schedule(context, remaining)
        deliveries.forEach { deliver(context, previous, it) }
    }

    private fun prefs(context: Context) = context.getSharedPreferences("anchor-reminders", Context.MODE_PRIVATE)

    private fun read(context: Context): Agenda? {
        val value = prefs(context).getString("agenda", null) ?: return null
        val json = JSONObject(value)
        val entries = json.getJSONArray("entries")
        return Agenda(json.getString("origin"), json.getString("userId"), json.getString("zone"), List(entries.length()) {
            val entry = entries.getJSONObject(it)
            Entry(
                entry.getString("id"), entry.getString("title"), entry.getString("wallClock"),
                ReminderRepeat.entries.single { item -> item.wire == entry.getString("repeat") },
                if (entry.isNull("version")) null else entry.getLong("version"),
                if (entry.isNull("dueAt")) null else entry.getLong("dueAt"),
            )
        })
    }

    private fun save(context: Context, agenda: Agenda?) {
        val value = agenda?.let {
            JSONObject().put("origin", it.origin).put("userId", it.userId).put("zone", it.zone)
                .put("entries", JSONArray(it.entries.map(Entry::json))).toString()
        }
        check(prefs(context).edit().putString("agenda", value).commit())
    }

    private fun schedule(context: Context, entries: List<Entry>) {
        val alarms = context.getSystemService(AlarmManager::class.java)
        val operation = PendingIntent.getBroadcast(
            context, 0, Intent(context, AndroidReminderReceiver::class.java).setAction(reminderAlarm), PendingIntent.FLAG_IMMUTABLE,
        )
        alarms.cancel(operation)
        val next = entries.mapNotNull { it.dueAt }.minOrNull() ?: return
        if (Build.VERSION.SDK_INT < 31 || alarms.canScheduleExactAlarms()) {
            try {
                alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, next, operation)
                return
            } catch (_: SecurityException) {
                // The special access can be revoked after canScheduleExactAlarms().
            }
        }
        alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, next, operation)
    }

    private fun cancelNotification(context: Context, id: String) =
        context.getSystemService(NotificationManager::class.java).cancel(reminderTag + id, 0)

    private fun cancelNotifications(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.activeNotifications.filter { it.tag?.startsWith(reminderTag) == true }
            .forEach { manager.cancel(it.tag, it.id) }
    }

    @Suppress("DEPRECATION")
    private fun deliver(context: Context, agenda: Agenda, entry: Entry) {
        val manager = context.getSystemService(NotificationManager::class.java)
        if (!manager.areNotificationsEnabled()) return
        val builder = if (Build.VERSION.SDK_INT >= 26) {
            manager.createNotificationChannel(NotificationChannel(reminderChannel, "Note reminders", NotificationManager.IMPORTANCE_DEFAULT))
            Notification.Builder(context, reminderChannel)
        } else Notification.Builder(context).setDefaults(Notification.DEFAULT_SOUND)
        val target = Intent(openReminder).setClassName(context, "anchor.AnchorActivity")
            .setData(Uri.fromParts("anchor-reminder", entry.id, null))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra("origin", agenda.origin).putExtra("userId", agenda.userId).putExtra("noteId", entry.id)
        val open = PendingIntent.getActivity(context, 0, target, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        manager.notify(reminderTag + entry.id, 0, builder
            .setSmallIcon(android.R.drawable.ic_popup_reminder)
            .setContentTitle("Note reminder")
            .setContentText(entry.title.ifBlank { "Untitled" })
            .setContentIntent(open)
            .setAutoCancel(true)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .build())
    }
}
