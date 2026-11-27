"""Exercise the Flutter-to-Compose Android update with APKs signed by a disposable key."""
import argparse
import hashlib
import http.client
import io
import json
import re
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from android_test_ui import adb, center, nodes, shell
from benchmark_fixture import stopped_database


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("port", type=int)
parser.add_argument("flutter_apk")
parser.add_argument("compose_apk")
parser.add_argument("output", type=Path)
parser.add_argument("--bridge-apk", help="Install this Flutter exporter update before installing Compose.")
parser.add_argument("--skip-export", action="store_true", help="Check how Compose handles a skipped Flutter export.")
parser.add_argument("--check-widget", action="store_true", help="Check the original widget in Pixel Launcher.")
parser.add_argument("--check-share", action="store_true", help="Check native offline text shares on both apps.")
parser.add_argument("--check-existing", action="store_true", help="Check an offline edit to an existing formatted note.")
parser.add_argument("--check-trash-attachment", action="store_true", help="Restore an offline draft from trash before its attachment can upload.")
args = parser.parse_args()
if args.skip_export and (args.bridge_apk or args.check_widget or args.check_share or args.check_trash_attachment):
    parser.error("--skip-export runs the direct upgrade scenario")
port = args.port
package = "com.zhfahim.anchor.debug"
origin = f"http://127.0.0.1:{port}"
tunnel = f"tcp:{port}"
suffix = uuid.uuid4().hex
email = f"upgrade-{suffix}@example.test"
password = f"Fixture{suffix}"
title = "Offline-upgrade-fixture"
trash_title = "Offline-trash-fixture"
trash_id = str(uuid.uuid4())
widget_title = "Widget-upgrade-fixture"
existing_title = "RichFixture"
edited_title = existing_title + "Offline"
existing_id = str(uuid.uuid4())
existing_delta = {"ops": [
    {"insert": "Existing formatted note", "attributes": {"bold": True}},
    {"insert": "\n", "attributes": {"header": 2}},
    {"insert": "Existing checklist item"},
    {"insert": "\n", "attributes": {"list": "checked"}},
]}
legacy_share_title = "Flutter-share-fixture"
legacy_share_text = "https://example.test/flutter-share"
compose_share_title = "Compose-share-fixture"
compose_share_text = "Compose-offline-share"
filename = "Upgrade.wav"
writes_blocked = threading.Event()


