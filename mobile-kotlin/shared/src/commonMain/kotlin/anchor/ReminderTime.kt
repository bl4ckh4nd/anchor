package anchor

import kotlin.time.Instant

internal enum class ReminderRepeat(val wire: String, val label: String) {
    None("none", "Does not repeat"),
    Daily("daily", "Daily"),
    Weekly("weekly", "Weekly"),
    Monthly("monthly", "Monthly"),
    Yearly("yearly", "Yearly"),
}

internal data class NoteLaunch(val origin: String, val userId: String, val noteId: String?)

private val reminderTimePattern = Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}")

internal fun reminderWallClock(date: String, time: String): String? {
    val value = "${date.trim()}T${time.trim()}"
    if (!reminderTimePattern.matches(value) || value.startsWith("0000")) return null
    val parsed = runCatching { Instant.parse("$value:00Z") }.getOrNull() ?: return null
    return value.takeIf { parsed.toString() == "$value:00Z" }
}
