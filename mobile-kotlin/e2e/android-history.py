import json
import re
import subprocess
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from xml.etree import ElementTree

PACKAGE = "com.zhfahim.anchor.compose"
ORIGIN = "http://127.0.0.1:3735"
TUNNEL = "tcp:3766"
output = Path(sys.argv[1])


def adb(*args):
    return subprocess.check_output(["adb", *args], timeout=20)


def shell(*args):
    return adb("shell", *args)


def nodes():
    path = "/data/local/tmp/anchor-compose-history.xml"
    shell("uiautomator", "dump", path)
    return [
        node for node in ElementTree.fromstring(shell("cat", path)).iter("node")
        if node.get("package") == PACKAGE
    ]


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
email = f"android-history-{suffix}@example.test"
password = f"SyntheticHistory{suffix}"
token = None
account = api("auth/register", "POST", body={"name": "History fixture", "email": email, "password": password}, status=201)
token = account["access_token"]
current = f"Current {suffix}"
draft = f"Draft {suffix}"
body = json.dumps({"ops": [
    {"insert": "Recover this paragraph", "attributes": {"bold": True}},
    {"insert": "\n", "attributes": {"header": 2}},
    {"insert": "Checked step"},
    {"insert": "\n", "attributes": {"list": "checked", "indent": 1}},
    {"insert": "Code example"},
    {"insert": "\n", "attributes": {"code-block": "plain"}},
]})
first = "First " + suffix
intermediate = "Intermediate " + suffix
def delta(text):
    return json.dumps({"ops": [{"insert": text}]})

note = api("notes", "POST", body={
    "title": first, "content": delta("The meeting is Friday.\nRemoved paragraph.\nStable paragraph.\n"),
}, status=201)
note_path = "notes/" + note["id"]
api(note_path, "PATCH", body={
    "title": current, "baseVersion": 1,
    "content": delta("The meeting is Tuesday.\nStable paragraph.\n"),
})
pushed = api("compose/sync", "POST", body={"changes": [{
    "type": "note", "id": note["id"], "title": current, "revisionsOnly": True,
    "revisions": [{
        "id": str(uuid.uuid4()), "title": intermediate, "cause": "restore",
        "content": delta("The meeting is Monday.\nStable paragraph.\nAdded paragraph.\n"),
        "createdAt": "2025-06-01T12:00:00Z",
    }],
}]})
assert pushed["results"][0]["status"] == "applied"
api(note_path, "PATCH", body={"title": draft, "content": body, "baseVersion": 1}, status=409)
assert TUNNEL not in adb("reverse", "--list").decode().split()
adb("reverse", TUNNEL, "tcp:3735")
needs_sign_out = False
try:
    shell("am", "force-stop", PACKAGE)
    shell("am", "start", "-W", "-n", f"{PACKAGE}/anchor.AnchorActivity")
    find("Sign in")
    for index, text in enumerate(("http://127.0.0.1:3766", email, password)):
        field = [node for node in nodes() if node.get("class") == "android.widget.EditText"][index]
        tap(field)
        shell("input", "text", text)
    shell("input", "keyevent", "4")
    tap(find("Sign in"))
    needs_sign_out = True
    tap(find(current))
    tap(find("More actions"))
    tap(find("Version history"))
    current_version = find("Current version")
    output.with_suffix(".timeline.png").write_bytes(adb("exec-out", "screencap", "-p"))
    tap(current_version)
    find(current)
    tap(find("Back to versions"))
    tap(find(first))
    tap(find("Show changes"))
    find("The meeting is Friday.")
    find("The meeting is Monday.")
    find("Removed paragraph.")
    find("Added paragraph.")
    assert find("The meeting is Tuesday.", required=False) is None
    output.with_suffix(".comparison.png").write_bytes(adb("exec-out", "screencap", "-p"))
    tap(find("Back to versions"))
    tap(find(draft))
    find("Recover this paragraph")
    find("\u00a0\u00a0☑ Checked step")
    find("Code example")
    tap(find("Show changes"))
    find("Compared with the current version")
    find("The meeting is Tuesday.")
    tap(find("Hide changes"))
    find("Recover this paragraph")
    tap(find("Restore"))
    tap(find("Cancel"))
    assert api(note_path)["title"] == current
    tap(find("Restore"))
    tap(find("Restore version"))
    find("Version restored.")
    stored = api(note_path)
    assert stored["title"] == draft and stored["content"] == body and stored["version"] == 3
    output.with_suffix(".png").write_bytes(adb("exec-out", "screencap", "-p"))
    tap(find("Back to versions"))
    tap(find("Close history"))
    find(draft)
    tap(find("More actions"))
    tap(find("Version history"))
    tap(find(current))
    tap(find("Restore"))
    tap(find("Restore version"))
    find("Version restored.")
    tap(find("Undo"))
    find("Restore undone.")
    assert api(note_path)["content"] == body
    version = api(note_path)["version"]
    tap(find("Back to versions"))
    tap(find(current))
    tap(find("Restore"))
    tap(find("Restore version"))
    find("Version restored.")
    concurrent_title = "Concurrent " + suffix
    api(note_path, "PATCH", body={"title": concurrent_title, "baseVersion": version + 1})
    tap(find("Undo"))
    find("The note changed. This restore can no longer be undone.")
    assert api(note_path)["title"] == concurrent_title
    tap(find("Back to versions"))
    tap(find("Close history"))
    tap(find("Back to notes"))
    tap(find("Open menu"))
    tap(find("Account menu"))
    tap(find("Sign out"))
    find("Sign in")
    needs_sign_out = False
    output.write_text(json.dumps({
        "currentPreview": True, "conflictPreview": True, "quillBlockPreview": True, "cancelKeptCurrent": True,
        "restoredExactDelta": True, "syncedRestoredTitle": True,
        "undoRestoredPriorDelta": True, "undoPreservedConcurrentEdit": True,
        "comparedNextRegularVersion": True, "comparedConflictWithCurrent": True,
    }) + "\n")
finally:
    try:
        if needs_sign_out:
            shell("am", "force-stop", PACKAGE)
            shell("am", "start", "-W", "-n", f"{PACKAGE}/anchor.AnchorActivity")
            sign_out = find("Sign out", required=False)
            if sign_out is not None:
                tap(sign_out)
    finally:
        adb("reverse", "--remove", TUNNEL)
