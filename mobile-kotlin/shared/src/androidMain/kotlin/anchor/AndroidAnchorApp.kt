package anchor

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.room.Room
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.io.files.Path

@Composable
fun AndroidAnchorApp(
    context: Context, oidcCallbacks: OidcBrowserCallbacks, shares: AndroidShareCallbacks, launches: AndroidNoteLaunchCallbacks,
    updateSystemBars: (Boolean) -> Unit,
) {
    val app = context.applicationContext
    val permissions = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}
    val schedule: suspend (AnchorSession?, List<CachedNote>) -> Unit = remember(app) {
        { session, notes -> withContext(Dispatchers.IO) { AndroidReminders.publish(app, session, notes) } }
    }
    val sessionStore = remember(app) { AndroidSessionStore(app) }
    val publishWidget = remember(sessionStore) { sessionStore::publishWidget }
    AnchorApp(
        sessionStore, oidcCallbacks, Path(app.filesDir.absolutePath),
        Path(app.applicationInfo.dataDir, "app_flutter"),
        Path(app.filesDir.absolutePath, "share"),
        serverHeaderStore = remember(app) { AndroidSessionStore(app, serverHeaders = true) },
        incomingShares = shares.pending,
        publishReminders = schedule,
        publishWidget = publishWidget,
        noteLaunch = launches.pending,
        onAppearanceChanged = { _, dark -> updateSystemBars(dark) },
        requestReminderPermission = {
            if (Build.VERSION.SDK_INT >= 33 &&
                app.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                permissions.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        },
    ) {
        openDraftDatabase(
            Room.databaseBuilder(
                context = app,
                name = app.getDatabasePath("anchor-drafts.db").absolutePath,
                factory = { DraftDatabaseConstructor.initialize() },
            ),
        )
    }
}
