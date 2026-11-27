package anchor

import java.util.TimeZone
import kotlin.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AndroidReminderScheduleTest {
    private val berlin = TimeZone.getTimeZone("Europe/Berlin")

    @Test
    fun recurrenceKeepsWallClockAndUsesTheLastDayOfShorterMonths() {
        assertEquals(
            epoch("2027-03-28T07:00:00Z"),
            nextAndroidReminder("2027-03-27T09:00", ReminderRepeat.Daily, epoch("2027-03-27T08:01:00Z"), berlin),
        )
        assertEquals(
            epoch("2027-02-28T08:00:00Z"),
            nextAndroidReminder("2027-01-31T09:00", ReminderRepeat.Monthly, epoch("2027-01-31T08:01:00Z"), berlin),
        )
        assertEquals(
            epoch("2027-03-31T07:00:00Z"),
            nextAndroidReminder("2027-01-31T09:00", ReminderRepeat.Monthly, epoch("2027-02-28T08:01:00Z"), berlin),
        )
        assertEquals(
            epoch("2033-02-28T08:00:00Z"),
            nextAndroidReminder("2032-02-29T09:00", ReminderRepeat.Yearly, epoch("2032-02-29T08:01:00Z"), berlin),
        )
        assertNull(nextAndroidReminder("2027-03-27T09:00", ReminderRepeat.None, epoch("2027-03-27T08:01:00Z"), berlin))
    }

    private fun epoch(value: String) = Instant.parse(value).toEpochMilliseconds()
}
