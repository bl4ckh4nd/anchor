package anchor

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ReminderTimeTest {
    @Test
    fun validatesWallClockWithoutConvertingToATimeZone() {
        assertEquals("2032-02-29T07:05", reminderWallClock("2032-02-29", "07:05"))
        assertNull(reminderWallClock("2031-02-29", "07:05"))
        assertNull(reminderWallClock("2032-04-31", "07:05"))
        assertNull(reminderWallClock("2032-02-29", "24:00"))
        assertNull(reminderWallClock("2032-02-29", "07:60"))
        assertNull(reminderWallClock("2032-02-29", "07:05Z"))
        assertNull(reminderWallClock("0000-01-01", "07:05"))
    }
}
