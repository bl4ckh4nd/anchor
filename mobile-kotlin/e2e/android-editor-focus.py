"""Check the new-note focus preference and saving a note without a title."""
import json
import shlex
import sys
import time
import urllib.request
import uuid
from pathlib import Path

from android_test_ui import account_action, adb, click, find, nodes, shell, type_in

port, artifact = sys.argv[1:]
result = Path(artifact)
package = "com.zhfahim.anchor.compose"
origin = f"http://127.0.0.1:{port}"
tunnel = f"tcp:{port}"
suffix = uuid.uuid4().hex[:8]
email, password = f"editor-focus-{suffix}@example.test", f"Fixture{suffix}"
choice = "Start new notes in the body"
body = f"Body-first-{suffix}"


def api(path, *, payload=None, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    request = urllib.request.Request(origin + "/api/" + path, headers=headers,
                                     data=json.dumps(payload).encode() if payload else None)
    with urllib.request.urlopen(request, timeout=8) as response:
        return json.load(response)


def start():
    shell("am", "start", "-W", "-n", package + "/anchor.AnchorActivity")


def stop():
    shell("am", "force-stop", package)


def open_composer(focused):
    click("New note")
    for _ in range(8):
        fields = [node for node in nodes() if node.get("class") == "android.widget.EditText"]
        if len(fields) >= 2 and [i for i, node in enumerate(fields) if node.get("focused") == "true"] == [focused]:
            return
    raise AssertionError(f"Expected composer field {focused + 1} to have focus")


def hide_keyboard():
    shell("input", "keyevent", "4")


def set_focus(to_body):
    account_action("Settings")
    find(choice)
    result.with_name(result.stem + "-settings.png").write_bytes(adb("exec-out", "screencap", "-p"))
    click(choice)
    for _ in range(16):
        stored = shell("run-as", package, "cat", "files/note-layout").decode().splitlines()
        if stored == ["List", "TitleAscending", "System", "false", str(to_body).lower(), "Sans", "Default", "true", "Standard"]:
            break
        time.sleep(0.25)
    else:
        raise AssertionError(stored)
    click("Back to notes")


account = api("auth/register", payload={"name": "Editor focus fixture", "email": email, "password": password})
token = account["access_token"]
adb("reverse", tunnel, tunnel)
try:
    stop()
    old_preferences = "mkdir -p files && printf 'List\\nTitleAscending\\nSystem\\nfalse' > files/note-layout"
    shell("run-as", package, "sh", "-c", shlex.quote(old_preferences))
    start()
    find("Sign in")
    for index, value in enumerate((origin, email, password)):
        type_in(index, value)
    hide_keyboard()
    click("Sign in")

    open_composer(0)
    hide_keyboard()
    click("Back to notes")
    set_focus(True)
    open_composer(1)
    hide_keyboard()
    click("Save note")
    click("Back to notes")
    find("No notes yet")
    assert api("notes", token=token) == []
    adb("reverse", "--remove", tunnel)
    stop()
    start()
    open_composer(1)
    result.with_name(result.stem + "-body-focus.png").write_bytes(adb("exec-out", "screencap", "-p"))
    shell("input", "text", body)
    hide_keyboard()
    click("Save note")
    find("Pending notes")
    find("Untitled note")
    assert api("notes", token=token) == []
    stop()
    start()
    find("Pending notes")
    find("Untitled note")
    adb("reverse", tunnel, tunnel)

    for _ in range(30):
        notes = api("notes", token=token)
        if notes:
            break
        time.sleep(0.5)
    assert len(notes) == 1 and notes[0]["title"] == ""
    assert json.loads(notes[0]["content"]) == {"ops": [{"insert": body + "\n"}]}
    find("Untitled note")
    set_focus(False)
    open_composer(0)
    result.write_text(json.dumps({
        "oldPreferencesRetained": True,
        "defaultTitleFocus": True,
        "bodyFocusAfterRestart": True,
        "emptyNotesCannotSave": True,
        "bodyOnlyNoteVerifiedByConvex": True,
        "untitledDraftVisibleAfterOfflineRestart": True,
        "titleFocusRestored": True,
    }, indent=2) + "\n")
finally:
    if tunnel in adb("reverse", "--list").decode().split():
        adb("reverse", "--remove", tunnel)
