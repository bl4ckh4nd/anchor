"""Verify that Compose copies an active note through the Anchor API."""
import hashlib
import http.client
import io
import json
import sys
import threading
import urllib.request
import uuid
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from android_test_ui import adb, click, find, shell, type_in
from benchmark_fixture import stopped_database

port, artifact = sys.argv[1:]
origin = f"http://127.0.0.1:{int(port)}"
tunnel = f"tcp:{port}"
package = "com.zhfahim.anchor.compose"
email = f"copy-{uuid.uuid4().hex}@example.test"
password = f"Fixture{uuid.uuid4().hex}"
title = "Copy fixture note"
hold_changes = threading.Event()
duplicates = []
undos = []


class Gateway(BaseHTTPRequestHandler):
    def forward(self):
        if self.path == "/api/sync/events":
            self.send_error(404)
            return
        data = self.rfile.read(int(self.headers.get("Content-Length", 0))) or None
        path = urlsplit(self.path).path
        if path.endswith("/duplicate") and self.command == "POST":
            duplicates.append(path)
        if path.endswith("/duplicate/undo") and self.command == "POST":
            undos.append(path)
        if hold_changes.is_set() and self.path == "/api/compose/sync" and data and json.loads(data).get("changes"):
            self.send_error(503)
            return
        headers = {name: value for name, value in self.headers.items()
                   if name.lower() in ("authorization", "content-type", "x-anchor-protocol")}
        upstream = http.client.HTTPConnection("127.0.0.1", int(port), timeout=20)
        try:
            upstream.request(self.command, self.path, data, headers)
            with upstream.getresponse() as response:
                body = response.read()
                self.send_response(response.status)
                if content_type := response.getheader("Content-Type"):
                    self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
        finally:
            upstream.close()

    do_GET = forward
    do_POST = forward

    def log_message(self, *_):
        pass


def api(path, method="GET", data=None, expected=200, token=None, content_type="application/json"):
    headers = {"Content-Type": content_type, "X-Anchor-Protocol": "4"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if data is not None and content_type == "application/json":
        data = json.dumps(data).encode()
    request = urllib.request.Request(origin + "/api/" + path, data, headers, method=method)
    with urllib.request.urlopen(request, timeout=20) as response:
        assert response.status == expected, (path, response.status, expected)
        if response.headers.get("Content-Type", "").startswith("application/json"):
            return json.load(response)
        return response.read()


account = api("auth/register", "POST", {"name": "Copy fixture", "email": email, "password": password}, 201)
token = account["access_token"]
tag = api("tags", "POST", {"name": "Copy label"}, 201, token)
delta = {"ops": [{"insert": "Formatted copy", "attributes": {"bold": True, "unknown-mark": "keep"}}, {"insert": "\n"}]}
source = api("notes", "POST", {
    "title": title, "content": json.dumps(delta), "tagIds": [tag["id"]],
}, 201, token)
source_path = "notes/" + source["id"]
payload = io.BytesIO()
with wave.open(payload, "wb") as audio:
    audio.setparams((1, 2, 8000, 0, "NONE", "not compressed"))
    audio.writeframes(bytes(1600))
file_bytes = payload.getvalue()
boundary = "anchor-test-" + uuid.uuid4().hex
file = api(source_path + "/attachments", "POST",
           (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="Copy.wav"\r\n'
            "Content-Type: audio/wav\r\n\r\n").encode() + file_bytes + f"\r\n--{boundary}--\r\n".encode(),
           201, token, f"multipart/form-data; boundary={boundary}")
source_version = api(source_path, token=token)["version"]

assert tunnel not in adb("reverse", "--list").decode().split()
gateway = ThreadingHTTPServer(("127.0.0.1", 0), Gateway)
threading.Thread(target=gateway.serve_forever, daemon=True).start()
adb("reverse", tunnel, f"tcp:{gateway.server_port}")
try:
    shell("am", "start", "-W", "-n", f"{package}/anchor.AnchorActivity")
    find("Sign in")
    for index, value in enumerate((origin, email, password)):
        type_in(index, value)
    shell("input", "keyevent", "4")
    click("Sign in")
    click(title)
    click("More actions")
    click("Make a copy")
    shell("input", "swipe", "190", "300", "190", "1100", "450")
    find("Note copied.")
    first_copy, = [note for note in api("notes", token=token) if note["id"] != source["id"]]
    click("Undo")
    find("Copy undone.")
    assert [note["id"] for note in api("notes", token=token)] == [source["id"]]
    click("More actions")
    click("Make a copy")
    find("Note copied.")
    # The copy is open; Undo is still offered after the edit is saved on the device.
    type_in(0, "Offline-edited-copy")
    shell("input", "keyevent", "4")
    hold_changes.set()
    click("Save changes")
    find("Saved on device")
    click("Undo")
    find("The copy has local changes. Keep it or discard those changes before undoing.")
    copies = [note for note in api("notes", token=token) if note["id"] != source["id"]]
    copied, = copies
    copied_path = "notes/" + copied["id"]
    assert copied["title"] == title
    assert json.loads(copied["content"]) == delta
    assert copied["tagIds"] == [tag["id"]]
    copied_file, = api(copied_path + "/attachments", token=token)
    assert copied_file["id"] != file["id"] and copied_file["originalFilename"] == "Copy.wav"
    assert api(copied_path + "/attachments/" + copied_file["id"], token=token) == file_bytes
    assert api(source_path, token=token)["version"] == source_version
    Path(artifact).with_suffix(".png").write_bytes(adb("exec-out", "screencap", "-p"))

    click("More actions")
    click("Make a copy")
    find("Sync this note's local changes before making a copy.")
    assert len(api("notes", token=token)) == 2
    assert duplicates == ["/api/" + source_path + "/duplicate"] * 2
    assert undos == ["/api/notes/" + first_copy["id"] + "/duplicate/undo"]
    shell("am", "force-stop", package)
    with stopped_database(package, "databases/anchor-drafts.db") as (database, _):
        assert database.execute("SELECT id FROM pending_notes WHERE title = ?", ("Offline-edited-copy",)).fetchall() == [
            (copied["id"],),
        ]
    Path(artifact).write_text(json.dumps({
        "source": source["id"],
        "copy": copied["id"],
        "quillAndTagPreserved": True,
        "attachmentSha256": hashlib.sha256(file_bytes).hexdigest(),
        "sourceUnchanged": True,
        "pendingEditProtected": True,
        "unchangedCopyUndone": True,
        "pendingEditProtectedFromUndo": True,
    }, indent=2) + "\n")
finally:
    gateway.shutdown()
    gateway.server_close()
    adb("reverse", "--remove", tunnel)
