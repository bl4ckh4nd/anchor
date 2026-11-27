"""Run against a disposable password-auth Convex Actions origin."""
import json
import re
import subprocess
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from android_test_ui import nodes as ui_nodes

port, artifact = sys.argv[1:]
origin = f"http://127.0.0.1:{int(port)}"
tunnel = f"tcp:{int(port)}"
package = "com.zhfahim.anchor.compose"
token = None


def api(path, method="GET", payload=None, status=200, credential=None):
    headers = {"Content-Type": "application/json"}
    selected_token = credential if credential is not None else token
    if selected_token:
        headers["Authorization"] = f"Bearer {selected_token}"
    request = urllib.request.Request(
        origin + "/api/" + path,
        json.dumps(payload).encode() if payload is not None else None,
        headers,
        method=method,
    )
    try:
        response = urllib.request.urlopen(request, timeout=15)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        assert response.status == status, (path, response.status, status)
        return json.load(response)


def adb(*args):
    return subprocess.check_output(["adb", *args], timeout=20)


def shell(*args):
    return adb("shell", *args)


def nodes():
    return [node for node in ui_nodes() if node.get("package") == package]


def find(label):
    for _ in range(12):
        for node in nodes():
            if label in (node.get("text"), node.get("content-desc")):
                return node
    raise AssertionError(f"Missing UI label {label!r}")


