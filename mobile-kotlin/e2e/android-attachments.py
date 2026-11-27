import argparse
import base64
import hashlib
import http.client
import io
import json
import re
import sqlite3
import subprocess as sp
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
import wave
from contextlib import contextmanager
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit
from xml.etree import ElementTree as ET

from android_test_ui import center, click, find, type_in

app = "com.zhfahim.anchor.compose"
parser = argparse.ArgumentParser()
parser.add_argument("port", type=int)
parser.add_argument("kind", choices=("image", "audio"))
parser.add_argument("output", type=Path)
parser.add_argument("--export", action="store_true")
parser.add_argument("--share", action="store_true")
parser.add_argument("--photos", action="store_true")
parser.add_argument("--seek", action="store_true")
recovery_mode = parser.add_mutually_exclusive_group()
recovery_mode.add_argument("--restart", action="store_true")
recovery_mode.add_argument("--drop-ack", type=int, metavar="UPSTREAM_PORT")
recovery_mode.add_argument("--legacy-order", type=int, metavar="LEGACY_PORT")
args = parser.parse_args()
port, kind, output = args.port, args.kind, args.output
restart = args.restart
recover = restart or args.drop_ack is not None
origin = f"http://127.0.0.1:{port}"
serial = uuid.uuid4().hex
title = "Android-" + serial
note_id = str(uuid.uuid4())
hide_receipt = threading.Event()
committed = threading.Event()
receipts = []
requests_seen = []


class ReceiptRelay(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):
        pass

    def forward(self):
        length = int(self.headers.get("Content-Length", 0))
        parsed = urlsplit(self.path)
        fixture_upload = (self.command == "POST" and parsed.path == "/api/compose/attachments"
                          and parse_qs(parsed.query).get("noteId") == [note_id])
        if fixture_upload:
            requests_seen.append(length)
        assert 0 <= length <= 50 * 1024 * 1024
        body = self.rfile.read(length) if length else None
        headers = {name: value for name, value in self.headers.items()
                   if name.lower() in ("authorization", "content-type", "x-anchor-filename-encoded")}
        target = http.client.HTTPConnection("127.0.0.1", args.drop_ack, timeout=15)
        try:
            target.request(self.command, self.path, body, headers)
            with target.getresponse() as res:
                payload = res.read()
                if fixture_upload:
                    receipts.append(res.status)
                    if hide_receipt.is_set() and res.status in (200, 201):
                        committed.set()
                        self.send_error(503, "Fixture withheld the upload receipt")
                        return
                self.send_response(res.status)
                for name in ("Content-Type", "Cache-Control"):
                    if res.getheader(name) is not None:
                        self.send_header(name, res.getheader(name))
                self.send_header("Content-Length", str(len(payload)))
                self.send_header("Connection", "close")
                self.close_connection = True
                self.end_headers()
                self.wfile.write(payload)
        finally:
            target.close()

    do_POST = do_GET = do_DELETE = forward


relay = None
if args.drop_ack is not None:
    relay = ThreadingHTTPServer(("127.0.0.1", port), ReceiptRelay)
    threading.Thread(target=relay.serve_forever, daemon=True).start()

