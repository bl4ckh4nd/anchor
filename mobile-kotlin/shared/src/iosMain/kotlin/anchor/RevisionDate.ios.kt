package anchor

import kotlin.time.Instant
import platform.Foundation.NSDate
import platform.Foundation.NSDateFormatter
import platform.Foundation.NSDateFormatterMediumStyle
import platform.Foundation.NSDateFormatterNoStyle
import platform.Foundation.NSDateFormatterShortStyle

internal actual fun revisionDate(time: Instant): String =
    NSDateFormatter.localizedStringFromDate(
        NSDate(timeIntervalSinceReferenceDate = time.toEpochMilliseconds() / 1000.0 - 978_307_200.0),
        NSDateFormatterMediumStyle,
        NSDateFormatterShortStyle,
    )

internal actual fun noteCardDate(time: Instant): String =
    NSDateFormatter.localizedStringFromDate(
        NSDate(timeIntervalSinceReferenceDate = time.toEpochMilliseconds() / 1000.0 - 978_307_200.0),
        NSDateFormatterMediumStyle,
        NSDateFormatterNoStyle,
    )
