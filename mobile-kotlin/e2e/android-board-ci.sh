#!/usr/bin/env bash
set -euo pipefail

mkdir -p -- "${1:?Pass the artifact directory}"
artifacts="$(cd -- "$1" && pwd)"
driver="${2:-board}"
case "$driver" in
    board|note-selection|appearance|density|card-pictures|checklist|tag-filter|benchmark|outbox-scope|revoked-editor|delayed-pull|editor-focus|editor-typography|checklist-sort|audio-recording|attachment-export-image|attachment-export-audio|\
    attachment-share|attachment-photos|attachment-cache|attachment-seek|editor-clear-formatting|editor-highlight|reminder-timezone|live-sync|offline|cursor-reset|edit) tests=("$driver") ;;
    audio-outbox) tests=(outbox-scope); export ANCHOR_TEST_OUTBOX_RECORDING=1 ;;
    migration) tests=(board note-selection appearance density card-pictures checklist checklist-sort tag-filter note-copy
                      server-headers outbox-scope revoked-editor delayed-pull editor-focus editor-typography
                      editor-clear-formatting editor-highlight reminder-timezone live-sync offline cursor-reset edit) ;;
    media) tests=(attachment-cache attachment-seek attachment-export-image attachment-export-audio
                  attachment-share attachment-photos audio-recording audio-outbox) ;;
    *) printf 'Unknown Android test driver: %s\n' "$driver" >&2; exit 2 ;;
esac
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
site_port="${ANCHOR_CONVEX_SITE_PORT:?Start the native Convex test fixture}"
if [[ "$driver" == migration ]]; then
    node ../convex-backend/e2e/copy-undo.mjs "$artifacts/copy-undo.json"
fi
emulator_port="${ANDROID_CI_EMULATOR_PORT:-5554}"
export ANDROID_SERIAL="emulator-$emulator_port"
if adb devices | grep -q "^$ANDROID_SERIAL[[:space:]]"; then
    printf 'Emulator %s is already in use.\n' "$ANDROID_SERIAL" >&2
    exit 1
fi

export ANDROID_AVD_HOME="$(mktemp -d)"
emulator_pid=
cleanup() {
    if [[ -n "$emulator_pid" ]]; then
        kill "$emulator_pid" 2>/dev/null || true
        wait "$emulator_pid" 2>/dev/null || true
    fi
    rm -rf -- "$ANDROID_AVD_HOME"
}
trap cleanup EXIT

image="${ANDROID_CI_SYSTEM_IMAGE:-system-images;android-35;google_apis;x86_64}"
avdmanager create avd --name anchor-ci --package "$image" <<< no
emulator_options=()
if [[ "$driver" != audio-recording && "$driver" != audio-outbox && "$driver" != media ]]; then
    emulator_options+=(-no-audio)
fi
if [[ "$driver" != board ]]; then
    emulator_options+=(-memory 4096)
fi
"$ANDROID_HOME/emulator/emulator" -avd anchor-ci -port "$emulator_port" -no-window \
    -no-boot-anim -no-snapshot -no-metrics -gpu off -feature -Vulkan \
    -partition-size 4096 "${emulator_options[@]}" \
    > "$artifacts/emulator.log" 2>&1 &
emulator_pid=$!
boot_deadline=$((SECONDS + 180))
until [[ "$(adb shell getprop sys.boot_completed 2>/dev/null)" == 1 ]]; do
    kill -0 "$emulator_pid" && (( SECONDS < boot_deadline )) || exit 1
    sleep 2
done

if [[ "$image" == system-images\;android-28\;* ]]; then
    for scale in window_animation_scale transition_animation_scale animator_duration_scale; do
        adb shell settings put global "$scale" 0
    done
fi
adb shell input keyevent 82
adb shell wm size 390x900
adb shell wm density 160
adb install "${ANCHOR_TEST_ANDROID_APK:-androidApp/build/outputs/apk/debug/androidApp-debug.apk}"
if [[ "$driver" == attachment-share || "$driver" == media ]]; then
    bash e2e/build-share-receiver.sh "$ANDROID_AVD_HOME/recipient.apk"
    adb install "$ANDROID_AVD_HOME/recipient.apk"
fi
adb shell am start -W -n com.zhfahim.anchor.compose/anchor.AnchorActivity
for attempt in 1 2 3 4 5; do
    if adb shell uiautomator dump /data/local/tmp/anchor-ci.xml \
        && adb pull /data/local/tmp/anchor-ci.xml "$artifacts/launch.xml" \
        && grep -q 'text="Sign in"' "$artifacts/launch.xml"; then
        break
    fi
    [[ "$attempt" != 5 ]] || exit 1
    sleep 2
done

for index in "${!tests[@]}"; do
    test="${tests[$index]}"
    if (( index > 0 )); then
        adb shell pm clear com.zhfahim.anchor.compose | grep -qx Success
    fi
    if [[ "$test" != board && "$test" != benchmark ]]; then
        adb shell wm size 390x1400
    fi
    command=(python3 -B "e2e/android-$test.py" "$site_port" "$artifacts/$test.json")
    case "$test" in
        cursor-reset) command=(python3 -B e2e/android-offline.py "$site_port" "$artifacts/$test.json" --cursor-reset) ;;
        reminder-timezone) command=(python3 -B e2e/android-reminders.py "$site_port" "$artifacts/$test.json" --timezone) ;;
        live-sync) command=(python3 -B e2e/android-live-sync.py 0 "$artifacts/$test.json") ;;
        attachment-export-*) command=(python3 -B e2e/android-attachments.py "$site_port" "${test##*-}" "$artifacts/$test.json" --export) ;;
        attachment-share) command=(python3 -B e2e/android-attachments.py "$site_port" image "$artifacts/$test.json" --share) ;;
        attachment-photos) command=(python3 -B e2e/android-attachments.py "$site_port" image "$artifacts/$test.json" --photos) ;;
        attachment-seek) command=(python3 -B e2e/android-attachments.py "$site_port" audio "$artifacts/$test.json" --seek) ;;
        audio-outbox) command=(env ANCHOR_TEST_OUTBOX_RECORDING=1
                              python3 -B e2e/android-outbox-scope.py "$site_port" "$artifacts/$test.json") ;;
    esac
    if ! "${command[@]}" 2>&1 | tee "$artifacts/$test.log"; then
        adb exec-out screencap -p > "$artifacts/$test-failure.png" || true
        adb logcat -b crash -d > "$artifacts/$test-crash.log" || true
        exit 1
    fi
    test -s "$artifacts/$test.json"
done
