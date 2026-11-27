"""Clear formatting through Compose and compare the stored selection against the original Delta."""
import json
import re
import sys
import time
import urllib.request
import uuid
from pathlib import Path

from android_test_ui import adb, click, find, nodes, shell, type_in

port, artifact = sys.argv[1:]
result = Path(artifact)
origin = f"http://127.0.0.1:{port}"
tunnel = f"tcp:{port}"
suffix = uuid.uuid4().hex[:8]
email, password = f"clear-format-{suffix}@example.test", f"Fixture{suffix}"
title = "Formatting round trip"
clear = "Clear formatting"
undo = "Undo formatting change"


def api(path, *, payload=None, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    request = urllib.request.Request(origin + "/api/" + path, headers=headers,
                                     data=json.dumps(payload).encode() if payload else None)
    with urllib.request.urlopen(request, timeout=8) as response:
        return json.load(response)


def op(value, **attributes):
    return {"insert": value, **({"attributes": attributes} if attributes else {})}


def save_enabled():
    """The save pill only appears while the note has unsaved changes."""
    tree = nodes()
    label = next((node for node in tree if node.get("content-desc") == "Save changes"), None)
    return label is not None and all(node.get("enabled") == "true" for node in tree if label in node.iter())


checklist = op("\n", list="unchecked", indent=1)
embed = op({"image": "https://example.test/fixture.png"}, width="60px", link="https://example.test/image")
quote = op("\n", blockquote=True)
before = {"customRoot": True, "ops": [
    op("Keep Clear", bold=True, vendorFormat="retained"), checklist,
    op("Deep", italic=True, link="https://example.test", highlight="yellow"),
    embed, op("End", code=True, color="#123456"), quote,
]}
after = {"customRoot": True, "ops": [
    op("Keep ", bold=True, vendorFormat="retained"), op("Clear", vendorFormat="retained"), checklist,
    op("Deep"), embed, op("End"), quote,
]}

account = api("auth/register", payload={"name": "Clear formatting fixture", "email": email, "password": password})
token = account["access_token"]
note = api("notes", payload={"title": title, "content": json.dumps(before)}, token=token)
adb("reverse", tunnel, tunnel)
try:
    shell("am", "start", "-W", "-n", "com.zhfahim.anchor.compose/anchor.AnchorActivity")
    find("Sign in")
    for index, value in enumerate((origin, email, password)):
        type_in(index, value)
    shell("input", "keyevent", "4")
    click("Sign in")
    click(title)

    body = next(node for node in nodes() if node.get("class") == "android.widget.EditText"
                and "Keep Clear" in (node.get("text") or ""))
    left, top, _, _ = map(int, re.findall(r"\d+", body.get("bounds")))
    shell("input", "tap", str(left + 82), str(top + 12))
    assert any(node.get("focused") == "true" and "Keep Clear" in (node.get("text") or "") for node in nodes())
    shell("input", "keyevent", "122")
    for _ in "Keep ":
        shell("input", "keyevent", "22")
        time.sleep(0.1)
    for _ in "Clear\nDeep\ufffcEnd":
        shell("input", "keycombination", "59", "22")
    shell("input", "keycombination", "59", "123")  # Include the rest of the quoted line.
    click(clear)
    click(undo)
    assert not save_enabled(), "Undo left unsaved changes"
    click(clear)
    find(undo)
    assert save_enabled(), "Clearing formatting did not make the note saveable"
    result.with_name(result.stem + ".png").write_bytes(adb("exec-out", "screencap", "-p"))
    click("Save changes")
    for _ in range(32):
        stored = api(f"notes/{note['id']}", token=token)
        if stored["version"] == 2:
            assert json.loads(stored["content"]) == after, stored["content"]
            break
        time.sleep(0.3)
    else:
        raise AssertionError("The formatting change was not synced")
    result.write_text(json.dumps({
        "selectedInlineFormatsRemoved": True,
        "unselectedFormattingRetained": True,
        "listIndentQuoteEmbedAndUnknownAttributesRetained": True,
        "undoRestoredOriginalAndSelection": True,
        "convexRoundTrip": True,
    }, indent=2) + "\n")
finally:
    adb("reverse", "--remove", tunnel)
