# Bordo mobile

Bordo uses Kotlin and Compose Multiplatform on Android and iOS. The Android
debug application ID is `com.zhfahim.anchor.compose`. The app downloads the
notebook snapshot and checks for changes while in the foreground. **Sync notes**
starts an immediate pull. New and edited notes use Bordo's Quill Delta format.
Compose restores the last session after an app restart. Android stores the
session in an encrypted file backed by the Android Keystore. iOS stores it in
the Keychain. Compose renews the session when the token exchange returns 401.
Sign out clears the local session and requests server revocation. On Save,
Room stores the pending note before the network request. Use synthetic accounts
and notes on the fixture.

When the server requires a second factor, the sign-in form switches to
authenticator code entry. The same form can submit a recovery code or
return to password sign-in. Compose saves credentials after verification.
If the server requires setup, Compose shows a key to enter in an
authenticator app. The app saves the new session after the user
acknowledges the recovery codes.

The sign-in form also offers **Create account** for the selected
server. Compose checks whether signup is allowed and displays the
approval message if the account needs administrative review.

If the selected server offers OIDC, the sign-in screen shows
**Continue with** followed by the provider name. Bordo opens the system
browser and resumes the sign-in when the browser returns to the app.
The registration and password controls are hidden on OIDC-only servers.

Open **Account settings** from the note screen to see the account email,
edit the display name, upload or remove a profile picture, or change the
password for a password account. Profile pictures accept JPG, PNG and WebP
up to 5 MiB.
Account settings follows the sections and standard light and dark colors
of the Web UI. Open **Delete account** and confirm the deletion. Bordo
asks for the current password on password accounts. After the server
confirms, Compose removes the session and this account's local drafts
and notebook cache.

Signed-in users can open **Two-factor settings** from the note screen
to set up or replace an authenticator and generate new recovery codes.
If the server policy permits it, they can also turn the authenticator off.

Open a synced note to see its attachments. Editors and owners of active
notes can pick a supported image or audio file up to 50 MiB. Images open
in a private preview, and audio has play and pause controls. Room keeps
queued uploads across process restarts. After signing in to the same
server and account or restoring that session, the foreground app retries
with the original ID.
The preview also lets editors delete their own uploads and owners delete
any attachment. Deletion requires confirmation.
Editors and owners can reorder attachments on active notes. Compose
keeps the order from the server when it syncs and after a restart.

Open **Version history** on a synced note to review its current text,
earlier revisions and conflict drafts. Select a version to preview it.
Use **Show changes** to compare it with the next regular revision or
with the current document when no newer regular revision is available.
Conflict drafts always compare with the current document.
History previews show headings, list nesting, checklist status, quotes
and code blocks. In comparisons, expand folded groups of unchanged
lines when you need more context.
Owners and editors can restore a version of an active note after confirming.
Use **Undo** in the history view to reverse the restore while the note
still matches the version created by that restore.

Open **Edit note** to change a synced note. Saving queues the edit in
Room before syncing. The editor preserves existing Quill runs and
attributes and shows embedded objects as markers. If the server refuses
the edit, open the draft under **Pending notes** to review or copy it.
The shared toolbar for new and existing notes supports bold, italic,
underline, strikethrough and inline code. Select text to format it, or
choose a format before typing.
The paragraph menu supports headings, bullet and numbered lists,
checklists, quotes and code blocks. Checklists can mark an item
checked or unchecked. These formats use the Quill attributes read by
the Web editor.
Use **Link** to add, edit or remove a link at the selection or caret.
The paragraph menu offers **Indent list** and **Outdent list** on
list items. Indentation follows the list item above.

## Android

With JDK and Android SDK Platform 37 available, run:

```sh
./gradlew :androidApp:assembleDebug
adb install -r androidApp/build/outputs/apk/debug/androidApp-debug.apk
adb shell am start -W -n com.zhfahim.anchor.compose/anchor.AnchorActivity
```

The release application ID is `com.zhfahim.anchor`. Android build code
4028 leaves room for the Flutter exporter build 27 and its split APKs
through 4027. Increment the build code before shipping another update. The tag
workflow builds the universal and architecture-specific APKs using the
existing signing credentials. Signed upgrade acceptance requires a
published predecessor and the original signing identity.

Before installing the upgrade, compare the signed candidates with
the APKs from the app's current distribution channel. Pass each
supported predecessor, including the split with the highest Android
version code.

