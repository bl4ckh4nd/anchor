package anchor

import kotlin.time.Duration.Companion.days
import kotlin.time.Instant

internal data class IosReminderDate(val wallClock: String, val repeat: ReminderRepeat? = null)
internal data class IosReminderRequest(val note: CachedNote, val date: IosReminderDate)

internal fun planIosReminders(notes: List<CachedNote>, now: Instant): List<IosReminderRequest> =
    notes.asSequence().filter { it.folder == NoteFolder.Notes && it.remindAt != null }
        .flatMap { note ->
            val repeat = ReminderRepeat.entries.firstOrNull { it.wire == note.reminderRecurrence } ?: ReminderRepeat.None
            iosReminderDates(checkNotNull(note.remindAt), repeat, now).map { IosReminderRequest(note, it) }
        }
        .sortedBy { it.date.wallClock }
        .take(60)
        .toList()

// Treat the local Gregorian calendar as UTC only for wall-clock arithmetic.
internal fun iosReminderDates(at: String, repeat: ReminderRepeat, now: Instant): List<IosReminderDate> {
    val anchor = reminderWallClock(at.substringBefore('T'), at.substringAfter('T', "")) ?: return emptyList()
    val start = Instant.parse("$anchor:00Z")
    if (repeat == ReminderRepeat.None) {
        return if (start > now) listOf(IosReminderDate(anchor)) else emptyList()
    }

    fun monthIndex(wall: String) = wall.take(4).toInt() * 12 + wall.substring(5, 7).toInt() - 1
    val month = monthIndex(anchor)
    val day = anchor.substring(8, 10).toInt()
    val time = anchor.substringAfter('T')
    val dayStep = if (repeat == ReminderRepeat.Weekly) 7 else 1
    val monthStep = if (repeat == ReminderRepeat.Yearly) 12 else 1
    val monthly = repeat == ReminderRepeat.Monthly || repeat == ReminderRepeat.Yearly

    fun shifted(count: Int): Instant {
        if (!monthly) return start + (count * dayStep).days
        val index = month + count * monthStep
        val y = index / 12
        val m = index % 12 + 1
        val last = when (m) {
            2 -> if (y % 4 == 0 && (y % 100 != 0 || y % 400 == 0)) 29 else 28
            4, 6, 9, 11 -> 30
            else -> 31
        }
        val date = "${y.toString().padStart(4, '0')}-${m.toString().padStart(2, '0')}-${minOf(day, last).toString().padStart(2, '0')}"
        return Instant.parse("${if (y >= 10_000) "+" else ""}${date}T$time:00Z")
    }

    val elapsed = if (monthly) (monthIndex(now.toString()) - month) / monthStep
        else (now - start).inWholeDays.toInt() / dayStep
    var index = elapsed.coerceAtLeast(0)
    if (shifted(index) <= now) index++
    val nativeRepeat = when (repeat) {
        ReminderRepeat.Monthly -> day <= 28
        ReminderRepeat.Yearly -> anchor.substring(5, 10) != "02-29"
        else -> true
    }
    val useRepeat = nativeRepeat && shifted(index - 1) <= now
    return (0 until if (useRepeat) 1 else 12).mapNotNull { offset ->
        val wall = shifted(index + offset).toString().substringBeforeLast(':')
        reminderWallClock(wall.substringBefore('T'), wall.substringAfter('T', ""))?.let {
            IosReminderDate(it, repeat.takeIf { useRepeat })
        }
    }
}
