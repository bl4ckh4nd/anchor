package anchor

import java.util.Calendar
import java.util.Date
import java.util.GregorianCalendar
import java.util.TimeZone

private val utc = TimeZone.getTimeZone("UTC")

private fun calendar(zone: TimeZone) =
    GregorianCalendar(zone).apply { gregorianChange = Date(Long.MIN_VALUE) }

// A recurring reminder's pending local day moves to the new zone with the device.
internal fun androidReminderDayStart(dueAt: Long, previousZone: TimeZone, zone: TimeZone): Long {
    val previousDay = calendar(previousZone).apply { timeInMillis = dueAt }
    return calendar(zone).apply {
        clear()
        set(previousDay.get(Calendar.YEAR), previousDay.get(Calendar.MONTH), previousDay.get(Calendar.DAY_OF_MONTH))
    }.timeInMillis
}

internal fun nextAndroidReminder(wallClock: String, repeat: ReminderRepeat, from: Long, zone: TimeZone): Long? {
    val date = reminderWallClock(wallClock.substringBefore('T'), wallClock.substringAfter('T', "")) ?: return null
    val year = date.take(4).toInt()
    val month = date.substring(5, 7).toInt() - 1
    val day = date.substring(8, 10).toInt()
    val hour = date.substring(11, 13).toInt()
    val minute = date.substring(14, 16).toInt()
    val local = calendar(zone)

    fun occurrence(y: Int, m: Int, d: Int): Long {
        local.clear()
        local.set(y, m, 1, 12, 0)
        local.set(Calendar.DAY_OF_MONTH, d.coerceAtMost(local.getActualMaximum(Calendar.DAY_OF_MONTH)))
        local.set(Calendar.HOUR_OF_DAY, hour)
        local.set(Calendar.MINUTE, minute)
        return local.timeInMillis
    }
    val first = occurrence(year, month, day)
    if (first >= from) return first
    if (repeat == ReminderRepeat.None) return null

    local.timeInMillis = from
    val currentYear = local.get(Calendar.YEAR)
    val currentMonth = local.get(Calendar.MONTH)
    val currentDay = local.get(Calendar.DAY_OF_MONTH)
    if (repeat == ReminderRepeat.Monthly || repeat == ReminderRepeat.Yearly) {
        val step = if (repeat == ReminderRepeat.Monthly) 1 else 12
        val elapsed = ((currentYear - year) * 12 + currentMonth - month).coerceAtLeast(0)
        val shift = elapsed / step * step
        val candidate = occurrence(year, month + shift, day)
        return if (candidate >= from) candidate else occurrence(year, month + shift + step, day)
    }

    val step = if (repeat == ReminderRepeat.Daily) 1 else 7
    val days = calendar(utc).apply {
        clear()
        set(year, month, day)
    }
    val today = calendar(utc).apply {
        clear()
        set(currentYear, currentMonth, currentDay)
    }
    val elapsed = ((today.timeInMillis - days.timeInMillis) / 86_400_000).toInt().coerceAtLeast(0)
    days.add(Calendar.DAY_OF_MONTH, elapsed / step * step)
    fun due() = occurrence(days.get(Calendar.YEAR), days.get(Calendar.MONTH), days.get(Calendar.DAY_OF_MONTH))
    val candidate = due()
    if (candidate >= from) return candidate
    days.add(Calendar.DAY_OF_MONTH, step)
    return due()
}
