"""Exercise Compose offline persistence and cursor recovery against Convex."""
import http.client
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from android_test_ui import account_action, adb, click, find, nodes, shell, type_in

backend, artifact, *options = sys.argv[1:]
assert options in ([], ["--cursor-reset"])
output = Path(artifact)
app = "com.zhfahim.anchor.compose"
upstream = f"http://127.0.0.1:{backend}"
suffix = uuid.uuid4().hex[:8]
titles = [f"{name}-{suffix}" for name in ("Offline-first", "Offline-second", "Reconnect")]
rebuilding = False
hold_snapshot = threading.Event()
hold_draft = threading.Event()
sync = {"resets": 0, "resume_attempts": 0, "next_page": None}


class OfflineProxy(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def forward(self):
        is_pull = self.path == "/api/compose/sync"
        if self.path == "/api/sync/events" or self.path == "/api/compose/notes" and hold_draft.is_set():
            self.send_response(404 if self.path == "/api/sync/events" else 503)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        headers = {key: value for key, value in self.headers.items()
                   if key.lower() not in {"host", "connection", "accept-encoding"}}
        body = self.rfile.read(int(self.headers.get("Content-Length", 0))) or None
        if is_pull and rebuilding:
            request = json.loads(body)
            if sync["next_page"] is not None and request.get("cursor") == sync["next_page"]:
                sync["resume_attempts"] += 1
                if hold_snapshot.is_set():
                    self.send_response(503)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
            request["limit"] = 1
            body = json.dumps(request).encode()
            headers = {name: value for name, value in headers.items() if name.lower() != "content-length"}
            headers["Content-Length"] = str(len(body))
        connection = http.client.HTTPConnection("127.0.0.1", int(backend), timeout=15)
        try:
            connection.request(self.command, self.path, body=body, headers=headers)
            reply = connection.getresponse()
            data = reply.read()
            if is_pull and rebuilding and reply.status == 200:
                page = json.loads(data)
                if page.get("resetRequired"):
                    sync["resets"] += 1
                elif (sync["resets"] and sync["next_page"] is None and page.get("hasMore")
                      and any(entry["entityType"] == "note" for entry in page["entries"])):
                    sync["next_page"] = page["nextCursor"]
            self.send_response(reply.status)
            for name, value in reply.getheaders():
                if name.lower() not in {"connection", "transfer-encoding", "content-length"}:
                    self.send_header(name, value)
            self.send_header("Connection", "close")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            connection.close()

    do_GET = do_POST = forward


def api(path, *, payload=None, token=None, method=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(upstream + "/api/" + path, headers=headers,
                                     data=json.dumps(payload).encode() if payload is not None else None,
                                     method=method)
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.load(response)


def register(role):
    email, password = f"android-{role}-{suffix}@example.test", f"Fixture{suffix}"
    session = api("auth/register", payload={"name": f"Offline fixture {role}", "email": email, "password": password})
    return email, password, session


def start():
    shell("am", "start", "-W", "-n", app + "/anchor.AnchorActivity")


def stop():
    shell("am", "force-stop", app)


def sign_in(account):
    find("Sign in")
    for index, value in enumerate((origin, *account[:2])):
        type_in(index, value)
    shell("input", "keyevent", "4")
    click("Sign in")
    find("New note")


def compose(title):
    click("New note")
    type_in(0, title)
    type_in(1, body(title))
    shell("input", "keyevent", "4")
    click("Save note")
    find(title)


def body(title):
    return f"Body-{title}"


def read_room(query):
    # Called with the app stopped. Let SQLite replay its WAL on disposable copies.
    name = "anchor-drafts.db"
    with tempfile.TemporaryDirectory() as directory:
        database = Path(directory) / name
        database.write_bytes(adb("exec-out", "run-as", app, "cat", f"databases/{name}"))
        wal = subprocess.run(
            ["adb", "exec-out", "run-as", app, "cat", f"databases/{name}-wal"],
            capture_output=True, timeout=20,
        )
        if wal.returncode == 0:
            database.with_name(f"{name}-wal").write_bytes(wal.stdout)
        else:
            assert b"No such file" in wal.stderr + wal.stdout, wal.stderr
        with sqlite3.connect(database) as connection:
            return connection.execute(query, (origin, owner_id)).fetchall()


def queued_ids():
    return dict(read_room("SELECT title, id FROM pending_notes WHERE origin = ? AND userId = ?"))


def checkpoint():
    rows = read_room("SELECT cursor FROM note_checkpoints WHERE origin = ? AND userId = ?")
    assert len(rows) == 1 and rows[0][0], rows
    return rows[0][0]


def cached_ids():
    return dict(read_room("SELECT title, id FROM cached_notes WHERE origin = ? AND userId = ?"))


def exact_server_notes(expected):
    for _ in range(40):
        notes = api("notes", token=owner_token)
        if len(notes) == len(expected):
            break
        time.sleep(0.5)
    else:
        raise AssertionError(f"Expected {len(expected)} notes, received {len(notes)}")
    assert {note["title"]: note["id"] for note in notes} == expected, notes
    assert all(note["version"] == 1 and json.loads(note["content"]) ==
               {"ops": [{"insert": body(note["title"]) + "\n"}]} for note in notes), notes


def first_note(title, visible):
    for _ in range(10):
        listed = [node.get("text") for node in nodes() if node.get("text") in visible]
        if len(listed) == len(visible) and listed[0] == title:
            return
        time.sleep(0.25)
    raise AssertionError(f"Expected {title} first, found {listed}")


def verify_account_switch():
    other = register("other")
    other_token = other[2]["access_token"]
    start()
    sign_in(owner)
    adb("reverse", "--remove", tunnel)
    stop()
    start()
    find("New note")
    for title in titles[:2]:
        compose(title)
    assert api("notes", token=owner_token) == []

    stop()
    original_ids = queued_ids()
    assert set(original_ids) == set(titles[:2]) and len(set(original_ids.values())) == 2, original_ids
    start()
    find("Pending notes")
    for title in titles[:2]:
        find(title)
    output.with_suffix(".offline.png").write_bytes(adb("exec-out", "screencap", "-p"))
    account_action("Sign out")
    find("Sign in")

    adb("reverse", tunnel, tunnel)
    sign_in(other)
    find("No notes yet")
    assert not any(node.get("text") in (*titles, "Pending notes", "Send pending notes") for node in nodes())
    assert api("notes", token=other_token) == [] and api("notes", token=owner_token) == []
    account_action("Sign out")
    sign_in(owner)
    exact_server_notes(original_ids)
    for title in titles[:2]:
        find(title)
    stop()
    assert queued_ids() == {}
    start()
    for title in titles[:2]:
        find(title)

    adb("reverse", "--remove", tunnel)
    compose(titles[2])
    find("Pending notes")
    assert len(api("notes", token=owner_token)) == 2
    adb("reverse", tunnel, tunnel)
    for _ in range(40):
        notes = api("notes", token=owner_token)
        foreground = [note for note in notes if note["title"] == titles[2]]
        if foreground:
            break
        time.sleep(0.5)
    else:
        raise AssertionError("The foreground note did not sync on reconnect")
    assert len(foreground) == 1
    exact_server_notes(original_ids | {titles[2]: foreground[0]["id"]})

    note_id = original_ids[titles[0]]
    changed_title = f"Remote-{suffix}"
    token = api("auth/convex-token", payload={}, token=owner_token)["token"]
    reply = api("compose/sync", token=token, payload={
        "changes": [{"type": "note", "id": note_id, "title": changed_title, "baseVersion": 1}],
    })
    assert reply["results"] == [{"type": "note", "id": note_id, "status": "applied", "version": 2}], reply
    find(changed_title)
    adb("reverse", "--remove", tunnel)
    stop()
    start()
    find(changed_title)
    assert not any(node.get("text") == titles[0] for node in nodes())
    adb("reverse", tunnel, tunnel)

    visible = {changed_title, titles[1], titles[2]}
    # Editing may move the note to the top. Pin the older, unedited note.
    pinned_id = original_ids[titles[1]]
    first_note(changed_title, visible)
    for pinned, first in ((True, titles[1]), (False, changed_title)):
        token = api("auth/convex-token", payload={}, token=owner_token)["token"]
        reply = api("compose/sync", token=token, payload={
            "changes": [{"type": "pin", "id": pinned_id, "isPinned": pinned}],
        })
        assert reply["results"] == [{"type": "pin", "id": pinned_id, "status": "applied"}], reply
        first_note(first, visible)

    output.write_text(json.dumps({
        "twoQueuedNotesSurvivedOfflineRestart": True,
        "otherAccountCouldNotSeeOrSendDrafts": True,
        "originalIdsAndBodiesSyncedExactlyOnce": True,
        "outboxClearedAfterAcknowledgement": True,
        "foregroundReconnectDeliveredThirdNote": True,
        "secondSessionEditSurvivedOfflineRestart": True,
        "remotePinAndUnpinReorderedNotes": True,
        "originalNoteCount": len(original_ids),
    }, indent=2) + "\n")


def wait_for(predicate, label):
    deadline = time.monotonic() + 25
    while time.monotonic() < deadline:
        result = predicate()
        if result:
            return result
        time.sleep(0.25)
    raise AssertionError(label)


def verify_cursor_reset():
    global rebuilding
    fixture = Path(os.environ["ANCHOR_TEST_CONVEX_ENV"]).resolve(strict=True)
    assert backend == os.environ["ANCHOR_CONVEX_SITE_PORT"]
    seeds = {
        title: api("notes", token=owner_token, payload={"title": title})
        for title in (f"Removed-{suffix}", f"Retained-{suffix}", f"Second-retained-{suffix}")
    }
    removed = next(iter(seeds.values()))
    initial = {title: note["id"] for title, note in seeds.items()}
    start()
    sign_in(owner)
    for title in initial:
        find(title)

    adb("reverse", "--remove", tunnel)
    stop()
    stale = checkpoint()
    assert cached_ids() == initial
    start()
    pending = f"Draft-{suffix}"
    compose(pending)
    stop()
    drafts = queued_ids()
    assert set(drafts) == {pending}, drafts

    token = api("auth/convex-token", token=owner_token, payload={})["token"]
    request = {"cursor": stale, "attachmentOrder": True}
    api(f"notes/{removed['id']}/permanent", token=owner_token, method="DELETE")
    page = api("compose/sync", token=token, payload=request)
    assert not page.get("resetRequired")
    assert any(entry["entityId"] == removed["id"] and entry["op"] == "remove"
               for entry in page["entries"]), page
    subprocess.run([
        "node", f"--env-file={fixture}", "node_modules/convex/bin/main.js", "run",
        "notes:pruneSyncRemovals", json.dumps({"cutoff": int(time.time() * 1000)}),
    ], cwd=Path(__file__).resolve().parents[2] / "convex-backend", capture_output=True, timeout=30, check=True)
    assert api("compose/sync", token=token, payload=request)["resetRequired"] is True
    print("Convex pruned the removal and rejected the app's saved cursor.", flush=True)

    hold_snapshot.set()
    hold_draft.set()
    rebuilding = True
    adb("reverse", tunnel, tunnel)
    start()
    wait_for(lambda: sync["resume_attempts"], "Compose did not request the next snapshot page")
    stop()
    assert sync["resets"] == 1
    assert checkpoint() == sync["next_page"]
    partial = cached_ids()
    assert len(partial) == 1 and removed["id"] not in partial.values(), partial
    assert queued_ids() == drafts
    print("Room retained the first snapshot page, its continuation and the offline draft.", flush=True)

    # Edit a row already on disk to require catch-up after the snapshot pages.
    old_title, edit_id = next(iter(partial.items()))
    new_title = f"Edited-during-snapshot-{suffix}"
    reply = api("compose/sync", token=token, payload={
        "changes": [{"type": "note", "id": edit_id, "title": new_title, "baseVersion": 1}],
    })
    assert reply["results"] == [{"type": "note", "id": edit_id, "status": "applied", "version": 2}], reply
    prior_attempts = sync["resume_attempts"]
    start()
    wait_for(lambda: sync["resume_attempts"] > prior_attempts, "Restart did not resume the stored cursor")
    hold_snapshot.clear()
    expected = {title: id for title, id in initial.items() if id not in (removed["id"], edit_id)}
    expected[new_title] = edit_id
    for title in expected:
        find(title)
    find(pending)
    assert not any(node.get("text") == removed["title"] for node in nodes())
    assert {note["title"]: note["id"] for note in api("notes", token=owner_token)} == expected
    output.with_suffix(".recovered.png").write_bytes(adb("exec-out", "screencap", "-p"))

    hold_draft.clear()
    server_draft = wait_for(
        lambda: [note for note in api("notes", token=owner_token) if note["title"] == pending],
        "Pending draft did not upload after the snapshot",
    )
    assert len(server_draft) == 1 and server_draft[0]["id"] == drafts[pending]
    assert json.loads(server_draft[0]["content"]) == {"ops": [{"insert": body(pending) + "\n"}]}
    find("Pending notes sent.")
    find(pending)
    stop()
    assert queued_ids() == {}
    assert cached_ids() == expected | drafts
    assert checkpoint() not in (stale, sync["next_page"])
    assert sync["resets"] == 1
    output.write_text(json.dumps({
        "realRetentionExpiredStoredCursor": True,
        "firstPageAndCursorCommitted": True,
        "appResumedSnapshotAfterRestart": True,
        "midSnapshotEditCaughtUp": True,
        "removedNoteAbsentFromCache": True,
        "originalDraftSurvivedAndSyncedOnce": True,
        "serverResets": sync["resets"],
        "continuationRequests": sync["resume_attempts"],
    }, indent=2) + "\n")


proxy = ThreadingHTTPServer(("127.0.0.1", 0), OfflineProxy)
threading.Thread(target=proxy.serve_forever, daemon=True).start()
port = proxy.server_address[1]
origin = f"http://127.0.0.1:{port}"
tunnel = f"tcp:{port}"
owner = register("owner")
owner_token = owner[2]["access_token"]
owner_id = owner[2]["user"]["id"]
assert tunnel not in adb("reverse", "--list").decode().split()
adb("reverse", tunnel, tunnel)
try:
    if options:
        verify_cursor_reset()
    else:
        verify_account_switch()
finally:
    if tunnel in adb("reverse", "--list").decode().split():
        adb("reverse", "--remove", tunnel)
    proxy.shutdown()
    proxy.server_close()