def api(path, body=None, token=None):
    headers = {"Content-Type": "application/json", "X-Anchor-Protocol": "4"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(
        f"{origin}/api/{path}", json.dumps(body).encode() if body is not None else None, headers,
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)


class Gateway(BaseHTTPRequestHandler):
    def forward(self):
        if self.path == "/api/sync/events":
            self.send_error(404)
            return
        data = self.rfile.read(int(self.headers.get("Content-Length", 0))) or None
        if writes_blocked.is_set() and self.command == "POST" and (
            self.path == "/api/compose/notes"
            or self.path.startswith("/api/compose/attachments?")
            or (self.path == "/api/compose/sync" and data and json.loads(data).get("changes"))
        ):
            self.send_error(503)
            return
        skip = {"host", "connection", "transfer-encoding", "content-length", "accept-encoding"}
        headers = {name: value for name, value in self.headers.items() if name.lower() not in skip}
        upstream = http.client.HTTPConnection("127.0.0.1", int(port), timeout=15)
        try:
            upstream.request(self.command, self.path, body=data, headers=headers)
            response = upstream.getresponse()
            payload = response.read()
            self.send_response(response.status)
            for name, value in response.getheaders():
                if name.lower() not in skip:
                    self.send_header(name, value)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            upstream.close()

    do_GET = forward
    do_POST = forward

    def log_message(self, *_):
        pass


def find(label, seconds=20, clickable=False, resource=None):
    limit = time.monotonic() + seconds
    while time.monotonic() < limit:
        for node in nodes():
            if clickable and node.get("clickable") != "true":
                continue
            if resource and not node.get("resource-id", "").endswith("/" + resource):
                continue
            for attr in ("text", "content-desc"):
                value = node.get(attr, "")
                if value == label or value.startswith((label + "\n", label + ", ", label + ". ")):
                    return node
    raise AssertionError(f"Missing Android label {label}")


def tap(label, seconds=20, *, clickable=True):
    shell("input", "tap", *center(find(label, seconds, clickable=clickable)))


def fields():
    return [node for node in nodes() if node.get("class") == "android.widget.EditText"
            and not any(child.get("class") == "android.widget.EditText" for child in node.iter("node") if child is not node)]


def enter(index, value):
    for _ in range(3):
        shell("input", "tap", *center(fields()[index]))
        assert fields()[index].get("focused") == "true"
        shell("input", "keycombination", "113", "29")
        shell("input", "text", value)
        field = fields()[index]
        if field.get("text") == value or (field.get("password") == "true" and len(field.get("text", "")) == len(value)):
            return
    raise AssertionError(f"Could not populate Android field {index + 1}")


def stop():
    shell("am", "force-stop", package)


def launch_flutter():
    shell("am", "start", "-W", "-n", f"{package}/com.zhfahim.anchor.MainActivity",
          "--ez", "enable-impeller", "false", "--ez", "enable-software-rendering", "true")


def sign_in_compose(gateway):
    writes_blocked.set()
    connect(gateway)
    shell("am", "start", "-W", "-n", f"{package}/anchor.AnchorActivity")
    find("Sign in")
    for index, value in enumerate((origin, email, password)):
        enter(index, value)
    shell("input", "keyevent", "4")
    shell("input", "tap", *center(find("Sign in")))


def share_text(title, text):
    result = shell("am", "start", "-W", "-a", "android.intent.action.SEND", "-t", "text/plain",
                   "-p", package, "--es", "android.intent.extra.SUBJECT", title,
                   "--es", "android.intent.extra.TEXT", text, "--ez", "enable-impeller", "false",
                   "--ez", "enable-software-rendering", "true").decode()
    assert "Status: ok" in result, result


def flutter_draft(audio):
    with stopped_database(package, f"app_flutter/db_{user}.sqlite") as (database, _):
        note_id, state, version = database.execute(
            "SELECT id, state, version FROM notes WHERE title = ? AND is_synced = 0", (title,),
        ).fetchone()
        if args.check_trash_attachment:
            assert (state, version) == ("trashed", None)
        attachment_id, local_path = database.execute(
            "SELECT id, local_path FROM note_attachments WHERE note_id = ? AND sync_status = 'pending_upload'",
            (note_id,),
        ).fetchone()
        assert database.execute("SELECT state, is_synced FROM notes WHERE id = ?", (trash_id,)).fetchone() == (
            "trashed", 0,
        )
    assert adb("exec-out", "run-as", package, "cat", local_path) == audio
    return note_id, attachment_id


def check_flutter_edit():
    with stopped_database(package, f"app_flutter/db_{user}.sqlite") as (database, _):
        edited, data, version, synced = database.execute(
            "SELECT title, content, version, is_synced FROM notes WHERE id = ?", (existing_id,),
        ).fetchone()
    assert (edited, version, synced) == (edited_title, 1, 0)
    assert json.loads(data) == existing_delta


def flutter_database_digests():
    # Read the original files only after stopping the app. WAL replay in the
    # fixture takes place in a separate copy, so these are on-device hashes.
    database = f"app_flutter/db_{user}.sqlite"
    digests = {}
    for suffix in ("", "-wal"):
        path = database + suffix
        exists = subprocess.run(["adb", "shell", "run-as", package, "test", "-f", path], timeout=20)
        if suffix and exists.returncode == 1:
            continue
        exists.check_returncode()
        payload = adb("exec-out", "run-as", package, "cat", path)
        digests["wal" if suffix else "database"] = hashlib.sha256(payload).hexdigest()
    return digests


def connect(gateway):
    adb("reverse", tunnel, f"tcp:{gateway.server_port}")


def audio_fixture():
    content = io.BytesIO()
    with wave.open(content, "wb") as wav:
        wav.setparams((1, 2, 8000, 0, "NONE", "not compressed"))
        wav.writeframes(bytes(16000))
    data = content.getvalue()
    with tempfile.TemporaryDirectory() as directory:
        local = Path(directory, filename)
        local.write_bytes(data)
        adb("push", str(local), f"/sdcard/Download/{filename}")
    return data


def widget_id():
    component = f"{package}/com.zhfahim.anchor.widget.NotesWidgetProvider"
    state = shell("dumpsys", "appwidget").decode()
    widgets = re.split(r"(?m)^\s*\[\d+\] id=(\d+)[^\n]*\n", state)
    matches = [number for number, details in zip(widgets[1::2], widgets[2::2]) if component in details]
    assert len(matches) == 1, f"Expected one bound Anchor widget, found {matches}\n{state}"
    return int(matches[0])


def pick_flutter_widget():
    shell("input", "keyevent", "HOME")
    shell("wm", "size", "720x2160")
    try:
        find("Home")
        shell("input", "swipe", "615", "1200", "615", "1200", "900")
        for label in ("Widgets", "Anchor Notes",
                      "Notes widget, 3 wide by 3 high See your notes and start a new one from the home screen.",
                      "Add Notes widget"):
            shell("input", "tap", *center(find(label)))
        find(widget_title, 35, resource="item_title")
        found = widget_id()
        args.output.with_name(args.output.stem + "-flutter.png").write_bytes(adb("exec-out", "screencap", "-p"))
        return found
    finally:
        shell("wm", "size", "390x1400")


account = api("auth/register", {"name": "Upgrade fixture", "email": email, "password": password})
token, user = account["access_token"], account["user"]["id"]
convex_token = api("auth/convex-token", {}, token)["token"]
api("compose/notes", {"id": trash_id, "title": trash_title}, convex_token)
if args.check_widget:
    api("compose/notes", {"id": str(uuid.uuid4()), "title": widget_title}, convex_token)
if args.check_existing:
    existing = api("compose/notes", {
        "id": existing_id, "title": existing_title, "content": json.dumps(existing_delta),
    }, convex_token)
    assert existing["version"] == 1
account_key = hashlib.sha256(f"{origin}\0{user}".encode()).hexdigest()
selection = f"files/legacy-upgrade/{account_key}.current"

with ThreadingHTTPServer(("127.0.0.1", 0), Gateway) as gateway:
    threading.Thread(target=gateway.serve_forever, daemon=True).start()
    connect(gateway)
    try:
        adb("install", args.flutter_apk)
        launch_flutter()
        find("Welcome to Anchor", 35)
        enter(0, origin)
        shell("input", "keyevent", "4")
        tap("Continue")
        find("Sign in", 35)
        enter(0, email)
        enter(1, password)
        shell("input", "keyevent", "4")
        tap("Sign in")
        find(trash_title, 35, clickable=True)
        if args.check_widget:
            find(widget_title, 35, clickable=True)
            original_widget = pick_flutter_widget()
            launch_flutter()
            find(trash_title, 35, clickable=True)
        audio = audio_fixture()
        adb("reverse", "--remove", tunnel)
        if args.check_existing:
            tap(existing_title)
            field = fields()[0]
            assert field.get("text") == existing_title, field.attrib
            left, top, right, bottom = map(int, re.findall(r"\d+", field.get("bounds")))
            assert right - left > 100
            shell("input", "tap", str(right - 12), str((top + bottom) // 2))
            shell("input", "keyevent", "123")
            shell("input", "text", "Offline")
            assert fields()[0].get("text") == edited_title, fields()[0].attrib
            tap("Back")
            find(edited_title, clickable=True)
        tap(trash_title)
        tap("More")
        tap("Move to trash")
        find("New note")
        tap("New note")
        tap("Picture or audio")
        tap("Audio file")
        try:
            selected_file = find(filename, 4)
        except AssertionError:
            shell("input", "tap", *center(find("Show roots")))
            shell("input", "tap", *center(find("Downloads")))
            selected_file = find(filename)
        shell("input", "tap", *center(selected_file))
        find("Add picture or audio")
        enter(0, title)
        tap("Back")
        find(title, clickable=True)
        if args.check_trash_attachment:
            tap(title)
            tap("More")
            tap("Move to trash")
            find("New note")
        if args.check_share:
            share_text(legacy_share_title, legacy_share_text)
            tap("Save", 35)
            find(legacy_share_title, 35, clickable=True)
        print("Flutter shows the offline draft.", flush=True)

        if args.skip_export:
            stop()
            original_draft = flutter_draft(audio)
            if args.check_existing:
                check_flutter_edit()
            before_digests = flutter_database_digests()
            shell("run-as", package, "test", "!", "-e", selection)
            adb("install", "-r", args.compose_apk)
            sign_in_compose(gateway)
            writes_blocked.clear()
            warning_text = (
                "Local data from Flutter is still on this device. To import it, prepare a Compose upgrade "
                "in the previous app for this account and server."
            )
            warning = find(warning_text, 35)
            find(trash_title, 35)
            adb("reverse", "--remove", tunnel)
            stop()
            shell("am", "start", "-W", "-n", f"{package}/anchor.AnchorActivity")
            find(warning_text, 35)
            find(trash_title, 35)
            args.output.with_suffix(".png").write_bytes(adb("exec-out", "screencap", "-p"))
            stop()
            after_digests = flutter_database_digests()
            assert after_digests == before_digests
            assert flutter_draft(audio) == original_draft
            if args.check_existing:
                check_flutter_edit()
                unchanged = api(f"notes/{existing_id}", token=token)
                assert unchanged["title"] == existing_title and unchanged["version"] == 1
                assert json.loads(unchanged["content"]) == existing_delta
            assert any(note["id"] == trash_id for note in api("notes", token=token))
            assert all(note["id"] != original_draft[0] for note in api("notes", token=token))
            with stopped_database(package, "databases/anchor-drafts.db") as (database, _):
                assert database.execute("SELECT count(*) FROM legacy_upgrade_imports").fetchone() == (0,)
                assert database.execute("SELECT count(*) FROM pending_notes").fetchone() == (0,)
                assert database.execute("SELECT count(*) FROM pending_attachment_uploads").fetchone() == (0,)
            args.output.write_text(json.dumps({
                "androidUpdatedInPlace": True,
                "missingExportWarning": warning.get("text"),
                "legacyDraftAndAttachmentRetained": True,
                "legacyTrashRetained": True,
                "nothingImportedIntoRoom": True,
                "normalServerNotesAvailable": True,
                "offlineRestartKeptWarningAndServerCache": True,
                "offlinePendingChangesAbsentFromConvex": True,
                "flutterDatabaseDigestsBefore": before_digests,
                "flutterDatabaseDigestsAfter": after_digests,
                **({"existingOfflineEditRetainedWithoutServerWrite": True} if args.check_existing else {}),
            }, indent=2) + "\n")
            raise SystemExit(0)

        if args.bridge_apk:
            stop()
            original_draft = flutter_draft(audio)
            if args.check_existing:
                check_flutter_edit()
            adb("install", "-r", args.bridge_apk)
            if args.check_widget:
                assert widget_id() == original_widget
            assert flutter_draft(audio) == original_draft
            if args.check_existing:
                check_flutter_edit()
            launch_flutter()
            if args.check_trash_attachment:
                find("New note", 35)
            else:
                find(title, 35, clickable=True)
            print("The Flutter exporter update retained the offline draft, attachment and trash.", flush=True)

        tap("Notes")
        tap("Upgrade fixture, Settings")
        for _ in range(5):
            try:
                tap("Prepare Compose upgrade", 3)
                break
            except AssertionError:
                shell("input", "swipe", "190", "1100", "190", "410", "350")
        else:
            raise AssertionError("The installed Flutter APK did not expose the upgrade exporter")
        tap("Prepare Compose upgrade")
        find("The local backup is ready. Install the Compose update before making more changes in Flutter.", 35)
        stop()
        generation = shell("run-as", package, "cat", selection).decode()
        assert len(generation) == 32 and all(char in "0123456789abcdef" for char in generation)
        bundle = f"files/legacy-upgrade/{account_key}.{generation}"
        note_id, attachment_id = flutter_draft(audio)
        if args.check_share:
            with stopped_database(package, f"app_flutter/db_{user}.sqlite") as (database, _):
                legacy_share_id, legacy_delta = database.execute(
                    "SELECT id, content FROM notes WHERE title = ? AND is_synced = 0", (legacy_share_title,),
                ).fetchone()
                assert any(op.get("attributes", {}).get("link") == legacy_share_text
                           for op in json.loads(legacy_delta)["ops"])
        if args.bridge_apk:
            assert (note_id, attachment_id) == original_draft
        if args.check_existing:
            check_flutter_edit()
            before_edit = api(f"notes/{existing_id}", token=token)
            assert before_edit["title"] == existing_title and before_edit["version"] == 1
            assert json.loads(before_edit["content"]) == existing_delta
        assert any(note["id"] == trash_id for note in api("notes", token=token))
        before = adb("exec-out", "run-as", package, "cat", f"{bundle}/manifest.json")
        assert before and json.loads(before)
        try:
            api(f"notes/{note_id}", token=token)
        except urllib.error.HTTPError as error:
            assert error.code == 404
        else:
            raise AssertionError("Flutter's offline draft was already on the server")
        print("The exported Flutter draft is absent from Convex.", flush=True)

        adb("install", "-r", args.compose_apk)
        if args.check_widget:
            assert widget_id() == original_widget
        assert adb("exec-out", "run-as", package, "cat", f"{bundle}/manifest.json") == before
        sign_in_compose(gateway)
        find("Pending notes", 35)
        find(title)
        if args.check_share:
            share_text(compose_share_title, compose_share_text)
            find(compose_share_title, 35)
            shell("input", "tap", *center(find("Save note")))
            find("Shared note saved on this device.", 35)
        stop()
        with stopped_database(package, "databases/anchor-drafts.db") as (database, _):
            assert database.execute("SELECT id FROM pending_notes WHERE title = ?", (title,)).fetchall() == [(note_id,)]
            fields, base = database.execute("SELECT flutterFields, baseVersion FROM pending_notes WHERE id = ?", (trash_id,)).fetchone()
            assert json.loads(fields)["state"] == "trashed" and base > 0
            if args.check_existing:
                queued_title, queued_delta, queued_base = database.execute(
                    "SELECT title, deltaContent, baseVersion FROM pending_notes WHERE id = ? AND rejected = 0",
                    (existing_id,),
                ).fetchone()
                assert (queued_title, queued_base) == (edited_title, 1)
                assert json.loads(queued_delta) == existing_delta
            assert database.execute(
                "SELECT id, noteId, filename, fileSize FROM pending_attachment_uploads",
            ).fetchall() == [(attachment_id, note_id, filename, len(audio))]
            parts = database.execute(
                "SELECT bytes FROM pending_attachment_parts WHERE uploadId = ? ORDER BY partNumber", (attachment_id,),
            )
            assert b"".join(part[0] for part in parts) == audio
            if args.check_trash_attachment:
                fields, base = database.execute(
                    "SELECT flutterFields, baseVersion FROM pending_notes WHERE id = ?", (note_id,),
                ).fetchone()
                assert json.loads(fields)["state"] == "trashed" and base is None
                assert database.execute(
                    "SELECT deferUntilRestored, rejected FROM pending_attachment_uploads WHERE id = ?", (attachment_id,),
                ).fetchone() == (1, 0)
            if args.check_share:
                assert database.execute("SELECT id, deltaContent FROM pending_notes WHERE title = ?",
                                        (legacy_share_title,)).fetchall() == [(legacy_share_id, legacy_delta)]
                compose_share_id, = database.execute("SELECT id FROM pending_notes WHERE title = ?",
                                                     (compose_share_title,)).fetchone()
        print("Room retained the note IDs, the trash change and the attachment bytes.", flush=True)

        adb("reverse", "--remove", tunnel)
        adb("reverse", tunnel, tunnel)
        shell("am", "start", "-W", "-n", f"{package}/anchor.AnchorActivity")
        convex_token = api("auth/convex-token", {}, token)["token"]
        deadline = time.monotonic() + 45
        note_received = False
        files = []
        trashed = False
        while time.monotonic() < deadline:
            try:
                saved = api(f"notes/{note_id}", token=token)
                assert saved["id"] == note_id and saved["title"] == title
                note_received = True
                files = api(f"compose/attachments/list?noteId={note_id}", token=convex_token)
                trashed = any(note["id"] == trash_id for note in api("notes/trash", token=token))
                if trashed and (files or args.check_trash_attachment):
                    break
            except urllib.error.HTTPError as error:
                assert error.code == 404
            time.sleep(0.5)
        else:
            stop()
            with stopped_database(package, "databases/anchor-drafts.db") as (database, _):
                queued_uploads = database.execute("SELECT rejected FROM pending_attachment_uploads").fetchall()
                queued_notes = database.execute("SELECT rejected FROM pending_notes").fetchall()
            raise AssertionError(
                f"Convex readback: note={note_received}, attachments={len(files)}, moved to trash={trashed}; "
                f"Room rejection flags: notes={queued_notes}, uploads={queued_uploads}"
            )
        if args.check_trash_attachment:
            assert saved["state"] == "trashed" and files == []
            tap("Trash", 35, clickable=False)
            tap(title, 35, clickable=False)
            find("Restore", 35)
            stop()
            with stopped_database(package, "databases/anchor-drafts.db") as (database, _):
                assert database.execute("SELECT isTrashed FROM cached_notes WHERE id = ?", (note_id,)).fetchone() == (1,)
                assert database.execute("SELECT id FROM pending_notes WHERE id = ?", (note_id,)).fetchall() == []
                assert database.execute(
                    "SELECT deferUntilRestored, rejected FROM pending_attachment_uploads WHERE id = ?", (attachment_id,),
                ).fetchone() == (1, 0)
            shell("am", "start", "-W", "-n", f"{package}/anchor.AnchorActivity")
            tap("Trash", 35, clickable=False)
            tap(title, 35, clickable=False)
            assert api(f"compose/attachments/list?noteId={note_id}", token=convex_token) == []
            print("The attachment remained queued through a Compose restart while the note was in trash.", flush=True)
            tap("Restore", 35, clickable=False)
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline:
                saved = api(f"notes/{note_id}", token=token)
                files = api(f"compose/attachments/list?noteId={note_id}", token=convex_token)
                if saved["state"] == "active" and files:
                    break
                time.sleep(0.5)
            else:
                raise AssertionError("The device did not upload the attachment after restoring the note")
            print("Restoring the note on the device released its original upload.", flush=True)
        file, = files
        assert (file["id"], file["originalFilename"], file["fileSize"]) == (attachment_id, filename, len(audio))
        request = urllib.request.Request(
            f"{origin}/api/compose/attachments?noteId={note_id}&attachmentId={attachment_id}",
            headers={"Authorization": f"Bearer {convex_token}"},
        )
        with urllib.request.urlopen(request, timeout=20) as response:
            assert response.read() == audio
        assert all(note["id"] != trash_id for note in api("notes", token=token))
        if args.check_existing:
            deadline = time.monotonic() + 25
            while time.monotonic() < deadline:
                migrated = api(f"notes/{existing_id}", token=token)
                if migrated["title"] == edited_title:
                    break
                time.sleep(0.5)
            else:
                raise AssertionError("The offline edit of the existing note did not sync")
            assert migrated["id"] == existing_id and migrated["version"] == 2
            assert json.loads(migrated["content"]) == existing_delta
        if args.check_share:
            deadline = time.monotonic() + 35
            while time.monotonic() < deadline:
                notes = api("notes", token=token)
                if all(any(note["id"] == expected for note in notes) for expected in (legacy_share_id, compose_share_id)):
                    break
                time.sleep(0.5)
            else:
                raise AssertionError("Native shares did not reach Convex")
            legacy_note, = [note for note in notes if note["title"] == legacy_share_title]
            compose_note, = [note for note in notes if note["title"] == compose_share_title]
            assert legacy_note["id"] == legacy_share_id and legacy_note["content"] == legacy_delta
            assert compose_note["id"] == compose_share_id
            assert compose_share_text in "".join(op.get("insert", "") for op in json.loads(compose_note["content"])["ops"])
        if args.check_widget:
            find(widget_title, 35)
            shell("input", "keyevent", "HOME")
            shell("wm", "size", "720x2160")
            try:
                row = find(widget_title, 35, resource="item_title")
                assert widget_id() == original_widget
                args.output.with_name(args.output.stem + "-compose.png").write_bytes(adb("exec-out", "screencap", "-p"))
                shell("input", "tap", *center(row))
                find("Edit note", 35)
                find(widget_title, 35)
            finally:
                shell("wm", "size", "390x1400")
        results = {
            "androidUpdatedInPlace": True,
            "privateFlutterBundleRetained": True,
            "offlineDraftAbsentBeforeUpgrade": True,
            "roomRetainedOriginalPendingNoteId": True,
            "convexReadbackRetainedOriginalNoteId": True,
            "offlineAttachmentRetainedIdAndBytes": True,
            "offlineTrashReachedConvex": True,
        }
        if args.bridge_apk:
            results["flutterExporterUpdateRetainedOfflineData"] = True
        if args.check_widget:
            results["originalWidgetRetainedAndOpenedNote"] = True
            results["originalWidgetId"] = original_widget
        if args.check_share:
            results["flutterSharedLinkAndComposeSharedTextSyncedOnce"] = True
        if args.check_existing:
            results["existingOfflineEditRetainedNoteIdBaseVersionAndRichDelta"] = True
        if args.check_trash_attachment:
            results["offlineAttachmentWaitedThroughRestartForRestore"] = True
            results["attachmentSha256AfterRestore"] = hashlib.sha256(audio).hexdigest()
        args.output.write_text(json.dumps(results, indent=2) + "\n")
    finally:
        subprocess.run(["adb", "reverse", "--remove", tunnel], capture_output=True, timeout=10)
        gateway.shutdown()
