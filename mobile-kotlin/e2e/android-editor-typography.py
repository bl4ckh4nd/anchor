"""Verify note typography preferences, rendered editor text and persisted Quill."""
import hashlib
import json
import re
import shlex
import struct
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
email, password = f"typography-{suffix}@example.test", f"Fixture{suffix}"
title = "Typography fixture"
body = "WideWordsMakeSizeVisible"
content = {"ops": [{"insert": body + "\n"}]}


def api(path, *, payload=None, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    request = urllib.request.Request(origin + "/api/" + path, headers=headers,
                                     data=json.dumps(payload).encode() if payload else None)
    with urllib.request.urlopen(request, timeout=8) as response:
        return json.load(response)


def stop():
    shell("am", "force-stop", package)


def start():
    shell("am", "start", "-W", "-n", f"{package}/anchor.AnchorActivity")


def editor_sample(name):
    click(title)
    find("Back to notes")
    field = next(node for node in nodes() if node.get("class") == "android.widget.EditText" and body in (node.get("text") or ""))
    left, top, right, bottom = map(int, re.findall(r"\d+", field.get("bounds")))
    raw = adb("exec-out", "screencap")
    width, height, pixel_format = struct.unpack_from("<III", raw)
    header = len(raw) - width * height * 4
    assert pixel_format == 1 and header in (12, 16)
    text_left, text_right = left + 10, right - 10
    text_top, text_bottom = top + 15, min(top + 80, bottom - 6)
    rows = [raw[header + (y * width + text_left) * 4:header + (y * width + text_right) * 4]
            for y in range(text_top, text_bottom)]
    ink = [x // 4 for row in rows for x in range(0, len(row), 4) if max(row[x:x + 3]) < 120]
    assert ink and max(ink) - min(ink) > 70
    result.with_name(f"{result.stem}-{name}.png").write_bytes(adb("exec-out", "screencap", "-p"))
    click("Back to notes")
    return max(ink) - min(ink), hashlib.sha256(b"".join(rows)).hexdigest()


def preferences(font, size, *choices):
    account_action("Settings")
    find("Text size")
    for choice in choices:
        click(choice)
    for _ in range(16):
        stored = shell("run-as", package, "cat", "files/note-layout").decode().splitlines()
        if stored == ["List", "TitleAscending", "Light", "false", "false", font, size, "true", "Standard"]:
            break
        time.sleep(0.25)
    else:
        raise AssertionError(stored)
    if size == "Large":
        result.with_name(f"{result.stem}-settings.png").write_bytes(adb("exec-out", "screencap", "-p"))
    click("Back to notes")


owner = api("auth/register", payload={"name": "Typography fixture", "email": email, "password": password})
token = owner["access_token"]
note = api("notes", token=token, payload={"title": title, "content": json.dumps(content)})
adb("reverse", tunnel, tunnel)
try:
    stop()
    old = "mkdir -p files && printf 'List\\nTitleAscending\\nLight\\nfalse\\nfalse' > files/note-layout"
    shell("run-as", package, "sh", "-c", shlex.quote(old))
    start()
    find("Sign in")
    for index, value in enumerate((origin, email, password)):
        type_in(index, value)
    shell("input", "keyevent", "4")
    click("Sign in")
    default_width, default_image = editor_sample("default")
    preferences("Sans", "Large", "Large")
    large_width, _ = editor_sample("large")
    preferences("Sans", "Small", "Small")
    small_width, _ = editor_sample("small")
    assert small_width < default_width < large_width, (small_width, default_width, large_width)
    preferences("Serif", "Default", "Default", "Serif")
    stop()
    start()
    _, serif_image = editor_sample("serif")
    assert serif_image != default_image
    preferences("Mono", "Default", "Mono")
    _, mono_image = editor_sample("mono")
    assert mono_image != default_image and mono_image != serif_image
    stored = api(f"notes/{note['id']}", token=token)
    assert stored["version"] == note["version"] and json.loads(stored["content"]) == content
    result.write_text(json.dumps({
        "olderPreferencesRetained": True,
        "serifRenderedAfterRestart": True,
        "monoRenderedDifferently": True,
        "quillDocumentUnchanged": True,
        "editorInkWidths": {"small": small_width, "default": default_width, "large": large_width},
    }, indent=2) + "\n")
finally:
    adb("reverse", "--remove", tunnel)
