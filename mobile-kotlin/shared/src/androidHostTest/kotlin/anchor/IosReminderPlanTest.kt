package anchor

import kotlin.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class IosReminderPlanTest {
    private val now = Instant.parse("2027-01-01T10:00:00Z")

    @Test
    fun choosesNativeRepeatOnlyWhenItCannotFireBeforeTheStartDate() {
        val daily = iosReminderDates("2027-01-01T09:00", ReminderRepeat.Daily, now)
        assertEquals(listOf(IosReminderDate("2027-01-02T09:00", ReminderRepeat.Daily)), daily)
        val future = iosReminderDates("2027-01-04T09:00", ReminderRepeat.Daily, now)
        assertEquals("2027-01-04T09:00", future.first().wallClock)
        assertEquals(12, future.size)
        assertNull(future.first().repeat)
        assertEquals(emptyList<IosReminderDate>(), iosReminderDates("2027-01-01T09:00", ReminderRepeat.None, now))
    }

    @Test
    fun shorterMonthsAndLeapYearsRetainTheOriginalCalendarAnchor() {
        val monthly = iosReminderDates("2027-01-31T09:00", ReminderRepeat.Monthly, now)
        assertEquals(listOf("2027-01-31T09:00", "2027-02-28T09:00", "2027-03-31T09:00"),
            monthly.take(3).map { it.wallClock })
        assertEquals(listOf(null, null, null), monthly.take(3).map { it.repeat })
        val yearly = iosReminderDates("2028-02-29T09:00", ReminderRepeat.Yearly, now)
        assertEquals("2032-02-29T09:00", yearly[4].wallClock)
    }

    @Test
    fun selectsTheSoonestSixtyRequestsAcrossNotes() {
        fun note(id: String, at: String, repeat: String? = null) =
            CachedNote("https://anchor.test", "user", id, id, null, 1, remindAt = at, reminderRecurrence = repeat)
        val later = List(60) { note("later-$it", "2027-07-01T12:00") }
        val notes = later + note("earlier", "2027-02-01T12:00") +
            note("archived", "2027-01-02T12:00").copy(isArchived = true)
        val plan = planIosReminders(notes, now)
        assertEquals(60, plan.size)
        assertEquals("earlier", plan.first().note.id)
        assertEquals(false, plan.any { it.note.id == "archived" })
    }
}
