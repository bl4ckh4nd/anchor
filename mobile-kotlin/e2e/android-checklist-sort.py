"""Verify checklist sorting, undo and the off switch with stored Quill data."""
import json
import re
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
package = "com.zhfahim.anchor.compose"
suffix = uuid.uuid4().hex[:8]
email, password = f"checklist-sort-{suffix}@example.test", f"Fixture{suffix}"
choice = "Move checked items to the bottom"


def api(path, *, payload=None, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    request = urllib.request.Request(origin + "/api/" + path, headers=headers,
                                     data=json.dumps(payload).encode() if payload else None)
    with urllib.request.urlopen(request, timeout=8) as response:
        return json.load(response)


def op(value, **attrs):
    return {"insert": value, **({"attributes": attrs} if attrs else {})}


parent = [op("Pack", bold=True), op("\n", list="unchecked", kept="parent")]
parent_checked = [parent[0], op("\n", list="checked", kept="parent")]
children = [op("Shoes", link="https://example.test/shoes"), op({"image": "https://example.test/image.png"}),
            op("\n", list="unchecked", indent=1),
            op("Socks"), op("\n", list="checked", indent=1, kept="child")]
sibling = [op("Print"), op("\n", list="unchecked")]
checked = [op("Book"), op("\n", list="checked")]
after = [op("Separator\n"), op("Call"), op("\n", list="unchecked")]
original = {"schemaFixture": True, "ops": parent + children + sibling + checked + after}
sorted_ops = {"schemaFixture": True, "ops": sibling + checked + parent_checked + children + after}
unsorted_ops = {"schemaFixture": True, "ops": parent_checked + children + sibling + checked + after}
long_prefix = [op("".join(f"Line {index + 1}\n" for index in range(45)))]
last_task = op("File receipts")
long_note = {"ops": long_prefix + [last_task, op("\n", list="unchecked")]}
long_note_checked = {"ops": long_prefix + [last_task, op("\n", list="checked")]}


def scroll_to(label):
    for _ in range(6):
        if any(label in (node.get("text"), node.get("content-desc")) for node in nodes()):
            return
        shell("input", "swipe", "140", "1210", "140", "420", "380")
    raise AssertionError(f"Could not scroll to {label}")


def edit(title):
    click(title)
    find("Back to notes")


def body_bounds(fragment):
    field = next(node for node in nodes() if node.get("class") == "android.widget.EditText" and fragment in (node.get("text") or ""))
    return tuple(map(int, re.findall(r"\d+", field.get("bounds"))))


def tap_first_line(offset):
    left, top, _, _ = body_bounds("Pack")
    shell("input", "tap", str(left + offset), str(top + 12))


def mark_first():
    tap_first_line(42)
    shell("input", "keyevent", "122")
    click("Block format")
    click("Mark checked")


def save_and_check(note, expected):
    click("Save changes")
    for _ in range(32):
        stored = api(f"notes/{note['id']}", token=token)
        if stored["version"] == 2:
            assert json.loads(stored["content"]) == expected, stored["content"]
            click("Back to notes")
            return
        time.sleep(0.3)
    raise AssertionError("The edited checklist was not synced")


account = api("auth/register", payload={"name": "Checklist sort fixture", "email": email, "password": password})
token = account["access_token"]
titles = ("Sorting on", "Sorting off")
notes = {title: api("notes", payload={"title": title, "content": json.dumps(original)}, token=token) for title in titles}
long_title = "Checklist below the fold"
long_fixture = api("notes", payload={"title": long_title, "content": json.dumps(long_note)}, token=token)
adb("reverse", tunnel, tunnel)
try:
    shell("am", "start", "-W", "-n", package + "/anchor.AnchorActivity")
    find("Sign in")
    for index, value in enumerate((origin, email, password)):
        type_in(index, value)
    shell("input", "keyevent", "4")
    click("Sign in")

    edit(titles[0])
    mark_first()
    # Undo includes both the change of status and the move.
    click("Undo checklist change")
    tap_first_line(55)
    assert not any(node.get("text") == "Undo checklist change" for node in nodes()), "A text tap toggled the checkbox"
    tap_first_line(8)
    find("Undo checklist change")
    result.with_name(result.stem + "-sorted.png").write_bytes(adb("exec-out", "screencap", "-p"))
    save_and_check(notes[titles[0]], sorted_ops)

    account_action("Settings")
    click(choice)
    for _ in range(16):
        if shell("run-as", package, "cat", "files/note-layout").decode().splitlines()[7:8] == ["false"]:
            break
        time.sleep(0.25)
    else:
        raise AssertionError("The disabled sorting preference was not stored")
    find(choice)
    result.with_name(result.stem + "-settings.png").write_bytes(adb("exec-out", "screencap", "-p"))
    shell("am", "force-stop", package)
    shell("am", "start", "-W", "-n", package + "/anchor.AnchorActivity")
    edit(titles[1])
    mark_first()
    save_and_check(notes[titles[1]], unsorted_ops)

    edit(long_title)
    for _ in range(3):
        shell("input", "swipe", "140", "1210", "140", "420", "380")
    left, _, _, bottom = body_bounds("File receipts")
    # The saved delta displays a trailing empty line below the checkbox.
    shell("input", "tap", str(left + 8), str(bottom - 38))
    scroll_to("Save changes")
    result.with_name(result.stem + "-scrolled.png").write_bytes(adb("exec-out", "screencap", "-p"))
    save_and_check(long_fixture, long_note_checked)

    result.write_text(json.dumps({
        "defaultSortsOnToggle": True,
        "directCheckboxTapTogglesAndSorts": True,
        "textTapDoesNotToggle": True,
        "lastCheckboxTogglesAfterScrolling": True,
        "nestedChildrenAndQuillAttributesRetained": True,
        "separateChecklistLeftInPlace": True,
        "undoRestoredToggleAndOrder": True,
        "disabledPreferenceSurvivedRestart": True,
    }, indent=2) + "\n")
finally:
    adb("reverse", "--remove", tunnel)
