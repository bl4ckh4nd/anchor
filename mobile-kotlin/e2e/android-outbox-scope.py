"""Exercise a queued note across a same-origin change of sync scope on Android."""
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

from android_test_ui import adb, click, find, nodes, shell, sync_notes, type_in

upstream, artifact = sys.argv[1:]
app = "com.zhfahim.anchor.compose"
email = f"outbox-{uuid.uuid4().hex}@example.test"
password = f"Fixture{uuid.uuid4().hex}"
source_scope = "a" * 64
baseline_apk = os.environ.get("ANCHOR_TEST_OUTBOX_BASELINE_APK")
record_audio = os.environ.get("ANCHOR_TEST_OUTBOX_RECORDING") == "1"
current_apk = Path("androidApp/build/outputs/apk/debug/androidApp-debug.apk").resolve()
cutover = threading.Event()
offline = threading.Event()
old_attempt = threading.Event()
old_responses = []
old_writes = []
new_scopes = []
target_scopes = []
cursor_reset = threading.Event()


def read_outbox():
    # Call after force-stop, then read a disposable copy so SQLite can replay the WAL.
    with tempfile.TemporaryDirectory() as directory:
        name = "anchor-drafts.db"
        database = Path(directory) / name
        database.write_bytes(adb("exec-out", "run-as", app, "cat", f"databases/{name}"))
        wal = subprocess.run(
            ["adb", "exec-out", "run-as", app, "cat", f"databases/{name}-wal"],
            capture_output=True, timeout=20, check=False,
        )
        if wal.returncode == 0:
            database.with_name(f"{name}-wal").write_bytes(wal.stdout)
        else:
            assert b"No such file" in wal.stderr + wal.stdout, wal.stderr
        with sqlite3.connect(database) as connection:
            return tuple(connection.execute(query).fetchall() for query in (
                "SELECT title FROM pending_notes",
                "SELECT mimeType, rejected FROM pending_attachment_uploads",
                "SELECT length(bytes) FROM pending_attachment_parts",
            ))


