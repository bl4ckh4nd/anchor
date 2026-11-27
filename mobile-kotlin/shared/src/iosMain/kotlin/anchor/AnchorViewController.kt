package anchor

import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.uikit.LocalUIViewController
import androidx.compose.ui.window.ComposeUIViewController
import androidx.room.Room
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.io.files.Path
import platform.Foundation.NSApplicationSupportDirectory
import platform.Foundation.NSDocumentDirectory
import platform.Foundation.NSFileManager
import platform.Foundation.NSHomeDirectory
import platform.Foundation.NSSearchPathForDirectoriesInDomains
import platform.Foundation.NSUserDomainMask
import platform.UIKit.UIUserInterfaceStyle

private val oidcCallbacks = OidcBrowserCallbacks()
private val noteLaunch = MutableStateFlow<NoteLaunch?>(null)

fun receiveOidcBrowserUrl(url: String) = oidcCallbacks.accept(url)

fun receiveReminderNotification(origin: String, userId: String, noteId: String) {
    noteLaunch.value = NoteLaunch(origin, userId, noteId)
}

fun anchorViewController() = ComposeUIViewController {
    val controller = LocalUIViewController.current
    val authorization by IosReminders.authorizationChanges.collectAsState()
    val schedule: suspend (AnchorSession?, List<CachedNote>) -> Unit = remember(authorization) {
        { session, notes -> IosReminders.publish(session, notes) }
    }
    val legacyUpgradeSupport = remember {
        val support = NSSearchPathForDirectoriesInDomains(NSApplicationSupportDirectory, NSUserDomainMask, true)
        Path(support.first() as String)
    }
    val legacyUpgradeDocuments = remember {
        Path(NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, true).first() as String)
    }
    val sharedContainer = remember {
        NSFileManager.defaultManager.containerURLForSecurityApplicationGroupIdentifier("group.com.zhfahim.anchor")
            ?.path
    }
    AnchorApp(
        remember { IosSessionStore() }, oidcCallbacks, legacyUpgradeSupport, legacyUpgradeDocuments,
        legacyUpgradeShareFolder = sharedContainer?.let { Path(it, "share") },
        serverHeaderStore = remember { IosSessionStore(serverHeaders = true) },
        nativeShareFolder = sharedContainer?.let { Path(it, "compose-share") },
        publishReminders = schedule,
        noteLaunch = noteLaunch,
        requestReminderPermission = IosReminders::requestPermission,
        onAppearanceChanged = { appearance, _ ->
            controller.overrideUserInterfaceStyle = when (appearance) {
                AnchorAppearance.Light -> UIUserInterfaceStyle.UIUserInterfaceStyleLight
                AnchorAppearance.Dark -> UIUserInterfaceStyle.UIUserInterfaceStyleDark
                AnchorAppearance.System -> UIUserInterfaceStyle.UIUserInterfaceStyleUnspecified
            }
            controller.setNeedsStatusBarAppearanceUpdate()
        },
    ) {
        openDraftDatabase(
            Room.databaseBuilder(
                name = NSHomeDirectory() + "/Library/anchor-drafts.db",
                factory = { DraftDatabaseConstructor.initialize() },
            ),
        )
    }
}
