package anchor

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.currentStateAsState
import kotlinx.coroutines.suspendCancellableCoroutine
import platform.Foundation.NSCalendar
import platform.Foundation.NSCalendarIdentifierGregorian
import platform.Foundation.NSDate
import platform.Foundation.NSDateFormatter
import platform.Foundation.NSLocale
import platform.Foundation.NSTimeZone
import platform.Foundation.NSURL
import platform.Foundation.localTimeZone
import platform.UIKit.UIApplication
import platform.UIKit.UIApplicationOpenSettingsURLString
import platform.UserNotifications.UNAuthorizationStatusDenied
import platform.UserNotifications.UNUserNotificationCenter
import kotlin.coroutines.resume

internal actual fun reminderNow(): String {
    val zone = NSTimeZone.localTimeZone
    val calendar = checkNotNull(NSCalendar.calendarWithIdentifier(NSCalendarIdentifierGregorian))
    calendar.timeZone = zone
    return NSDateFormatter().apply {
        locale = NSLocale(localeIdentifier = "en_US_POSIX")
        this.calendar = calendar
        timeZone = zone
        dateFormat = "yyyy-MM-dd'T'HH:mm"
    }.stringFromDate(NSDate())
}

@Composable
internal actual fun reminderNotifications(): ReminderNotifications {
    val lifecycle by LocalLifecycleOwner.current.lifecycle.currentStateAsState()
    val disabled by produceState(false, lifecycle) {
        value = suspendCancellableCoroutine { continuation ->
            UNUserNotificationCenter.currentNotificationCenter().getNotificationSettingsWithCompletionHandler {
                continuation.resume(it?.authorizationStatus == UNAuthorizationStatusDenied)
            }
        }
    }
    return ReminderNotifications(disabled) {
        NSURL.URLWithString(UIApplicationOpenSettingsURLString)?.let { url ->
            UIApplication.sharedApplication.openURL(url, options = emptyMap<Any?, Any>(), completionHandler = null)
        }
    }
}
