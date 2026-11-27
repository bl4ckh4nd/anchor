import json
import sqlite3
import subprocess
import tempfile
import time
import uuid
from contextlib import closing, contextmanager
from pathlib import Path

from android_test_ui import shell


note_count = 500
cold_marker = "Benchmark-library-marker"
local_title = "Benchmark-offline-draft"
remote_title = "Benchmark-remote-delta"


def set_network(enabled):
    state = "enable" if enabled else "disable"
    for service in ("wifi", "data"):
        shell("svc", service, state)


def seed_and_read_library(api, endpoint, token):
    notes = [
        {
            "type": "note",
            "id": str(uuid.uuid4()),
            "title": cold_marker if index == 0 else f"Fixture-{index:04}",
            "content": json.dumps({"ops": [
                {"insert": "Synthetic benchmark note", "attributes": {"bold": True}},
                {"insert": "\n" + ("Sample paragraph for testing. " * (4 + index % 280)) + "\n"},
            ]}),
        }
        for index in range(note_count)
    ]
    for offset in range(0, note_count, 50):
        batch = notes[offset:offset + 50]
        results = api(endpoint, {"changes": batch}, token)["results"]
        assert len(results) == len(batch) and all(row["status"] == "applied" for row in results)
    assert api(endpoint, {
        "changes": [{"type": "pin", "id": notes[0]["id"], "isPinned": True}],
    }, token)["results"][0]["status"] == "applied"

    cursor = None
    pages = 0
    observed = set()
    sync_started = time.perf_counter()
    while True:
        page = api(endpoint, {} if cursor is None else {"cursor": cursor}, token)
        pages += 1
        observed.update(entry["entityId"] for entry in page["entries"] if entry["entityType"] == "note")
        assert page["nextCursor"] and (not page["hasMore"] or page["nextCursor"] != cursor)
        cursor = page["nextCursor"]
        if not page["hasMore"]:
            break
    assert observed == {note["id"] for note in notes}
    server_snapshot_ms = round((time.perf_counter() - sync_started) * 1000)
    return cursor, pages, server_snapshot_ms


@contextmanager
def stopped_database(package, database):
    with tempfile.TemporaryDirectory() as temporary:
        local = Path(temporary) / Path(database).name
        file_bytes = 0
        for suffix in ("", "-wal"):
            remote = database + suffix
            exists = subprocess.run(["adb", "shell", "run-as", package, "test", "-f", remote], timeout=20)
            assert exists.returncode == 0 or (suffix == "-wal" and exists.returncode == 1)
            if exists.returncode == 1:
                continue
            size = int(shell("run-as", package, "stat", "-c", "%s", remote))
            data = shell("run-as", package, "cat", remote)
            assert len(data) == size, f"Short SQLite read for {suffix or 'main'}"
            local.with_name(local.name + suffix).write_bytes(data)
            file_bytes += size
        assert local.read_bytes()[:16] == b"SQLite format 3\0"
        with closing(sqlite3.connect(local.as_uri() + "?mode=ro", uri=True)) as connection:
            yield connection, file_bytes
