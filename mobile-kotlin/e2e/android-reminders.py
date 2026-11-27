"""Run on a disposable Android emulator with notification permission granted."""
import datetime
import json
import re
import subprocess
import sys
import time
import urllib.request
import uuid
from pathlib import Path
from xml.etree import ElementTree
from zoneinfo import ZoneInfo

port, artifact, *options = sys.argv[1:]
assert options in ([], ["--timezone"])
origin = f"http://127.0.0.1:{int(port)}"
tunnel = f"tcp:{int(port)}"
package = "com.zhfahim.anchor.compose"
token = None


def api(path, method, data, status):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(origin + "/api/" + path, json.dumps(data).encode(), headers, method=method)
    with urllib.request.urlopen(request, timeout=15) as response:
        assert response.status == status
        return json.load(response)


def adb(*args):
    return subprocess.check_output(["adb", *args], timeout=20)


def shell(*args):
    return adb("shell", *args)


def nodes():
    path = "/data/local/tmp/anchor-reminders.xml"
    shell("uiautomator", "dump", path)
    return list(ElementTree.fromstring(shell("cat", path)).iter("node"))


def wait_for(read, seconds=30):
    deadline = time.monotonic() + seconds
    last_error = None
    while time.monotonic() < deadline:
        try:
            value = read()
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
            last_error = error
            value = None
        if value:
            return value
        time.sleep(1)
    raise AssertionError("Timed out waiting for " + read.__name__) from last_error


def find(label):
    return wait_for(lambda: next((node.attrib for node in nodes() if node.get("text") == label), None), 60)


