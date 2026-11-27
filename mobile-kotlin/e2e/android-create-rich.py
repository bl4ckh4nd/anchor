import http.client
import json
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from android_test_ui import nodes as ui_nodes

PACKAGE = "com.zhfahim.anchor.compose"
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 3735
ORIGIN = f"http://127.0.0.1:{PORT}"
TUNNEL = "tcp:3770"
output = Path(sys.argv[1])


def adb(*args):
    return subprocess.check_output(["adb", *args], timeout=20)


def shell(*args):
    return adb("shell", *args)


def nodes():
    return [node for node in ui_nodes() if node.get("package") == PACKAGE]


def find(text, required=True):
    for _ in range(6 if required else 1):
        node = next((node for node in nodes() if text in (node.get("text", "") + "\n" + node.get("content-desc", "")).splitlines()), None)
        if node is not None:
            return node
    if required:
        raise AssertionError(f"Missing UI label {text!r}")


def tap(node):
    left, top, right, bottom = map(int, re.findall(r"\d+", node.get("bounds")))
    shell("input", "tap", str((left + right) // 2), str((top + bottom) // 2))


def api(path, method="GET", *, body=None, status=200):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(
        ORIGIN + "/api/" + path, json.dumps(body).encode() if body is not None else None,
        headers, method=method,
    )
    try:
        response = urllib.request.urlopen(request, timeout=12)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        assert response.status == status, (path, response.status, status)
        return json.load(response)


suffix = uuid.uuid4().hex[:8]
email = f"android-create-{suffix}@example.test"
password = f"SyntheticCreate{suffix}"
token = None
account = api("auth/register", "POST", body={"name": "Create fixture", "email": email, "password": password}, status=201)
token = account["access_token"]
rich_title = "Rich-" + suffix
plain_title = "Plain-" + suffix
assert TUNNEL not in adb("reverse", "--list").decode().split()


class CloseConnectionProxy(BaseHTTPRequestHandler):
    def forward(self):
        if self.path == "/api/sync/events":
            self.send_error(404)
            return
        data = self.rfile.read(int(self.headers.get("Content-Length", 0))) or None
        headers = {
            name: value for name, value in self.headers.items()
            if name.lower() not in ("host", "connection", "accept-encoding")
        }
        upstream = http.client.HTTPConnection("127.0.0.1", PORT, timeout=10)
        try:
            upstream.request(self.command, self.path, body=data, headers=headers)
            response = upstream.getresponse()
            payload = response.read()
            self.send_response(response.status)
            for name, value in response.getheaders():
                if name.lower() not in ("connection", "transfer-encoding", "content-length"):
                    self.send_header(name, value)
            self.send_header("Connection", "close")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            upstream.close()
            self.close_connection = True

    do_GET = forward
    do_POST = forward

    def log_message(self, *_):
        pass


proxy = ThreadingHTTPServer(("127.0.0.1", 0), CloseConnectionProxy)
threading.Thread(target=proxy.serve_forever, daemon=True).start()


def connect():
    adb("reverse", TUNNEL, f"tcp:{proxy.server_port}")


def launch():
    shell("am", "force-stop", PACKAGE)
    shell("am", "start", "-W", "-n", f"{PACKAGE}/anchor.AnchorActivity")


def enter(index, text):
    field = [node for node in nodes() if node.get("class") == "android.widget.EditText"][index]
    tap(field)
    shell("input", "text", text)


def notes():
    cursor = None
    result = []
    while True:
        body = {} if cursor is None else {"cursor": cursor}
        page = api("compose/sync", "POST", body=body)
        result.extend(entry["note"] for entry in page["entries"] if entry["entityType"] == "note")
        if not page["hasMore"]:
            return result
        cursor = page["nextCursor"]


connect()
signed_in = False
try:
    launch()
    find("Sign in")
    for index, text in enumerate(("http://127.0.0.1:3770", email, password)):
        enter(index, text)
    shell("input", "keyevent", "4")
    tap(find("Sign in"))
    signed_in = True
    tap(find("New note"))
    enter(0, rich_title)
    tap(find("Block format"))
    tap(find("Heading 2"))
    find("Save note")
    tap(find("Bold"))
    tap(find("Inline code"))
    shell("input", "text", "Formatted%screation")
    shell("input", "keyevent", "66")
    tap(find("Block format"))
    tap(find("Checklist"))
    find("Save note")
    shell("input", "text", "Checklist%sitem")
    tap(find("Block format"))
    output.with_suffix(".menu.png").write_bytes(adb("exec-out", "screencap", "-p"))
    tap(find("Mark checked"))
    find("Save note")
    shell("input", "keyevent", "66")
    shell("input", "text", "Another%sitem")
    tap(find("Block format"))
    tap(find("Indent list"))
    find("Save note")
    tap(find("Block format"))
    tap(find("Outdent list"))
    find("Save note")
    tap(find("Block format"))
    tap(find("Indent list"))
    find("Save note")
    shell("input", "keyevent", "123")  # End of line.
    shell("input", "keycombination", "59", "122")  # Shift+Home.
    tap(find("Link"))
    find("Add link")
    selected_label = [node for node in nodes() if node.get("class") == "android.widget.EditText"][0]
    assert selected_label.get("text") == "Another item", selected_label.get("text")
    enter(1, "javascript:alert")
    find("javascript:alert")
    tap(find("Add link"))
    find("URL")
    tap(find("Cancel"))
    find("Save note")
    tap(find("Link"))
    find("Add link")
    enter(1, "example.test/anchor")
    tap(find("Add link"))
    find("Save note")
    output.with_suffix(".png").write_bytes(adb("exec-out", "screencap", "-p"))
    adb("reverse", "--remove", TUNNEL)
    tap(find("Save note"))
    find("Pending notes")
    tap(find("New note"))
    enter(0, plain_title)
    enter(1, "Plain%safter%sformatted")
    tap(find("Save note"))
    find(plain_title)
    launch()
    find(rich_title)
    find(plain_title)
    assert notes() == []
    connect()
    for _ in range(50):
        stored = notes()
        if len(stored) == 2:
            break
        time.sleep(0.5)
    else:
        raise AssertionError("Offline creations did not sync")
    assert len({note["id"] for note in stored}) == 2
    assert all(note["version"] == 1 for note in stored)
    by_title = {note["title"]: json.loads(note["content"]) for note in stored}
    assert by_title[rich_title] == {"ops": [
        {"insert": "Formatted creation", "attributes": {"bold": True, "code": True}},
        {"insert": "\n", "attributes": {"header": 2}},
        {"insert": "Checklist item"},
        {"insert": "\n", "attributes": {"list": "checked"}},
        {"insert": "Another item", "attributes": {"link": "https://example.test/anchor"}},
        {"insert": "\n", "attributes": {"list": "unchecked", "indent": 1}},
    ]}
    assert by_title[plain_title] == {"ops": [{"insert": "Plain after formatted\n"}]}
    for _ in range(6):
        if find("Pending notes", required=False) is None:
            break
    tap(find("Open menu"))
    tap(find("Sync notes"))
    tap(find(rich_title))
    find("More actions")
    body = [node for node in nodes() if node.get("class") == "android.widget.EditText"][1]
    _, top, right, _ = map(int, re.findall(r"\d+", body.get("bounds")))
    # The portrait fixture has a single H2 line above the checked item at 160 dpi.
    shell("input", "tap", str(right - 12), str(top + 40))
    shell("input", "keyevent", "66")
    shell("input", "text", "Inserted%safter%schecked")
    edited_body = [node for node in nodes() if node.get("class") == "android.widget.EditText"][1].get("text", "")
    assert (
        edited_body.index("Checklist item") <
        edited_body.index("Inserted after checked") <
        edited_body.index("Another item")
    ), edited_body
    tap(find("Save changes"))
    rich_id = next(note["id"] for note in stored if note["title"] == rich_title)
    for _ in range(40):
        edited = api("notes/" + rich_id)
        if edited["version"] == 2:
            break
        time.sleep(0.5)
    else:
        raise AssertionError("Edit of the existing checklist did not sync")
    assert json.loads(edited["content"])["ops"][2:] == [
        {"insert": "Checklist item"},
        {"insert": "\n", "attributes": {"list": "checked"}},
        {"insert": "Inserted after checked"},
        {"insert": "\n", "attributes": {"list": "unchecked"}},
        {"insert": "Another item", "attributes": {"link": "https://example.test/anchor"}},
        {"insert": "\n", "attributes": {"list": "unchecked", "indent": 1}},
    ]
    for _ in range(6):
        if find("Pending notes", required=False) is None:
            break
    tap(find("Back to notes"))
    tap(find("Open menu"))
    tap(find("Sync notes"))
    tap(find(rich_title))
    find("More actions")
    body = [node for node in nodes() if node.get("class") == "android.widget.EditText"][1]
    tap(body)
    shell("input", "keycombination", "113", "29")  # Select the document.
    shell("input", "keyevent", "22")  # Collapse at the end.
    shell("input", "keyevent", "21")
    shell("input", "keyevent", "21")  # Move inside the final link.
    tap(find("Link"))
    find("Edit link")
    find("Another item")
    tap(find("Remove link"))
    find("Save changes")
    tap(find("Block format"))
    tap(find("Outdent list"))
    find("Save changes")
    tap(find("Save changes"))
    for _ in range(40):
        edited = api("notes/" + rich_id)
        if edited["version"] == 3:
            break
        time.sleep(0.5)
    else:
        raise AssertionError("Unlinking and outdenting did not sync")
    assert json.loads(edited["content"])["ops"][-2:] == [
        {"insert": "Another item"},
        {"insert": "\n", "attributes": {"list": "unchecked"}},
    ]
    output.write_text(json.dumps({
        "formattedCreateSurvivedOfflineRestart": True,
        "nextNoteStartsPlain": True,
        "headingAndChecklistPersisted": True, "checkedItemContinuesUnchecked": True,
        "reopenedCheckedItemContinuesUnchecked": True,
        "uniqueIdsAndInitialVersions": True,
        "linkAndIndentPersisted": True, "unsafeSchemeRejected": True,
        "unlinkAndOutdentPersisted": True,
    }) + "\n")
finally:
    try:
        if signed_in:
            launch()
            menu = find("Open menu", required=False)
            if menu is not None:
                tap(menu)
                tap(find("Account menu"))
                tap(find("Sign out"))
    finally:
        if TUNNEL in adb("reverse", "--list").decode().split():
            adb("reverse", "--remove", TUNNEL)
        proxy.shutdown()
        proxy.server_close()
