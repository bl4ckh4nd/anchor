@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)

package anchor

import kotlin.coroutines.resume
import kotlin.time.Instant
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import platform.Foundation.NSCalendar
import platform.Foundation.NSCalendarIdentifierGregorian
import platform.Foundation.NSDate
import platform.Foundation.NSDateComponents
import platform.Foundation.NSDateFormatter
import platform.Foundation.NSLocale
import platform.Foundation.NSTimeZone
import platform.Foundation.localTimeZone
import platform.UserNotifications.UNAuthorizationOptionAlert
import platform.UserNotifications.UNAuthorizationOptionSound
import platform.UserNotifications.UNAuthorizationStatusAuthorized
import platform.UserNotifications.UNAuthorizationStatusProvisional
import platform.UserNotifications.UNCalendarNotificationTrigger
import platform.UserNotifications.UNMutableNotificationContent
import platform.UserNotifications.UNNotification
import platform.UserNotifications.UNNotificationRequest
import platform.UserNotifications.UNNotificationSound
import platform.UserNotifications.UNUserNotificationCenter

internal object IosReminders {
    private const val prefix = "anchor-reminder:"
    private val lock = Mutex()
    val authorizationChanges = MutableStateFlow(0)

    fun requestPermission() {
        UNUserNotificationCenter.currentNotificationCenter().requestAuthorizationWithOptions(
            UNAuthorizationOptionAlert or UNAuthorizationOptionSound,
        ) { granted, _ ->
            if (granted) authorizationChanges.update { it + 1 }
        }
    }

    suspend fun publish(session: AnchorSession?, notes: List<CachedNote>) = lock.withLock {
        withContext(NonCancellable) {
            val center = UNUserNotificationCenter.currentNotificationCenter()
            val pending = center.pendingReminders()
            val delivered = center.deliveredReminders()
            val scoped = if (session == null) emptyList() else notes.filter {
                it.origin == session.origin && it.userId == session.userId &&
                    it.folder == NoteFolder.Notes && it.remindAt != null
            }
            val active = scoped.associateBy { it.id }
            center.removeDeliveredNotificationsWithIdentifiers(delivered.filterNot { it.matches(active) }.map { it.identifier })
            if (scoped.isEmpty() || !center.remindersAllowed()) {
                center.removePendingNotificationRequestsWithIdentifiers(pending.map { it.identifier })
                return@withContext
            }

            val zone = NSTimeZone.localTimeZone
            val calendar = checkNotNull(NSCalendar.calendarWithIdentifier(NSCalendarIdentifierGregorian))
            calendar.timeZone = zone
            val formatter = NSDateFormatter().apply {
                locale = NSLocale(localeIdentifier = "en_US_POSIX")
                this.calendar = calendar
                timeZone = zone
                dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
            }
            val now = Instant.parse(formatter.stringFromDate(NSDate()) + "Z")
            val plans = planIosReminders(scoped, now)
            val desired = plans.associateBy { it.identifier() }
            val obsolete = pending.filter { request ->
                val plan = desired[request.identifier]
                plan == null || !request.matches(active) || request.content.userInfo["zone"] != zone.name
            }
            center.removePendingNotificationRequestsWithIdentifiers(obsolete.map { it.identifier })
            val current = (pending - obsolete.toSet()).mapTo(mutableSetOf()) { it.identifier }
            for ((id, plan) in desired) {
                if (id !in current) plan.request(id, calendar, zone.name)?.let { center.addReminder(it) }
            }
        }
    }

    private fun stamp(note: CachedNote) =
        listOf(note.remindAt, note.reminderRecurrence, note.reminderVersion, note.title).joinToString("\n")

    private fun UNNotificationRequest.matches(notes: Map<String, CachedNote>): Boolean {
        val info = content.userInfo
        val note = notes[info["noteId"] as? String] ?: return false
        return info["origin"] == note.origin && info["userId"] == note.userId && info["stamp"] == stamp(note)
    }

    private fun IosReminderRequest.identifier() =
        "$prefix${note.id}/${date.repeat?.wire ?: date.wallClock}"

    private fun IosReminderRequest.request(id: String, calendar: NSCalendar, zone: String): UNNotificationRequest? {
        val at = date.wallClock
        val repeat = date.repeat
        val parts = NSDateComponents().apply {
            this.calendar = calendar
            hour = at.substring(11, 13).toLong()
            minute = at.substring(14, 16).toLong()
            when (repeat) {
                ReminderRepeat.Daily -> Unit
                ReminderRepeat.Weekly -> {
                    val dayNumber = Instant.parse("${at.substringBefore('T')}T00:00:00Z")
                        .toEpochMilliseconds() / 86_400_000
                    weekday = ((dayNumber + 4) % 7 + 7) % 7 + 1
                }
                ReminderRepeat.Monthly -> day = at.substring(8, 10).toLong()
                ReminderRepeat.Yearly -> {
                    month = at.substring(5, 7).toLong()
                    day = at.substring(8, 10).toLong()
                }
                else -> {
                    year = at.substring(0, 4).toLong()
                    month = at.substring(5, 7).toLong()
                    day = at.substring(8, 10).toLong()
                }
            }
        }
        val content = UNMutableNotificationContent().apply {
            setTitle("Note reminder")
            setBody(note.title.ifBlank { "Untitled" })
            setSound(UNNotificationSound.defaultSound)
            setUserInfo(mapOf(
                "origin" to note.origin, "userId" to note.userId, "noteId" to note.id,
                "zone" to zone, "stamp" to stamp(note),
            ))
        }
        val trigger = UNCalendarNotificationTrigger.triggerWithDateMatchingComponents(parts, repeats = repeat != null)
        if (trigger.nextTriggerDate() == null) return null
        return UNNotificationRequest.requestWithIdentifier(id, content, trigger)
    }

    private suspend fun UNUserNotificationCenter.pendingReminders(): List<UNNotificationRequest> =
        suspendCancellableCoroutine { continuation ->
            getPendingNotificationRequestsWithCompletionHandler { requests ->
                continuation.resume(requests.orEmpty().filterIsInstance<UNNotificationRequest>()
                    .filter { it.identifier.startsWith(prefix) })
            }
        }

    private suspend fun UNUserNotificationCenter.deliveredReminders(): List<UNNotificationRequest> =
        suspendCancellableCoroutine { continuation ->
            getDeliveredNotificationsWithCompletionHandler { notifications ->
                continuation.resume(notifications.orEmpty().filterIsInstance<UNNotification>()
                    .map { it.request }.filter { it.identifier.startsWith(prefix) })
            }
        }

    private suspend fun UNUserNotificationCenter.remindersAllowed(): Boolean =
        suspendCancellableCoroutine { continuation ->
            getNotificationSettingsWithCompletionHandler {
                val status = it?.authorizationStatus
                continuation.resume(status == UNAuthorizationStatusAuthorized || status == UNAuthorizationStatusProvisional)
            }
        }

    private suspend fun UNUserNotificationCenter.addReminder(request: UNNotificationRequest) {
        val failure = suspendCancellableCoroutine { continuation ->
            addNotificationRequest(request) { error -> continuation.resume(error?.localizedDescription) }
        }
        check(failure == null) { "Could not register reminder: $failure" }
    }
}
