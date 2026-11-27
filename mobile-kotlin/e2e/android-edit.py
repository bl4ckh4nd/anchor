"""Exercise a rich offline edit, restart and a conflicting second session."""
import json
import re
import sys
import time
import urllib.request
import uuid
from pathlib import Path

from android_test_ui import adb, click, find, nodes, shell, type_in

port, artifact = sys.argv[1:]
output = Path(artifact)
package = "com.zhfahim.anchor.compose"
origin = f"http://127.0.0.1:{port}"
tunnel = f"tcp:{port}"
suffix = uuid.uuid4().hex[:8]
email, password = f"android-edit-{suffix}@example.test", f"Fixture{suffix}"
title, local, remote = (f"{name}-{suffix}" for name in ("Existing", "Draft", "Remote"))


def api(path, *, payload=None, token=None, method=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(origin + "/api/" + path, headers=headers,
                                     data=json.dumps(payload).encode() if payload is not None else None,
                                     method=method)
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.load(response)


def start():
    shell("am", "start", "-W", "-n", package + "/anchor.AnchorActivity")


def stop():
    shell("am", "force-stop", package)


def offline_editor(note_title):
    adb("reverse", "--remove", tunnel)
    stop()
    start()
    click(note_title)
    find("More actions")


def focus_body_start():
    field = next(node for node in nodes() if node.get("class") == "android.widget.EditText"
                 and "Formatted note" in (node.get("text") or ""))
    left, top, _, _ = map(int, re.findall(r"\d+", field.get("bounds")))
    shell("input", "tap", str(left + 55), str(top + 10))
    focused = next(node for node in nodes() if node.get("focused") == "true")
    assert "Formatted note" in (focused.get("text") or "")
    shell("input", "keyevent", "122")


ops = [
    {"insert": "Formatted note", "attributes": {"bold": True, "unknown-mark": "keep"}},
    {"insert": "\n", "attributes": {"header": 2}},
    {"insert": "Checklist"},
    {"insert": "\n", "attributes": {"list": "checked"}},
    {"insert": "Anchor link", "attributes": {"link": "https://example.test"}},
    {"insert": "\n"},
    {"insert": {"image": "https://example.test/fixture.png"}},
    {"insert": {"audio": "https://example.test/fixture.ogg"}},
    {"insert": "\n"},
]
account = api("auth/register", payload={"name": "Edit fixture", "email": email, "password": password})
token = account["access_token"]
note = api("notes", token=token, payload={"title": title, "content": json.dumps({"ops": ops})})
path = f"notes/{note['id']}"
adb("reverse", tunnel, tunnel)
try:
    start()
    find("Sign in")
    for index, value in enumerate((origin, email, password)):
        type_in(index, value)
    shell("input", "keyevent", "4")
    click("Sign in")
    find(title)

    offline_editor(title)
    focus_body_start()
    click("Italic")
    click("Inline code")
    shell("input", "text", "Updated%s")
    shell("input", "keycombination", "59", "122")  # Shift+Home selects the typed words.
    click("Underline")
    shell("input", "keyevent", "4")
    click("Save changes")
    find("Saved on device")
    click("Back to notes")
    find("Pending notes")
    stop()
    start()
    find("Pending notes")
    assert api(path, token=token)["version"] == 1

    adb("reverse", tunnel, tunnel)
    for _ in range(40):
        stored = api(path, token=token)
        if stored["version"] > 1:
            break
        time.sleep(0.5)
    else:
        raise AssertionError("Offline edit did not sync after restart")
    assert stored["version"] == 2 and stored["id"] == note["id"]
    actual = json.loads(stored["content"])["ops"]
    formatted = [op for op in actual if op.get("attributes", {}).get("italic")]
    assert "".join(op["insert"] for op in formatted) == "Updated ", actual
    assert all(op["attributes"].get("code") is True and op["attributes"].get("underline") is True
               and op["attributes"].get("unknown-mark") == "keep" for op in formatted), formatted
    assert next(op for op in actual if op["insert"] == "Formatted note")["attributes"] == ops[0]["attributes"]
    assert actual[-len(ops[1:]):] == ops[1:]
    find("Pending notes sent.")
    find(title)

    offline_editor(title)
    type_in(0, local)
    focus_body_start()
    shell("input", "text", "Local%s")
    shell("input", "keyevent", "4")
    click("Save changes")
    find("Saved on device")
    click("Back to notes")
    find("Pending notes")
    remote_delta = {"ops": [{"insert": "Server changes\n"}]}
    acknowledged = api(path, token=token, method="PATCH", payload={
        "title": remote, "content": json.dumps(remote_delta), "baseVersion": 2,
    })
    assert acknowledged["version"] == 3
    adb("reverse", tunnel, tunnel)
    find(f"{local} (needs review)")
    for _ in range(7):  # The background pull retries with a backoff of up to 30 seconds after going offline.
        if any(node.get("text") == remote for node in nodes()):
            break
        time.sleep(10)
    else:
        raise AssertionError(f"{remote} did not arrive after reconnecting")
    stop()
    start()
    click(f"{local} (needs review)")
    find("Draft needs review")
    find(local)
    draft = next(node.get("text") for node in nodes() if "Local Updated" in (node.get("text") or "")
                 and "Anchor link" in node.get("text"))
    output.with_suffix(".png").write_bytes(adb("exec-out", "screencap", "-p"))
    assert "☑ Checklist" in draft and "[Image][Audio]" in draft, f"Review lost rich draft structure: {draft!r}"
    click("Close draft")
    preserved = api(path, token=token)
    assert preserved["version"] == 3 and preserved["title"] == remote
    assert json.loads(preserved["content"]) == remote_delta
    output.write_text(json.dumps({
        "offlineEditSurvivedRestart": True,
        "richDeltaRoundTripOnOriginalId": True,
        "conflictingBodyAndTitleRetainedLocally": True,
        "draftReviewRendersChecklistLinkAndEmbeds": True,
        "remoteVersionRetainedAfterRestart": True,
    }, indent=2) + "\n")
finally:
    if tunnel in adb("reverse", "--list").decode().split():
        adb("reverse", "--remove", tunnel)