def register():
    email = f"android-{uuid.uuid4().hex}@example.test"
    password = uuid.uuid4().hex
    request = urllib.request.Request(
        origin + "/api/auth/register",
        data=json.dumps(dict(name="Compose Android", email=email, password=password)).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        assert response.status == 201
        return email, password


def shell(*args):
    return sp.check_output(["adb", "shell", *args])

def picker_nodes():
    shell("uiautomator", "dump", "/data/local/tmp/anchor-compose.xml")
    data = shell("cat", "/data/local/tmp/anchor-compose.xml")
    return list(ET.fromstring(data).iter("node"))

def nodes():
    return [node for node in picker_nodes() if node.get("package") == app]

def tap(node):
    left, top, right, bottom = map(int, re.findall(r"\d+", node.attrib["bounds"]))
    shell("input", "tap", str((left + right) // 2), str((top + bottom) // 2))

def button(label):
    for _ in range(8):
        node = next((node for node in nodes() if label in (node.get("text"), node.get("content-desc"))), None)
        if node is not None:
            return tap(node)
    raise AssertionError(label)

def adb(*args):
    return sp.check_output(["adb", *args])

def launch():
    shell("am", "force-stop", app)
    shell("am", "start", "-W", "-n", f"{app}/anchor.AnchorActivity")

def sign_in(login_email, login_password):
    if any(node.get("content-desc") == "Open menu" for node in nodes()):
        for label in ("Open menu", "Account menu", "Sign out"):
            button(label)
    wait_for("Sign in")
    for index, text in enumerate((origin, login_email, login_password)):
        if android_api >= 29:
            type_in(index, text)
        else:
            field = [node for node in nodes() if node.get("class") == "android.widget.EditText"][index]
            tap(field)
            shell("input", "keyevent", "123", *(["67"] * len(field.get("text") or "")))
            shell("input", "text", text)
    shell("input", "keyevent", "4")
    button("Sign in")

def wait_for(label):
    for _ in range(12):
        if any(label in (node.get("text"), node.get("content-desc")) for node in nodes()):
            return
        time.sleep(0.25)
    raise AssertionError(f"Missing label: {label}")

def post(path, payload, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    request = urllib.request.Request(origin + path, data=json.dumps(payload).encode(), headers=headers)
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.load(response)



email, password = register()
session = post("/api/auth/login", {"email": email, "password": password})

def token():
    return post("/api/auth/convex-token", {}, session["access_token"])["token"]

post("/api/compose/notes", {"id": note_id, "title": title}, token())
suffix = "wav" if kind == "audio" else "png"
filename = f"Anchor-fixture-{serial[:12]}.{suffix}"
path = "/sdcard/Download/" + filename
if kind == "audio":
    memory = io.BytesIO()
    with wave.open(memory, "wb") as wav:
        wav.setparams((1, 2, 8000, 0, "NONE", "not compressed"))
        wav.writeframes(bytes(640000 if args.seek else 320000))
    fixture = memory.getvalue()
else:
    fixture = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAAH0lEQVR4nGOQ6N5OFcQwatCoQaMGjRo0atCoQQNvEAArIQqu/dnjaAAAAABJRU5ErkJggg==")

def picker_click(label):
    for node in picker_nodes():
        if label in (node.get("text"), node.get("content-desc")):
            tap(node)
            return True
    return False

def save_picker():
    for _ in range(10):
        shown = [node for node in picker_nodes() if node.get("package") == "com.google.android.documentsui"]
        save = next((node for node in shown if (node.get("text") or "").lower() == "save"), None)
        if save is not None:
            assert any(node.get("text") == filename for node in shown), filename
            return save
    raise AssertionError("The Android save dialog did not open")

def photo_permission(action):
    for _ in range(8):
        for node in picker_nodes():
            if (node.get("resource-id") or "").endswith(f"/permission_{action}_button"):
                tap(node)
                return
    raise AssertionError(f"Android permission action unavailable: {action}")

def snapshot():
    cursor = None
    entries = []
    while True:
        page = post("/api/compose/sync", {"cursor": cursor} if cursor else {}, token())
        entries += page["entries"]
        cursor = page["nextCursor"]
        if not page["hasMore"]:
            return entries

tunnel = f"tcp:{port}"
assert tunnel not in adb("reverse", "--list").decode().split()

@contextmanager
def copied_database():
    with tempfile.TemporaryDirectory() as directory:
        database = Path(directory) / "anchor-drafts.db"
        for suffix in ("", "-wal"):
            result = sp.run(["adb", "exec-out", "run-as", app, "cat", f"databases/{database.name}{suffix}"],
                            capture_output=True, check=not suffix)
            if result.returncode == 0 and result.stdout:
                (database.parent / (database.name + suffix)).write_bytes(result.stdout)
        with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True) as db:
            yield db

def run_legacy_order():
    legacy = f"http://127.0.0.1:{args.legacy_order}/api/notes/{note_id}/attachments"
    headers = {"Authorization": "Bearer " + session["access_token"]}
    def legacy_call(method, suffix="", payload=None, content_type=None):
        request_headers = {**headers, **({"Content-Type": content_type} if content_type else {})}
        req = urllib.request.Request(legacy + suffix, method=method, data=payload, headers=request_headers)
        with urllib.request.urlopen(req, timeout=15) as result:
            return json.load(result)

    names = [f"First.{suffix}", f"Second.{suffix}"]
    ids = []
    for name in names:
        boundary = "anchor-" + uuid.uuid4().hex
        mime = "audio/wav" if kind == "audio" else "image/png"
        part = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{name}"\r\n'
                f'Content-Type: {mime}\r\n\r\n').encode()
        body = part + fixture + f"\r\n--{boundary}--\r\n".encode()
        ids.append(legacy_call("POST", payload=body, content_type=f"multipart/form-data; boundary={boundary}")["id"])

    def wait_order(expected):
        visible = []
        for _ in range(10):
            visible = [node.get("text") for node in nodes() if node.get("text") in names]
            if visible == expected:
                return
            time.sleep(0.25)
        raise AssertionError(f"Expected order {expected}, saw {visible}")

    adb("reverse", tunnel, tunnel)
    try:
        launch()
        sign_in(email, password)
        wait_for(title)
        button(title)
        wait_order(names[::-1])
        legacy_call("PATCH", "/reorder", json.dumps({"orderedIds": ids}).encode(), "application/json")
        button("Back to notes")
        button("Open menu")
        button("Sync notes")
        button(title)
        wait_order(names)
        button("Add to note")
        button("Reorder attachments")
        move_up = next(node for node in nodes() if node.get("content-desc") == f"Move {names[1]} up")
        tap(move_up)
        wait_order(names[::-1])
        button("Save order")
        wait_order(names[::-1])
        assert [row["id"] for row in legacy_call("GET")] == ids[::-1]
        launch()
        sign_in(email, password)
        wait_for(title)
        button(title)
        wait_order(names[::-1])
        shell("am", "force-stop", app)
        with copied_database() as db:
            stored = db.execute(
                "SELECT id,position FROM cached_attachments WHERE origin=? AND noteId=? ORDER BY position",
                (origin, note_id),
            ).fetchall()
            assert stored == [(ids[1], 0), (ids[0], 1)]
        output.write_text(json.dumps({"noteId": note_id, "persistedOrder": ids[::-1], "legacyReadback": True}) + "\n")
        print("Android applied a legacy reorder, then saved its own order and kept it after restart.")
    finally:
        adb("reverse", "--remove", tunnel)

if args.legacy_order is not None:
    run_legacy_order()
    raise SystemExit(0)

if args.photos or args.seek:
    upload = urllib.request.Request(
        f"{origin}/api/compose/attachments?noteId={note_id}&attachmentId={uuid.uuid4()}",
        data=fixture,
        headers={"Authorization": "Bearer " + token(), "Content-Type": "audio/wav" if kind == "audio" else "image/png",
                 "X-Anchor-Filename-Encoded": filename},
    )
    with urllib.request.urlopen(upload, timeout=15) as response:
        assert response.status == 201
else:
    with tempfile.TemporaryDirectory() as directory:
        target = Path(directory) / filename
        target.write_bytes(fixture)
        adb("push", str(target), path)
adb("reverse", tunnel, tunnel)
def dismiss_picker():
    if any(node.get("package") == "com.google.android.documentsui" for node in picker_nodes()):
        shell("input", "keyevent", "4")

def read_pending_upload():
    with copied_database() as db:
        return db.execute(
            "SELECT id, fileSize FROM pending_attachment_uploads WHERE origin=? AND noteId=?",
            (origin, note_id),
        ).fetchall(), db.execute(
            "SELECT part.bytes FROM pending_attachment_parts AS part "
            "JOIN pending_attachment_uploads AS upload ON upload.id = part.uploadId "
            "WHERE upload.origin=? AND upload.noteId=? ORDER BY part.partNumber",
            (origin, note_id),
        ).fetchall()

def wait_for_server_attachment():
    for _ in range(20):
        note = next(entry["note"] for entry in snapshot() if entry["entityId"] == note_id)
        if note.get("attachments"):
            return note["attachments"]
        time.sleep(0.5)
    raise AssertionError("The selected file was never committed by Convex")

def wait_for_uploaded_file():
    for _ in range(12):
        text = [node.get("text") for node in nodes()]
        if text.count(filename) == 1 and "Waiting to upload" not in text and "Uploading…" not in text:
            return
        time.sleep(0.25)
    raise AssertionError("The attachment did not leave the outbox")

android_api = int(shell("getprop", "ro.build.version.sdk"))
try:
    dismiss_picker()
    launch()
    sign_in(email, password)
    wait_for(title)
    button(title)
    if not (args.photos or args.seek):
        button("Add to note")
        button("Picture or audio file")
        if restart:
            adb("reverse", "--remove", tunnel)
        elif args.drop_ack is not None:
            hide_receipt.set()
        if not picker_click(filename):
            if picker_click("Show roots") or picker_click("Root-Verzeichnis anzeigen"):
                picker_click("Downloads")
            elif not picker_click("Downloads"):
                picker_click("Browse files in other apps")
                picker_click("Downloads")
            if not picker_click(filename):
                raise AssertionError([(node.get("text"), node.get("content-desc")) for node in picker_nodes()
                                      if node.get("package") == "com.google.android.documentsui"])
    queued_id = None
    if recover:
        if args.drop_ack is not None:
            assert committed.wait(25), f"Upload request sizes {requests_seen}, upstream statuses {receipts}"
        wait_for("Waiting to upload")
        shell("am", "force-stop", app)
        queued, chunks = read_pending_upload()
        [(queued_id, queued_size)] = queued
        assert queued_size == len(fixture)
        assert b"".join(data for (data,) in chunks) == fixture
        stored = next(entry["note"] for entry in snapshot() if entry["entityId"] == note_id).get("attachments", [])
        assert [file["id"] for file in stored] == ([] if restart else [queued_id])
        shell("rm", "-f", path)
        if restart:
            adb("reverse", tunnel, tunnel)
        receipt_count = len(receipts)
        other_email, other_password = register()
        launch()
        sign_in(other_email, other_password)
        wait_for("New note")
        shell("am", "force-stop", app)
        assert read_pending_upload() == (queued, chunks)
        untouched = next(entry["note"] for entry in snapshot() if entry["entityId"] == note_id).get("attachments", [])
        assert untouched == stored and len(receipts) == receipt_count
        hide_receipt.clear()
        launch()
        sign_in(email, password)
        wait_for(title)
        button(title)
    attachments = wait_for_server_attachment()
    wait_for_uploaded_file()
    file = attachments[0]
    if recover:
        assert len(attachments) == 1 and file["id"] == queued_id
    if args.drop_ack is not None:
        for _ in range(20):
            if len(receipts) > receipt_count:
                break
            time.sleep(0.5)
        assert receipts[0] == 201 and receipts[-1] == 200 and len(receipts) > receipt_count
    assert file["originalFilename"] == filename and file["fileSize"] == len(fixture)
    request = urllib.request.Request(
        f"{origin}/api/compose/attachments?noteId={note_id}&attachmentId={file['id']}",
        headers={"Authorization": "Bearer " + token()},
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        assert response.read() == fixture
    button(filename)
    wait_for("Close preview")
    if args.seek:
        find("Playback position")
        wait_for("0:00 / 0:40")
        button("Close preview")
        adb("reverse", "--remove", tunnel)
        launch()
        wait_for(title)
        button(title)
        wait_for(filename)
        button(filename)
        find("Playback position")

        def position(predicate):
            for _ in range(8):
                for node in nodes():
                    match = re.fullmatch(r"0:(\d{2}) / 0:40", node.get("text") or "")
                    if match and predicate(int(match[1])):
                        return int(match[1])
            raise AssertionError("The player did not reach the expected position")

        def seek(fraction):
            control = find("Playback position")
            left, top, right, bottom = map(int, re.findall(r"\d+", control.get("bounds")))
            shell("input", "tap", str(left + round((right - left) * fraction)), str((top + bottom) // 2))

        seek(0.5)
        paused = position(lambda seconds: 18 <= seconds <= 21)
        assert position(lambda seconds: seconds == paused) == paused
        toggle = center(find("Play"))
        shell("input", "tap", *toggle)
        time.sleep(4)
        shell("input", "tap", *toggle)
        wait_for("Play")
        resumed = position(lambda seconds: seconds >= paused + 2)
        seek(0.94)
        position(lambda seconds: 36 <= seconds <= 39)
        output.with_suffix(".preview.png").write_bytes(adb("exec-out", "screencap", "-p"))
        button("Play")
        wait_for("0:00 / 0:40")
        wait_for("Play")
        shell("am", "force-stop", app)
        with copied_database() as db:
            chunks = db.execute(
                "SELECT bytes FROM cached_attachment_parts WHERE attachmentId=? ORDER BY partNumber",
                (file["id"],),
            ).fetchall()
        assert len(chunks) > 1 and b"".join(part for part, in chunks) == fixture
        output.write_text(json.dumps({
            "audioOpenedAfterOfflineRestart": True, "pausedSeekSeconds": paused,
            "playbackAdvancedToSeconds": resumed, "completionReturnedToStart": True,
            "sha256": hashlib.sha256(fixture).hexdigest(), "cachedParts": len(chunks),
        }) + "\n")
        raise SystemExit(0)
    if kind == "audio":
        wait_for("Play")
        button("Play")
        wait_for("Pause")
        button("Pause")
        wait_for("Play")
    else:
        assert any(node.get("content-desc") == filename for node in nodes())
    if args.photos:
        gallery_path = f"/sdcard/Pictures/Anchor/{filename}"
        assert sp.run(["adb", "shell", "test", "-e", gallery_path]).returncode == 1
        wait_for("Save to Photos")
        output.with_suffix(".preview.png").write_bytes(adb("exec-out", "screencap", "-p"))
        button("Save to Photos")
        if android_api < 29:
            photo_permission("deny")
            wait_for("Allow photo access in Settings to save this image.")
            assert sp.run(["adb", "shell", "test", "-e", gallery_path]).returncode == 1
            button(filename)
            wait_for("Save to Photos")
            button("Save to Photos")
            photo_permission("allow")
        wait_for("Saved to Photos.")
        assert adb("exec-out", "cat", gallery_path) == fixture
        projection = "_display_name:mime_type"
        projection += ":relative_path:is_pending" if android_api >= 29 else ":_data"
        catalog = shell(
            "content", "query", "--uri", "content://media/external/images/media",
            "--projection", projection,
        ).decode()
        fields = ("relative_path=Pictures/Anchor/", "is_pending=0") if android_api >= 29 else (f"/Pictures/Anchor/{filename}",)
        matches = [row for row in catalog.splitlines() if f"_display_name={filename}," in row]
        photos = [row for row in matches if all(field in row for field in ("mime_type=image/png", *fields))]
        assert len(photos) == 1, matches
        output.write_text(json.dumps({
            "originalFilename": filename, "sha256": hashlib.sha256(fixture).hexdigest(),
            "publishedInPhotoLibrary": True, "preservedOriginalImageBytes": True,
            "androidApi": android_api, **({"denialLeftNoFile": True} if android_api < 29 else {}),
        }) + "\n")
        raise SystemExit(0)
    if args.share:
        wait_for("Share file")
        button("Share file")
        find("Sharing image", "headline")
        shell("input", "keyevent", "4")
        wait_for(filename)
        assert {entry["entityId"] for entry in snapshot() if entry["entityType"] == "note"} == {note_id}
        button(filename)
        wait_for("Share file")
        output.with_suffix(".preview.png").write_bytes(adb("exec-out", "screencap", "-p"))
        button("Share file")
        heading = find("Sharing image", "headline")
        _, y = map(int, center(heading))
        shell("input", "swipe", "195", str(y - 24), "195", "240", "400")
        output.with_suffix(".chooser.png").write_bytes(adb("exec-out", "screencap", "-p"))
        click("Share verifier")
        sha = hashlib.sha256(fixture).hexdigest()
        received = find(f"image/png {filename} {sha}")
        assert received.get("package") == "anchor.share.fixture"
        output.write_text(json.dumps({
            "cancelPreservedOriginalNote": True, "separateAppReceivedReadOnlyContentUri": True,
            "receivedOriginalName": filename, "receivedSha256": sha,
        }) + "\n")
        raise SystemExit(0)
    if args.export:
        shell("rm", "-f", path)
        wait_for("Download")
        output.with_suffix(".preview.png").write_bytes(adb("exec-out", "screencap", "-p"))
        button("Download")
        save_picker()
        shell("input", "keyevent", "4")
        wait_for(filename)
        assert sp.run(["adb", "shell", "test", "-e", path]).returncode == 1
        if not any("Close preview" in (node.get("text"), node.get("content-desc")) for node in nodes()):
            button(filename)
        wait_for("Download")
        button("Download")
        tap(save_picker())
        wait_for("Attachment saved.")
        assert adb("exec-out", "cat", path) == fixture
        if not any("Close preview" in (node.get("text"), node.get("content-desc")) for node in nodes()):
            button(filename)
            wait_for("Close preview")
    if args.export and kind == "image":
        shell("rm", "-f", path)
        button("Download")
        destination = save_picker()
        deletion = urllib.request.Request(request.full_url, headers=request.headers, method="DELETE")
        with urllib.request.urlopen(deletion, timeout=15) as response:
            assert json.load(response)["success"]
        tap(destination)
        wait_for("This attachment is no longer available.")
        assert sp.run(["adb", "shell", "test", "-e", path]).returncode == 1
    else:
        button("Delete attachment")
        wait_for("Delete attachment?")
        button("Delete")
    wait_for(title)
    for _ in range(12):
        if not any(filename in (node.get("text"), node.get("content-desc")) for node in nodes()):
            break
        time.sleep(0.25)
    else:
        raise AssertionError("The deleted attachment was still visible in the editor")
    if args.export and kind == "image":
        shell("am", "force-stop", app)
        with copied_database() as db:
            assert db.execute(
                "SELECT count(*) FROM cached_attachment_parts WHERE attachmentId=?", (file["id"],),
            ).fetchone() == (0,)
    if recover:
        shell("am", "force-stop", app)
        assert read_pending_upload() == ([], [])
    try:
        urllib.request.urlopen(request, timeout=15).close()
    except urllib.error.HTTPError as error:
        assert error.code == 404
    else:
        raise AssertionError("Deleted attachment was still downloadable")
    output.write_text(json.dumps({
        "noteId": note_id,
        "attachmentId": file["id"],
        "sha256": hashlib.sha256(fixture).hexdigest(),
        "preview": kind,
        "deleted": True,
        "recoveredAfterRestart": recover,
        "upstreamReceipts": receipts,
        **({"savedExactBytes": True, "cancelLeftNoFile": True, "exportName": filename} if args.export else {}),
        **({"deletionWhilePickerOpenPreventedExport": True, "deletionPurgedCachedBlocks": True}
           if args.export and kind == "image" else {}),
    }) + "\n")
    print(f"Android uploaded exact bytes, opened the {kind} preview and deleted the attachment.")
finally:
    if tunnel in adb("reverse", "--list").decode().split():
        adb("reverse", "--remove", tunnel)
    shell("rm", "-f", path)
    dismiss_picker()
    if relay is not None:
        relay.shutdown()
        relay.server_close()
