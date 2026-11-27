import AnchorShared
import SwiftUI
import UIKit
import UserNotifications

@main
struct AnchorIOSApp: App {
    @UIApplicationDelegateAdaptor(AnchorNotificationDelegate.self) private var notifications

    var body: some Scene {
        WindowGroup {
            AnchorComposeView()
                .ignoresSafeArea()
                .onOpenURL { url in
                    AnchorViewControllerKt.receiveOidcBrowserUrl(url: url.absoluteString)
                }
        }
    }
}

private final class AnchorNotificationDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        let isReminder = notification.request.identifier.hasPrefix("anchor-reminder:")
        completionHandler(isReminder ? [.banner, .list, .sound] : [])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        defer { completionHandler() }
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier,
              response.notification.request.identifier.hasPrefix("anchor-reminder:") else { return }
        let info = response.notification.request.content.userInfo
        guard let origin = info["origin"] as? String,
              let userId = info["userId"] as? String,
              let noteId = info["noteId"] as? String else { return }
        AnchorViewControllerKt.receiveReminderNotification(origin: origin, userId: userId, noteId: noteId)
    }
}

private struct AnchorComposeView: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> UIViewController {
        AnchorViewControllerKt.anchorViewController()
    }

    func updateUIViewController(_ uiViewController: UIViewController, context: Context) {}
}