```sh
python3 e2e/verify-android-upgrade.py \
  --build-tools "$ANDROID_HOME/build-tools/37.0.0" \
  --previous /path/to/installed-predecessor.apk \
  --previous /path/to/highest-predecessor-split.apk \
  androidApp/build/outputs/apk/release/androidApp-*-release.apk
```

The check also requires a candidate at the existing minimum Android API
level for each native ABI reported by the selected predecessor APKs.
The report contains the application ID, signing certificate digests,
version codes, minimum API levels, ABIs and APK hashes. Keep it with
the device upgrade report that verifies offline notes and attachments
after installation.

## iOS

The macOS CI job runs `:shared:iosSimulatorArm64Test` against a
disposable loopback Convex backend. It checks native authentication,
exact Quill content, the server revision, and the saved Room state
after reopening the database. A second test feeds the inbox manifest
into Compose and verifies that the shared note, tag and attachment reach
Convex once after reopening Room and replaying the manifest. The
system share sheet needs a separate device check.

To repeat the tests on an Apple Silicon
Mac with an available iPhone simulator, install the backend
dependencies and use the Convex binary pinned in the CI job.

```sh
cd mobile-kotlin
bash ../convex-backend/e2e/local-compose-fixture.sh \
  /path/to/convex-local-backend ./gradlew :shared:iosSimulatorArm64Test
```

On macOS with Xcode and XcodeGen, run `xcodegen generate` in `iosApp`
and open `AnchorIOS.xcodeproj`. Select the AnchorIOS scheme and an arm64
simulator. Xcode builds the shared Kotlin framework before Swift compilation.
The iOS host requires a macOS build and simulator verification.
Release builds use `com.zhfahim.anchor` and the existing Share Extension
identifier and App Group. Debug builds use `com.zhfahim.anchor.compose`.
The macOS CI job builds the simulator app and an unsigned device app.
The bundle checker verifies the target platform of both the app and the
embedded Share Extension.

For a device upgrade, archive the Release scheme on macOS using
the original signing team and the provisioning profiles for both
targets. Export the candidate for device installation in Xcode
Organizer and unpack the IPA. Use the signed app from the
predecessor's tested distribution channel for comparison.

```sh
cd iosApp
xcodegen generate
xcodebuild -project AnchorIOS.xcodeproj -scheme AnchorIOS -configuration Release \
  -destination 'generic/platform=iOS' -archivePath /path/to/AnchorIOS.xcarchive archive
python3 ../e2e/verify-ios-release.py \
  /path/to/candidate/Payload/AnchorIOS.app Generated \
  --platform iPhoneOS \
  --previous-app /path/to/predecessor/Payload/Runner.app
```

