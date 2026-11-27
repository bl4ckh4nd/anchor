"""Verify existing and edited Quill highlights through Compose and Convex."""
import json
import re
import struct
import sys
import time
import urllib.request
import uuid
from pathlib import Path

from android_test_ui import account_action, adb, click, find, nodes, shell, type_in

port, artifact = sys.argv[1:]
result = Path(artifact)
origin = f"http://127.0.0.1:{port}"
tunnel = f"tcp:{port}"
suffix = uuid.uuid4().hex[:8]
email, password = f"highlight-{suffix}@example.test", f"Fixture{suffix}"
title, body = "Highlight round trip", "Highlighted words"
background = "color_purple"


def api(path, *, payload=None, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    request = urllib.request.Request(origin + "/api/" + path, headers=headers,
                                     data=json.dumps(payload).encode() if payload else None)
    with urllib.request.urlopen(request, timeout=8) as response:
        return json.load(response)


def delta(color):
    attributes = {"bold": True, "vendor": "retained"}
    if color:
        attributes["highlight"] = color
    return {"ops": [{"insert": body, "attributes": attributes}, {"insert": "\n"}]}


def text_color_pixels(name, color, *, editor=True):
    node = find(body) if editor else [
        item for item in nodes() if (item.get("text") or "").split("\n")[0] == body
    ][-1]
    if editor:
        assert node.get("class") == "android.widget.EditText", node.attrib
    left, top, right, bottom = map(int, re.findall(r"\d+", node.get("bounds")))
    raw = adb("exec-out", "screencap")
    width, height, mode = struct.unpack_from("<III", raw)
    header = len(raw) - width * height * 4
    assert mode == 1 and header in (12, 16)
    color = bytes.fromhex(color)
    count = sum(raw[i:i + 3] == color for y in range(top, min(top + 65, bottom))
                for i in range(header + (y * width + left) * 4, header + (y * width + right) * 4, 4))
    result.with_name(f"{result.stem}-{name}.png").write_bytes(adb("exec-out", "screencap", "-p"))
    return count


def open_note():
    click(title)


def select_body():
    left, top, _, _ = map(int, re.findall(r"\d+", find(body).get("bounds")))
    shell("input", "tap", str(left + 86), str(top + 28))
    assert find(body).get("focused") == "true"
    shell("input", "keycombination", "113", "29")
    click("Highlight")


def save_and_compare(version, color):
    click("Save changes")
    for _ in range(32):
        stored = api(f"notes/{note['id']}", token=token)
        if stored["version"] == version:
            assert json.loads(stored["content"]) == delta(color), stored
            assert stored["background"] == background, stored
            click("Back to notes")
            return
        time.sleep(0.3)
    raise AssertionError("The highlight edit was not synced")


account = api("auth/register", payload={"name": "Highlight fixture", "email": email, "password": password})
token = account["access_token"]
note = api("notes", payload={"title": title, "background": background, "content": json.dumps(delta("purple"))}, token=token)
adb("reverse", tunnel, tunnel)
try:
    shell("cmd", "uimode", "night", "no")
    shell("am", "start", "-W", "-n", "com.zhfahim.anchor.compose/anchor.AnchorActivity")
    find("Sign in")
    for index, value in enumerate((origin, email, password)):
        type_in(index, value)
    shell("input", "keyevent", "4")
    click("Sign in")
    open_note()
    purple = text_color_pixels("light", "e7c4ff")
    assert purple > 100, "The editor did not paint the saved purple note highlight"
    select_body()
    click("Green")
    save_and_compare(2, "green")

    account_action("Settings")
    click("Dark")
    click("Back to notes")
    open_note()
    green_preview = text_color_pixels("dark-preview", "047239", editor=False)
    assert green_preview > 100, "The note detail did not paint the saved green highlight"
    green_editor = text_color_pixels("dark", "047239")
    assert green_editor > 100, "The editor did not paint the saved green highlight"
    select_body()
    click("Remove highlight")
    save_and_compare(3, None)
    open_note()
    assert text_color_pixels("removed", "047239") == 0
    result.write_text(json.dumps({
        "lightPurplePixels": purple,
        "darkEditorGreenPixels": green_editor,
        "darkPreviewGreenPixels": green_preview,
        "webHighlightNamesRoundTrip": True,
        "removalRetainsOtherAttributes": True,
    }, indent=2) + "\n")
finally:
    adb("reverse", "--remove", tunnel)
