package anchor

import java.text.DateFormat
import java.util.Date
import kotlin.time.Instant

internal actual fun revisionDate(time: Instant): String =
    DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT)
        .format(Date(time.toEpochMilliseconds()))

internal actual fun noteCardDate(time: Instant): String =
    DateFormat.getDateInstance(DateFormat.MEDIUM).format(Date(time.toEpochMilliseconds()))
