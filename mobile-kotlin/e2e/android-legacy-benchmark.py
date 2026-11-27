"""Measure the Flutter debug APK against a disposable NestJS fixture."""

import argparse
import json
import re
import subprocess
import sys
import time
import urllib.request
import uuid
from pathlib import Path

from android_test_ui import adb, center, nodes, shell
from benchmark_fixture import cold_marker, local_title, note_count, remote_title, seed_and_read_library, set_network, stopped_database


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("port")
parser.add_argument("output", type=Path)
parser.add_argument("--server-only", action="store_true")
args = parser.parse_args()
port, output = args.port, args.output
origin = f"http://127.0.0.1:{port}"
package = "com.zhfahim.anchor.debug"
tunnel = f"tcp:{port}"
suffix = uuid.uuid4().hex
email = f"benchmark-{suffix}@example.test"
password = f"Fixture{suffix}"


def api(path, body, token=None):
    headers = {"Content-Type": "application/json", "X-Anchor-Protocol": "4"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(f"{origin}/api/{path}", json.dumps(body).encode(), headers)
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def find(label, seconds=20, clickable=False):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        for node in nodes():
            if clickable and node.get("clickable") != "true":
                continue
            for field in ("text", "content-desc"):
                value = node.get(field, "")
                if value == label or value.startswith((label + "\n", label + ", ", label + ". ")):
                    return node
    raise AssertionError(f"Flutter UI label was not observed: {label}")


def click(label):
    shell("input", "tap", *center(find(label, clickable=True)))


def edit_fields():
    return [
        node for node in nodes()
        if node.get("class") == "android.widget.EditText"
        and not any(child.get("class") == "android.widget.EditText" for child in node.iter("node") if child is not node)
    ]


def type_in(index, value):
    for _ in range(3):
        shell("input", "tap", *center(edit_fields()[index]))
        assert edit_fields()[index].get("focused") == "true"
        shell("input", "keycombination", "113", "29")
        shell("input", "text", value)
        field = edit_fields()[index]
        if field.get("text") == value or (field.get("password") == "true" and len(field.get("text", "")) == len(value)):
            return
    raise AssertionError(f"Could not populate Flutter field {index + 1}")


def elapsed(start):
    return round((time.perf_counter() - start) * 1000)


def launch():
    shell(
        "am", "start", "-W", "-n", f"{package}/com.zhfahim.anchor.MainActivity",
        "--ez", "enable-impeller", "false", "--ez", "enable-software-rendering", "true",
    )


def stop():
    shell("am", "force-stop", package)


def read_stopped_database(user):
    with stopped_database(package, f"app_flutter/db_{user}.sqlite") as (connection, bytes_stored):
        count, dirty = connection.execute(
            "SELECT count(*), count(*) FILTER (WHERE is_synced = 0) FROM notes"
        ).fetchone()
    return count, dirty, bytes_stored


account = api("auth/register", {"name": "Benchmark fixture", "email": email, "password": password})
token = account["access_token"]
user = account["user"]["id"]
cursor, pages, server_snapshot_ms = seed_and_read_library(api, "sync", token)
print(f"Read {note_count} fixture notes across {pages} cursor pages.", flush=True)
if args.server_only:
    output.write_text(json.dumps({
        "fixtureNotes": note_count,
        "snapshotPages": pages,
        "snapshotHttpMs": server_snapshot_ms,
        "scope": "NestJS HTTP snapshot",
    }, indent=2) + "\n")
    sys.exit(0)

adb("reverse", tunnel, tunnel)
try:
    launch()
    find("Welcome to Anchor")
    type_in(0, origin)
    shell("input", "keyevent", "4")
    click("Continue")
    find("Sign in")
    type_in(0, email)
    type_in(1, password)
    shell("input", "keyevent", "4")
    sign_in = center(find("Sign in", clickable=True))
    started = time.perf_counter()
    shell("input", "tap", *sign_in)
    find(cold_marker, 50, clickable=True)
    first_library_ms = elapsed(started)
    print("The initial Flutter library is visible.", flush=True)

    adb("reverse", "--remove", tunnel)
    set_network(False)
    stop()
    assert read_stopped_database(user)[:2] == (note_count, 0)
    started = time.perf_counter()
    launch()
    find(cold_marker, clickable=True)
    cold_start_ms = elapsed(started)
    pss = int(re.search(r"TOTAL PSS:\s+(\d+)", shell("dumpsys", "meminfo", package).decode())[1])

    click("New note")
    type_in(0, local_title)
    close = center(find("Back", clickable=True))
    save_started = time.perf_counter()
    shell("input", "tap", *close)
    find(local_title, clickable=True)
    offline_return_ms = elapsed(save_started)
    stop()
    assert read_stopped_database(user)[:2] == (note_count + 1, 1)
    launch()
    find(local_title, clickable=True)
    print("The restarted Flutter library contains the offline draft.", flush=True)

    api("notes", {"title": remote_title}, token)
    reconnect_started = time.perf_counter()
    adb("reverse", tunnel, tunnel)
    set_network(True)
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        changes = api("sync", {"cursor": cursor}, token)
        titles = {entry["note"]["title"] for entry in changes["entries"] if entry["entityType"] == "note"}
        if {local_title, remote_title} <= titles:
            break
        time.sleep(0.25)
    else:
        raise AssertionError("NestJS did not receive the offline Flutter draft after reconnect")
    queue_drained_ms = elapsed(reconnect_started)
    queued_age_ms = elapsed(save_started)
    find(remote_title, 50, clickable=True)
    remote_visible_ms = elapsed(reconnect_started)
    stop()
    final_count, dirty, sqlite_bytes = read_stopped_database(user)
    assert (final_count, dirty) == (note_count + 2, 0)
    Path(output).write_text(json.dumps({
        "fixtureNotes": note_count,
        "snapshotPages": pages,
        "snapshotHttpMs": server_snapshot_ms,
        "signInToFullLibraryObservedMs": first_library_ms,
        "offlineColdStartWithCacheObservedMs": cold_start_ms,
        "offlineEditorCloseToVisibleDraftObservedMs": offline_return_ms,
        "reconnectToServerReceiptObservedMs": queue_drained_ms,
        "queuedAgeSinceEditorCloseObservedMs": queued_age_ms,
        "reconnectToRemoteVisibleAfterReceiptObservedMs": remote_visible_ms,
        "cachedNotesAfterReconnect": final_count,
        "dirtyNotesAfterReconnect": dirty,
        "stoppedSqliteBytes": sqlite_bytes,
        "androidAppPssKiB": pss,
        "observer": "Host monotonic clock. UI observations include ADB and accessibility dump latency.",
    }, indent=2) + "\n")
finally:
    subprocess.run(["adb", "reverse", "--remove", tunnel], capture_output=True, timeout=10)