def tap(node):
    left, top, right, bottom = map(int, re.findall(r"\d+", node["bounds"]))
    shell("input", "tap", str((left + right) // 2), str((top + bottom) // 2))


def agenda():
    saved = subprocess.run(
        ["adb", "exec-out", "run-as", package, "cat", "shared_prefs/anchor-reminders.xml"],
        capture_output=True, timeout=10,
    )
    if saved.returncode or not saved.stdout.startswith(b"<?xml"):
        return None
    element = ElementTree.fromstring(saved.stdout).find("string[@name='agenda']")
    return json.loads(element.text) if element is not None else None


def has_alarm():
    return any(line.strip().startswith("tag=") and "anchor.reminder.ALARM" in line
               for line in shell("dumpsys", "alarm").decode().splitlines())


def local_in(minutes):
    local = datetime.datetime.strptime(shell("date", "+%Y-%m-%dT%H:%M").decode().strip(), "%Y-%m-%dT%H:%M")
    return (local + datetime.timedelta(minutes=minutes)).isoformat(timespec="minutes")


def set_reminder(note_id, wall_clock, recurrence="none"):
    reminder = None if wall_clock is None else {"remindAt": wall_clock, "recurrence": recurrence}
    return api("notes/" + note_id, "PATCH", {"reminder": reminder}, 200)


def verify_timezone(note_id):
    assert shell("getprop", "ro.kernel.qemu").decode().strip() == "1"
    source, destination = "Etc/UTC", "America/Los_Angeles"
    original_zone = shell("getprop", "persist.sys.timezone").decode().strip()
    auto_zone = shell("settings", "get", "global", "auto_time_zone").decode().strip()

    def scheduled(zone):
        current = agenda()
        if current and current["zone"] == zone:
            return next((entry for entry in current["entries"] if entry["id"] == note_id), None)

    def epoch_ms(local, zone):
        return int(local.replace(tzinfo=ZoneInfo(zone)).timestamp() * 1000)

    def reminder_alarm():
        lines = shell("dumpsys", "alarm").decode().splitlines()
        for index, line in enumerate(lines):
            if line.strip().startswith("tag=") and "anchor.reminder.ALARM" in line:
                match = re.search(r"RTC_WAKEUP.*origWhen (\d+)", lines[index - 1])
                if match:
                    return int(match[1]), "\n".join(lines[index - 1:index + 5]) + "\n"

    try:
        shell("settings", "put", "global", "auto_time_zone", "0")
        shell("cmd", "alarm", "set-timezone", source)
        wait_for(lambda: shell("getprop", "persist.sys.timezone").decode().strip() == source)
        now = datetime.datetime.fromtimestamp(int(shell("date", "+%s")), datetime.timezone.utc)
        first = (now + datetime.timedelta(seconds=80)).replace(second=0, microsecond=0, tzinfo=None)
        tomorrow = first + datetime.timedelta(days=1)
        set_reminder(note_id, first.isoformat(timespec="minutes"), "daily")
        queued = wait_for(lambda: scheduled(source))
        assert queued["dueAt"] == epoch_ms(first, source), queued
        wait_for(has_alarm)
        shell("input", "keyevent", "3")
        wait_for(lambda: (f"anchor-reminder:{note_id}") in shell("dumpsys", "notification", "--noredact").decode(), 160)
        following = wait_for(lambda: scheduled(source))
        assert following["dueAt"] == epoch_ms(tomorrow, source), following
        print("The system delivered the first occurrence and scheduled the following day.", flush=True)
        def background_process_exited():
            shell("am", "kill", package)
            return not subprocess.run(["adb", "shell", "pidof", package], capture_output=True, timeout=10).stdout.strip()

        wait_for(background_process_exited)
        shell("cmd", "alarm", "set-timezone", destination)
        moved = wait_for(lambda: scheduled(destination))
        scheduled_alarm = wait_for(reminder_alarm)
        result = Path(artifact)
        result.with_suffix(".alarm.txt").write_text(scheduled_alarm[1])
        expected = epoch_ms(tomorrow, destination)
        assert moved["dueAt"] == expected, f"Unexpected next daily occurrence after timezone change: {moved['dueAt']} != {expected}"
        assert scheduled_alarm[0] == expected, scheduled_alarm
        assert moved["version"] == queued["version"]
        shell("am", "start", "-W", "-n", package + "/anchor.AnchorActivity")
        find(title)
        assert scheduled(destination)["dueAt"] == expected
        result.write_text(json.dumps({
            "firstOccurrenceDelivered": True,
            "backgroundProcessExitedBeforeZoneChange": True,
            "nextLocalDayRetained": True,
            "wallClockPreservedAfterReopening": True,
            "dueAfterZoneChangeMs": moved["dueAt"],
            "expectedDueMs": expected,
            "deliveredDayDueInDestinationMs": epoch_ms(first, destination),
            "alarmManagerDueMs": scheduled_alarm[0],
        }, indent=2) + "\n")
    finally:
        if original_zone:
            shell("cmd", "alarm", "set-timezone", original_zone)
        if auto_zone == "null":
            shell("settings", "delete", "global", "auto_time_zone")
        else:
            shell("settings", "put", "global", "auto_time_zone", auto_zone)


suffix = uuid.uuid4().hex
email = f"reminders-{suffix}@example.test"
password = "Fixture" + suffix
account = api("auth/register", "POST", {"name": "Notification fixture", "email": email, "password": password}, 201)
token = account["access_token"]
title = "Reminder fixture"
body = "Opened from Android notification"
note = api("notes", "POST", {"title": title, "content": json.dumps({"ops": [{"insert": body + "\n"}]})}, 201)
future_note = api("notes", "POST", {"title": "Cancelled reminder fixture"}, 201)
assert tunnel not in adb("reverse", "--list").decode().split()
adb("reverse", tunnel, tunnel)

try:
    if options:
        shell("pm", "grant", package, "android.permission.POST_NOTIFICATIONS")
    shell("am", "start", "-W", "-n", package + "/anchor.AnchorActivity")
    find("Sign in")
    for index, value in enumerate((origin, email, password)):
        fields = [node.attrib for node in nodes() if node.get("class") == "android.widget.EditText"]
        tap(fields[index])
        shell("input", "text", value)
    shell("input", "keyevent", "4")
    tap(find("Sign in"))
    find(title)

    if options:
        verify_timezone(note["id"])
        sys.exit(0)

    later = local_in(20)
    set_reminder(note["id"], later)

    def scheduled(wall_clock):
        current = agenda()
        if current:
            return next((entry for entry in current["entries"]
                         if entry["id"] == note["id"] and entry["wallClock"] == wall_clock), None)

    first = wait_for(lambda: scheduled(later))
    soon = local_in(2)
    set_reminder(note["id"], soon)
    earlier = wait_for(lambda: scheduled(soon))
    assert earlier["dueAt"] < first["dueAt"]
    assert earlier["version"] > first["version"]
    wait_for(has_alarm)
    print("Scheduled reminder was replaced with an earlier alarm.", flush=True)
    shell("input", "keyevent", "3")

    def background_process_exited():
        shell("am", "kill", package)
        return not subprocess.run(["adb", "shell", "pidof", package], capture_output=True).stdout.strip()

    wait_for(background_process_exited)
    print("Activity process ended with an alarm still scheduled.", flush=True)
    wait_for(lambda: ("anchor-reminder:" + note["id"]) in shell("dumpsys", "notification", "--noredact").decode(), 240)
    assert scheduled(soon)["dueAt"] is None
    shell("cmd", "statusbar", "expand-notifications")
    tap(find(title))
    wait_for(lambda: any((node.get("text") or "").strip() == body for node in nodes()))
    print("Android delivered the notification and opened its note.", flush=True)

    set_reminder(future_note["id"], local_in(25))
    wait_for(lambda: any(entry["id"] == future_note["id"] for entry in (agenda() or {}).get("entries", [])))
    set_reminder(future_note["id"], None)
    wait_for(lambda: not any(entry["id"] == future_note["id"] for entry in (agenda() or {}).get("entries", [])))
    set_reminder(future_note["id"], local_in(26))
    wait_for(has_alarm)
    shell("input", "keyevent", "4")  # Close the note the notification opened.
    for label in ("Open menu", "Account menu"):
        tap(wait_for(lambda: next((n.attrib for n in nodes() if n.get("content-desc") == label), None), 60))
    tap(find("Sign out"))
    find("Sign in")
    wait_for(lambda: agenda() is None and not has_alarm())
    Path(artifact).write_text(json.dumps({
        "updatedAlarmToEarlierTime": True,
        "notificationDeliveredAfterProcessDeath": True,
        "notificationOpenedOriginalNote": True,
        "oneTimeReminderNotRescheduled": True,
        "removedReminderAndClearedAlarmsOnSignOut": True,
    }) + "\n")
finally:
    subprocess.run(["adb", "reverse", "--remove", tunnel], capture_output=True, timeout=10)