def tap(node):
    left, top, right, bottom = map(int, re.findall(r"\d+", node.get("bounds")))
    shell("input", "tap", str((left + right) // 2), str((top + bottom) // 2))


def click(label):
    tap(find(label))


def replace_picker_number(index, digits):
    for _ in range(6):
        fields = [node for node in nodes() if node.get("class") == "android.widget.EditText"]
        if len(fields) > index:
            break
    else:
        raise AssertionError(f"Missing number field {index + 1}")
    tap(fields[index])
    shell("input", "keyevent", "123")  # Move to the end of the field.
    shell("input", "keyevent", *["67"] * 10)
    for digit in digits:
        shell("input", "keyevent", str(7 + int(digit)))


def confirm_picker():
    button = find("OK")
    assert button.get("enabled") == "true", "The picker rejected its input"
    tap(button)


def listed_titles(*titles):
    return [node.get("text") for node in nodes() if node.get("text") in titles]


def open_folder(name):
    click("Open menu")
    click(name)


def more(action):
    click("More actions")
    click(action)


def search(term):
    click("Search notes")
    shell("input", "text", term)
    shell("input", "keyevent", "4")


suffix = uuid.uuid4().hex
email = f"library-{suffix}@example.test"
password = f"Fixture{suffix}"
account = api("auth/register", "POST", {"name": "Library fixture", "email": email, "password": password}, 201)
recipient_name = f"Recipient {suffix[:8]}"
recipient = api("auth/register", "POST", {
    "name": recipient_name,
    "email": f"recipient-{suffix}@example.test",
    "password": password,
}, 201)
reader = recipient["access_token"]
token = account["access_token"]
title = "Library fixture note"
tag = api("tags", "POST", {"name": "Research label"}, 201)
note = api("notes", "POST", {
    "title": title,
    "content": json.dumps({"ops": [{"insert": "Moon", "attributes": {"bold": True}}, {"insert": "stone\n"}]}),
    "tagIds": [tag["id"]],
}, 201)
first_title = "Alphabetical reference"
first_note = api("notes", "POST", {"title": first_title}, 201)
archive_title = "Archived reference"
archived_note = api("notes", "POST", {"title": archive_title}, 201)
api("notes/" + archived_note["id"], "PATCH", {"isArchived": True})
path = "notes/" + note["id"]
version = note["version"]
assert tunnel not in adb("reverse", "--list").decode().split()
adb("reverse", tunnel, tunnel)

try:
    if int(shell("getprop", "ro.build.version.sdk").strip()) >= 33:
        shell("pm", "revoke", package, "android.permission.POST_NOTIFICATIONS")
    shell("am", "start", "-W", "-n", f"{package}/anchor.AnchorActivity")
    find("Sign in")
    for index, value in enumerate((origin, email, password)):
        fields = [node for node in nodes() if node.get("class") == "android.widget.EditText"]
        tap(fields[index])
        shell("input", "text", value)
    shell("input", "keyevent", "4")
    click("Sign in")
    find(title)
    click("View options")
    click("Title")
    click("A to Z")
    shell("input", "keyevent", "4")
    click(title)
    click("Set reminder")
    find("Set reminder")
    if int(shell("getprop", "ro.build.version.sdk").strip()) >= 33:
        find("Notifications are off for Anchor. Reminders sync, but this device won’t alert you.")
        find("Open settings")
        assert api(path).get("reminder") is None
        shell("pm", "grant", package, "android.permission.POST_NOTIFICATIONS")
    click("Date")
    click("Switch to text input mode")
    replace_picker_number(0, "02292032")
    confirm_picker()

    click("Time")
    click("Switch to text input mode for the time input")
    find("Enter Time")
    click("Switch to clock mode for the time input")
    click("Select hour")
    click("12 o'clock")
    click("Select minutes")
    click("35 minutes")
    if any(node.get("text") == "PM" for node in nodes()):
        click("PM")
    confirm_picker()
    click("Does not repeat")
    click("Weekly")
    click("Save reminder")
    find("Edit reminder")
    initial_reminder = api(path)["reminder"]
    assert initial_reminder["remindAt"] == "2032-02-29T12:35"
    assert initial_reminder["recurrence"] == "weekly"
    click("Edit reminder")
    click("Weekly")
    click("Monthly")
    click("Save reminder")
    find("2032-02-29 12:35 · Monthly")
    revised_reminder = api(path)["reminder"]
    assert revised_reminder["recurrence"] == "monthly"
    assert revised_reminder["version"] == initial_reminder["version"] + 1
    click("Edit reminder")
    click("Remove reminder")
    find("Set reminder")
    assert api(path).get("reminder") is None and api(path)["version"] == version
    api(path, status=404, credential=reader)
    click("Share note")
    find("No one else has access")
    find("Find people")
    tap(next(node for node in nodes() if node.get("class") == "android.widget.EditText"))
    shell("input", "text", suffix[:8])
    shell("input", "keyevent", "4")
    click(recipient_name)
    click("Share")
    click("Can view")
    find("Make editor")
    assert api(path + "/shares")[0]["permission"] == "viewer"
    assert api(path, credential=reader)["permission"] == "viewer"
    api(path, "PATCH", {"title": "Denied change"}, 403, reader)
    click("Make editor")
    click("Can edit")
    find("Make viewer")
    assert api(path, credential=reader)["permission"] == "editor"
    click("Remove access")
    find("Remove access?")
    click("Cancel")
    assert api(path, credential=reader)["permission"] == "editor"
    click("Can edit")
    click("Remove access")
    find("Remove access?")
    click("Remove access")
    find("No one else has access")
    api(path, status=404, credential=reader)
    assert api(path + "/shares") == []
    click("Done")
    click("Back to notes")
    adb("reverse", "--remove", tunnel)
    for term, expected in (("MOONSTONE", title), ("research%slabel", title), ("ARCHIVED", archive_title)):
        search(term)
        find(expected)
        assert listed_titles(first_title, title, archive_title) == [expected]
        click("Close search")
        find(first_title)
    search("missing-search-term")
    find("No matching notes")
    click("Close search")
    find(first_title)
    adb("reverse", tunnel, tunnel)
    click(title)
    more("Tags")
    find("Research label")
    click("New tag")
    shell("input", "text", "Second%slabel")
    shell("input", "keyevent", "4")
    click("Create tag")
    click("Second label")
    for _ in range(8):
        updated = api(path)
        if len(updated["tagIds"]) == 2:
            break
        find("Second label")
    assert tag["id"] in updated["tagIds"] and len(updated["tagIds"]) == 2
    assert updated["version"] == version
    second_tag = next(tag_id for tag_id in updated["tagIds"] if tag_id != tag["id"])
    click("Research label")
    for _ in range(8):
        updated = api(path)
        if updated["tagIds"] == [second_tag]:
            break
        find("Research label")
    assert updated["tagIds"] == [second_tag] and updated["version"] == version
    click("Edit Second label")
    find("Rename tag")
    find("Tag name")
    field = next(node for node in nodes() if node.get("class") == "android.widget.EditText")
    tap(field)
    shell("input", "text", "Renamed%slabel")
    shell("input", "keyevent", "4")
    click("Save tag")
    for _ in range(8):
        renamed_label = api("tags/" + second_tag)["name"]
        if renamed_label != "Second label":
            break
        nodes()
    assert "Renamed label" in renamed_label
    find(renamed_label)
    assert api("tags/" + second_tag)["name"] == renamed_label
    assert api(path)["tagIds"] == [second_tag]
    first_path = "notes/" + first_note["id"]
    assert api(first_path, "PATCH", {"tagIds": [second_tag]})["tagIds"] == [second_tag]
    click("Edit " + renamed_label)
    click("Delete tag")
    find("Delete tag?")
    click("Cancel")
    assert api("tags/" + second_tag)["name"] == renamed_label
    click("Delete tag")
    find("Delete tag?")
    click("Delete tag")
    find("Research label")
    api("tags/" + second_tag, status=404)
    assert api(path)["tagIds"] == [] and api(path)["version"] == version
    first_after_delete = api(first_path)
    assert first_after_delete["tagIds"] == [] and first_after_delete["version"] == first_note["version"]
    click("Done")
    click("Back to notes")
    initial_order = listed_titles(first_title, title)
    assert initial_order == [first_title, title]
    click(title)
    click("Pin")
    find("Unpin")
    pinned = api(path)
    assert pinned["isPinned"] and pinned["version"] == version
    click("Back to notes")
    pinned_order = listed_titles(first_title, title)
    assert pinned_order == [title, first_title]
    click(title)
    click("Unpin")
    find("Pin")
    unpinned = api(path)
    assert not unpinned["isPinned"] and unpinned["version"] == version
    click("Back to notes")
    unpinned_order = listed_titles(first_title, title)
    assert unpinned_order == initial_order
    click(title)
    more("Archive note")
    open_folder("Archive")
    click(title)
    assert api(path)["isArchived"] and api(path)["version"] == version
    click("Unarchive")
    click("Back to notes")
    open_folder("Notes")
    click(title)
    assert not api(path)["isArchived"]
    more("Move to trash")
    open_folder("Trash")
    click(title)
    click("Restore")
    click("Back to notes")
    open_folder("Notes")
    click(title)
    assert api(path)["state"] == "active"

    more("Move to trash")
    open_folder("Trash")
    click(title)
    more("Delete permanently")
    find("Delete note permanently?")
    click("Cancel")
    find(title)
    assert api("notes/trash")[0]["id"] == note["id"]
    more("Delete permanently")
    find("Delete note permanently?")
    click("Delete permanently")
    find("Trash is empty")
    assert api("notes/trash") == []
    Path(artifact).write_text(json.dumps({
        "offlineSearchByRichTextTagAndArchiveTitle": True,
        "createdAssignedAndRemovedPersonalTags": True,
        "renamedTagAndConfirmedDeletion": True,
        "sharedWithViewerPromotedToEditorAndRevoked": True,
        "setEditedAndRemovedVersionedReminder": True,
        "pinnedAndUnpinnedWithoutChangingVersion": True,
        "noteOrderBeforePin": initial_order,
        "noteOrderAfterPin": pinned_order,
        "noteOrderAfterUnpin": unpinned_order,
        "archivedAndUnarchived": True,
        "movedToTrashAndRestored": True,
        "cancelledAndConfirmedPermanentDeletion": True,
    }) + "\n")
finally:
    if tunnel in adb("reverse", "--list").decode().split():
        adb("reverse", "--remove", tunnel)
