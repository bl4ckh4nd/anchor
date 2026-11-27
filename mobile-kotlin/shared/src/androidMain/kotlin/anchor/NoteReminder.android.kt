package anchor

import android.app.NotificationManager
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.currentStateAsState
import java.util.Calendar
import java.util.Date
import java.util.GregorianCalendar

internal actual fun reminderNow(): String {
    // Gregorian and ASCII digits whatever the device locale, so the wall clock parses.
    val now = GregorianCalendar().apply { gregorianChange = Date(Long.MIN_VALUE) }
    fun two(value: Int) = value.toString().padStart(2, '0')
    return "${now.get(Calendar.YEAR).toString().padStart(4, '0')}-${two(now.get(Calendar.MONTH) + 1)}-" +
        "${two(now.get(Calendar.DAY_OF_MONTH))}T${two(now.get(Calendar.HOUR_OF_DAY))}:${two(now.get(Calendar.MINUTE))}"
}

@Composable
internal actual fun reminderNotifications(): ReminderNotifications {
    val context = LocalContext.current
    val lifecycle by LocalLifecycleOwner.current.lifecycle.currentStateAsState()
    val disabled = remember(context, lifecycle) {
        context.getSystemService(NotificationManager::class.java)?.areNotificationsEnabled() == false
    }
    return ReminderNotifications(disabled) {
        val intent = if (Build.VERSION.SDK_INT >= 26) {
            Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
        } else {
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))
        }
        context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}