def api(path, token=None, body=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(f"http://127.0.0.1:{upstream}/api/{path}",
                                     json.dumps(body).encode() if body else None, headers)
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.load(response)


class Relay(BaseHTTPRequestHandler):
    def forward(self):
        if self.path == "/api/sync/events" or offline.is_set():
            self.send_error(503 if offline.is_set() else 404)
            return
        length = int(self.headers.get("Content-Length", 0))
        data = self.rfile.read(length) if length else None
        if data and self.path == "/api/compose/sync" and not cutover.is_set() and target_scopes:
            request = json.loads(data)
            if cursor := request.get("cursor"):
                request["cursor"] = cursor.replace(f":@{source_scope}:", f":@{target_scopes[-1]}:")
                data = json.dumps(request).encode()
        headers = {name: value for name, value in self.headers.items()
                   if name.lower() in {"authorization", "content-type", "x-anchor-outbox-scope"}}
        connection = http.client.HTTPConnection("127.0.0.1", int(upstream), timeout=15)
        try:
            connection.request(self.command, self.path, data, headers)
            with connection.getresponse() as response:
                body = response.read()
                self.send_response(response.status)
                self.send_header("Content-Type", response.getheader("Content-Type", "application/json"))
                if scope := response.getheader("X-Anchor-Sync-Scope"):
                    target_scopes.append(scope)
                    self.send_header("X-Anchor-Sync-Scope", scope if cutover.is_set() else source_scope)
                    if not cutover.is_set():
                        page = json.loads(body)
                        page["nextCursor"] = page["nextCursor"].replace(f":@{scope}:", f":@{source_scope}:")
                        body = json.dumps(page).encode()
                if cutover.is_set() and self.path == "/api/compose/sync" and response.status == 200:
                    if json.loads(body).get("resetRequired"):
                        cursor_reset.set()
                if (
                    cutover.is_set()
                    and self.path == "/api/compose/sync"
                    and self.headers.get("X-Anchor-Outbox-Scope") == source_scope
                    and response.status == 409
                ):
                    assert "changes" not in json.loads(data)
                    old_responses.append(response.status)
                    old_attempt.set()
                if cutover.is_set() and self.path == "/api/compose/notes":
                    submitted = json.loads(data)
                    expected = self.headers.get("X-Anchor-Outbox-Scope")
                    if submitted["title"] == "Pending-before-cutover":
                        old_writes.append((expected, response.status))
                        old_attempt.set()
                    else:
                        new_scopes.append(expected)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
        finally:
            connection.close()

    do_GET = do_POST = forward

    def log_message(self, *_):
        pass


token = api("auth/register", body={"name": "Outbox fixture", "email": email, "password": password})["access_token"]
api("notes", token, {"title": "Initial library"})
with ThreadingHTTPServer(("127.0.0.1", 0), Relay) as relay:
    threading.Thread(target=relay.serve_forever, daemon=True).start()
    tunnel = f"tcp:{relay.server_port}"
    adb("reverse", tunnel, tunnel)
    try:
        if baseline_apk:
            adb("install", "-r", baseline_apk)
            shell("pm", "clear", app)
        shell("am", "start", "-W", "-n", f"{app}/anchor.AnchorActivity")
        find("Sign in")
        for index, value in enumerate((f"http://127.0.0.1:{relay.server_port}", email, password)):
            type_in(index, value)
        shell("input", "keyevent", "4")
        click("Sign in")
        find("Initial library")

        def create(title, *, recording=False):
            click("New note")
            type_in(0, title)
            shell("input", "keyevent", "4")
            if recording:
                click("Add to note")
                click("While using the app")
                find("Stop recording")
                time.sleep(2)
                click("Stop recording")
                click("Save note with recording")
            else:
                click("Save note")

        offline.set()
        create("Pending-before-cutover", recording=record_audio)
        find("Pending notes")
        assert {note["title"] for note in api("notes", token)} == {"Initial library"}
        shell("am", "force-stop", app)
        if record_audio:
            drafts, uploads, parts = read_outbox()
            assert drafts == [("Pending-before-cutover",)]
            assert uploads == [("audio/mp4", 0)] and parts and all(size > 0 for size, in parts)
        if baseline_apk:
            adb("install", "-r", str(current_apk))
        cutover.set()
        offline.clear()
        shell("am", "start", "-W", "-n", f"{app}/anchor.AnchorActivity")
        assert old_attempt.wait(35), "The old queued note was not attempted"
        assert not old_writes, old_writes
        assert old_responses and set(old_responses) == {409}, old_responses
        find("Pending-before-cutover (needs review)")
        assert {note["title"] for note in api("notes", token)} == {"Initial library"}
        sync_notes()
        assert cursor_reset.wait(15), "Convex did not reset the previous cursor"
        find("Initial library")
        create("Created-after-cutover")
        find("Saved: Created-after-cutover")
        assert {note["title"] for note in api("notes", token)} == {"Initial library", "Created-after-cutover"}
        assert new_scopes and all(scope and scope != source_scope for scope in new_scopes), new_scopes
        find("Pending-before-cutover (needs review)")
        evidence = Path(artifact)
        evidence.with_suffix(".png").write_bytes(adb("exec-out", "screencap", "-p"))
        if record_audio:
            click("Pending-before-cutover (needs review)")
            click("Discard draft")
            find("Discard this local draft?")
            click("Keep draft")
            find("Draft needs review")
            click("Discard draft")
            find("Discard this local draft?")
            click("Discard draft")
            for _ in range(8):
                if not any((item.get("text") or "").startswith(("Pending-before-cutover", "Discard")) for item in nodes()):
                    break
            else:
                raise AssertionError("The draft was not discarded")
            shell("am", "force-stop", app)
            remaining = read_outbox()
            assert remaining == ([], [], []), f"Discard left durable outbox rows: {remaining}"
            assert {note["title"] for note in api("notes", token)} == {"Initial library", "Created-after-cutover"}
        evidence.write_text(json.dumps({
            "offlineDraftRetained": True, "oldScopeSurvivedRestart": True,
            "otherScopeRejectedBeforeDraftBodyWasSent": True, "newScopeCanSync": True,
            "oldCursorResetByServer": True, "room25Upgrade": bool(baseline_apk),
            **({"discardRemovedRecordingAndChunks": True} if record_audio else {}),
        }, indent=2) + "\n")
    finally:
        adb("reverse", "--remove", tunnel)
        relay.shutdown()