The verifier compares the signed app and Share Extension identities
and checks the existing App Group and the higher build number.
Install the exported build over the predecessor on a device to
check the offline export, import and Share Extension. Include an
attachment created in the original Flutter release and open it
offline after the Compose import and again after a subsequent
Compose update. Apple
documents how the App ID prefix appears in signed entitlements.
[Apple entitlements guide](https://developer.apple.com/library/archive/technotes/tn2415/)

## Server headers

Enter the server address before opening **Server headers** on the
sign-in screen. Use this setting for proxy credentials such as a
Cloudflare Access service token. Compose stores the values in the
platform's encrypted storage and attaches them to its API requests
for that scheme, host and port. Browser-based sign-in uses the
browser's own access to the server.

The notes library also offers **Server headers** while signed in.
Saving new values there resumes sync for the current account,
including drafts queued while the proxy rejected the old values.

## Upgrade from Flutter

In the Flutter build that provides the exporter, sign in to the account
you want to migrate and open **Prepare Compose upgrade** in settings.
Check the server and account displayed in the confirmation. Prepare the
backup again if you make further changes in Flutter. Install Compose
as an update to the existing app so the backup stays in its private
storage, then sign in with the same account and server address.
Check the notebook, pending changes and offline attachments before removing
any backups.

For a Flutter release without the exporter, first install a compatible
intermediate update built with `ANCHOR_PREPARE_COMPOSE_UPGRADE=true`.
App Store updates can skip intermediate builds. Confirm that the
exporter has run on the device before installing Compose over a release
with offline changes. [Apple app update guide](https://developer.apple.com/library/archive/technotes/tn2285/)
If Compose finds the old database without a matching export, the
library shows a migration notice. The old database and its attachments
stay on the device. Local changes remain unavailable in Compose until an
export for the matching server and account is available.
Both updates need the original app identity and signing configuration.
The intermediate build can use version 0.18.2, build 27. Compose defaults
to 0.18.3. Its iOS build number is 28, and both iOS updates need access
to the existing Share Extension App Group.

## Server

Point the app at the same HTTPS origin for these handlers:

- `POST /api/auth/login`, `POST /api/auth/refresh`, `POST /api/auth/logout`
  and `POST /api/auth/convex-token` go to NestJS on the bridge stack.
- Route `GET /api/auth/registration-mode` and `POST /api/auth/register`
  to the same authentication backend.
- Route `POST /api/auth/login/2fa` to the same backend as password sign-in.
- Route `POST /api/auth/enroll/totp/setup` and
  `POST /api/auth/enroll/totp/enable` to that backend as well.
- Route `GET /api/auth/2fa` and its `setup`, `enable`, `disable` and
  `recovery-codes` POST subpaths to the authentication backend.
- `POST /api/compose/notes` and `POST /api/compose/sync` go to the Convex
  HTTP Actions origin. The app uses the sync route to download notes.
- `GET /api/sync/events` goes to the same Convex origin. The foreground
  app uses it to trigger a cursor pull on changes and on reconnect.
  The regular foreground pull remains available when SSE is unavailable.
- `GET`, `POST` and `DELETE /api/compose/attachments` go
  to the same Convex HTTP Actions origin. Set the raw upload route's
  Nginx limit to `client_max_body_size 50m`.
- `PATCH /api/compose/attachments/list` goes to the same Convex origin.
  Deploy that backend before installing the attachment-order build.
- Version history uses the existing `GET /api/notes/:id` and
  `GET /api/notes/:id/revisions` routes, the revision detail route and its
  `POST .../restore` subpath.

Configure the same issuer and signing key pair in both services. The
Convex app uses the public key only. The debug Android build also permits
`http://127.0.0.1` for an isolated test proxy reached through `adb reverse`.
On the current stack, use the same Bordo server address for Web and
mobile. See the [hosting guide](../docs/hosting.md) for proxy setup.

With a disposable same-origin proxy and Convex deployment running, check the
HTTP flow from this directory. The command creates a synthetic user and note:

```sh
node compose-flow.mjs http://127.0.0.1:3690 http://127.0.0.1:3682
```

## Android offline regression

Build the debug APK first. The runner starts a disposable emulator and
uses a self-hosted Convex fixture. It creates two synthetic accounts
and removes the emulator's ADB reverse tunnel to simulate offline use.
Its temporary proxy closes every response connection and disables SSE
so pooled or streaming connections cannot bypass that interruption.

```sh
bash ../convex-backend/e2e/self-hosted-contracts.sh --native-command \
  bash "$PWD/e2e/android-board-ci.sh" "$(mktemp -d)" offline
```

The check reads both queued IDs from a copy of the stopped app's Room
database. It verifies isolation from the second account, exact IDs and
bodies in Convex, outbox cleanup, a foreground reconnect, an offline
restart after a remote edit, and remote pinning and unpinning. The
migration CI suite includes the same check. The report and screenshot
are saved in the artifact directory.

Run the same command with `cursor-reset` to test an expired checkpoint.
That case prunes a synthetic removal in the isolated Convex fixture,
interrupts snapshot pagination after one note page, and restarts the
app before releasing the remaining pages and the queued draft.

## Android attachment regression

With the debug APK installed and the same-origin proxy routing login,
Compose sync and attachments, run both system picker flows on an unlocked
test device. Pass the proxy's loopback port as the first argument.

```sh
python3 e2e/android-attachments.py 3694 image /tmp/bordo-attachment-image.json
python3 e2e/android-attachments.py 3694 audio /tmp/bordo-attachment-audio.json
python3 e2e/android-attachments.py 3694 audio /tmp/bordo-attachment-restart.json --restart
python3 e2e/android-attachments.py 3696 audio /tmp/bordo-attachment-lost-ack.json --drop-ack 3694
python3 e2e/android-attachments.py 3694 image /tmp/bordo-attachment-order.json --legacy-order 3697
```

The check compares the downloaded bytes with the selected fixture and
opens the image preview or starts and pauses playback. It then deletes the
attachment and verifies that downloading it returns HTTP 404. The output
JSON records the IDs and SHA-256.

The restart test removes the ADB tunnel before selection. The lost
receipt test binds a loopback test relay on port 3696 and withholds
successful upload responses from port 3694. Both recovery tests stop
the app, verify the persisted bytes, remove the source file and sign
in as a different account before signing back in with the owner.

The order test uses port 3697 for the NestJS attachment bridge. It
changes the order through the legacy route and through Compose, then
checks the order on screen and in Room after restarting the app.
