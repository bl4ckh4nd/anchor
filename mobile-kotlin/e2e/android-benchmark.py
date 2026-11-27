"""Measure a fresh debug build against the isolated native Convex fixture."""

import json
import re
import subprocess
import sys
import time
import urllib.request
import uuid
from pathlib import Path

from android_test_ui import adb, center, click, find, shell, type_in
from benchmark_fixture import cold_marker, local_title, note_count, remote_title, seed_and_read_library, set_network, stopped_database


port, output = sys.argv[1:]
origin = f"http://127.0.0.1:{port}"
package = "com.zhfahim.anchor.compose"
database = "databases/anchor-drafts.db"
tunnel = f"tcp:{port}"
suffix = uuid.uuid4().hex
email = f"benchmark-{suffix}@example.test"
password = f"Fixture{suffix}"


def api(path, body, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(f"{origin}/api/{path}", json.dumps(body).encode(), headers)
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def elapsed(start):
    return round((time.perf_counter() - start) * 1000)


def launch():
    shell("am", "start", "-W", "-n", f"{package}/anchor.AnchorActivity")


def stop():
    shell("am", "force-stop", package)


def read_stopped_database():
    with stopped_database(package, database) as (connection, file_bytes):
        count, = connection.execute("SELECT count(*) FROM cached_notes").fetchone()
        pending, = connection.execute("SELECT count(*) FROM pending_notes").fetchone()
    return count, pending, file_bytes


account = api("auth/register", {"name": "Benchmark fixture", "email": email, "password": password})
token = account["access_token"]
cursor, pages, server_snapshot_ms = seed_and_read_library(api, "compose/sync", token)
print(f"Read {note_count} fixture notes across {pages} cursor pages.", flush=True)

adb("reverse", tunnel, tunnel)
try:
    shell("wm", "size", "390x1400")
    launch()
    find("Sign in")
    for index, value in enumerate((origin, email, password)):
        type_in(index, value)
    shell("input", "keyevent", "4")
    sign_in = center(find("Sign in"))
    started = time.perf_counter()
    shell("input", "tap", *sign_in)
    find(cold_marker)
    first_library_ms = elapsed(started)
    print("The initial library is visible.", flush=True)

    adb("reverse", "--remove", tunnel)
    set_network(False)
    stop()
    assert read_stopped_database()[:2] == (note_count, 0)
    print("The stopped Room cache contains the full snapshot.", flush=True)
    started = time.perf_counter()
    launch()
    find(cold_marker)
    warm_cache_start_ms = elapsed(started)
    meminfo = shell("dumpsys", "meminfo", package).decode()
    pss = int(re.search(r"TOTAL PSS:\s+(\d+)", meminfo)[1])

    click("New note")
    type_in(0, local_title)
    shell("input", "keyevent", "4")
    save = center(find("Save note"))
    save_started = time.perf_counter()
    shell("input", "tap", *save)
    find("Saved on this device. Waiting to send.")
    local_save_ms = elapsed(save_started)
    stop()
    assert read_stopped_database()[:2] == (note_count, 1)
    print("The stopped Room cache contains the offline draft.", flush=True)
    launch()
    find("Pending notes")
    find(local_title)

    api("notes", {"title": remote_title}, token)
    reconnect_started = time.perf_counter()
    adb("reverse", tunnel, tunnel)
    set_network(True)
    find("Pending notes sent.")
    queue_drained_ms = elapsed(reconnect_started)
    queued_age_ms = elapsed(save_started)
    find(remote_title)
    remote_visible_ms = elapsed(reconnect_started)
    find(local_title)

    changes = api("compose/sync", {"cursor": cursor}, token)
    synced_titles = {entry["note"]["title"] for entry in changes["entries"] if entry["entityType"] == "note"}
    assert {local_title, remote_title} <= synced_titles
    stop()
    final_count, final_pending, sqlite_bytes = read_stopped_database()
    assert (final_count, final_pending) == (note_count + 2, 0)
    Path(output).write_text(json.dumps({
        "fixtureNotes": note_count,
        "snapshotPages": pages,
        "snapshotHttpMs": server_snapshot_ms,
        "signInToFullLibraryObservedMs": first_library_ms,
        "offlineColdStartWithCacheObservedMs": warm_cache_start_ms,
        "offlineSaveObservedMs": local_save_ms,
        "reconnectToQueueDrainedObservedMs": queue_drained_ms,
        "queuedAgeIncludingRestartObservedMs": queued_age_ms,
        "reconnectToRemoteVisibleObservedMs": remote_visible_ms,
        "cachedNotesAfterReconnect": final_count,
        "pendingNotesAfterReconnect": final_pending,
        "stoppedSqliteBytes": sqlite_bytes,
        "androidAppPssKiB": pss,
        "observer": "Host monotonic clock; UI observations include ADB and accessibility dump latency.",
    }, indent=2) + "\n")
finally:
    subprocess.run(["adb", "reverse", "--remove", tunnel], capture_output=True, timeout=10)
