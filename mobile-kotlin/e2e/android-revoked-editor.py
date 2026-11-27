"""Check Compose editor and pending draft visibility after a share is revoked."""
import json
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from android_test_ui import adb, click, find, nodes, shell, sync_notes, type_in

port, artifact = sys.argv[1:]
package = "com.zhfahim.anchor.compose"
origin = f"http://127.0.0.1:{port}"
password = f"Fixture{uuid.uuid4().hex}"


def call(path, *, method="GET", payload=None, token=None, status=200):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(origin + "/api/" + path,
                                     json.dumps(payload).encode() if payload is not None else None,
                                     headers, method=method)
    try:
        reply = urllib.request.urlopen(request, timeout=15)
    except urllib.error.HTTPError as error:
        reply = error
    with reply:
        assert reply.status == status, (path, reply.status, status)
        return json.load(reply)


def register(name, email):
    return call("auth/register", method="POST", status=201,
                payload={"name": name, "email": email, "password": password})


owner = register("Owner fixture", f"owner-{uuid.uuid4().hex}@example.test")["access_token"]
email = f"editor-{uuid.uuid4().hex}@example.test"
account = register("Editor fixture", email)
recipient = account["access_token"]
title = "Shared note before removal"
content = "Private shared fixture text"
note = call("notes", method="POST", token=owner, status=201, payload={
    "title": title, "content": json.dumps({"ops": [{"insert": content + "\n"}]}),
})
path = f"notes/{note['id']}"
share = call(path + "/shares", method="POST", token=owner, status=201, payload={
    "sharedWithUserId": account["user"]["id"], "permission": "editor",
})
tunnel = f"tcp:{port}"
adb("reverse", tunnel, tunnel)
try:
    shell("am", "start", "-W", "-n", f"{package}/anchor.AnchorActivity")
    find("Sign in")
    for index, value in enumerate((origin, email, password)):
        type_in(index, value)
    shell("input", "keyevent", "4")
    click("Sign in")
    click(title)
    find("Back to notes")
    find(content)
    call(path + "/shares/" + share["id"], method="DELETE", token=owner)
    call(path, token=recipient, status=404)
    for _ in range(20):
        visible = {label for node in nodes() for label in (node.get("text"), node.get("content-desc"))}
        if "New note" in visible and "Back to notes" not in visible:
            break
    else:
        raise AssertionError("The editor remained open after access was revoked")
    assert not any(text and (content in text or title in text) for text in visible)

    queued_title = "Revoked-draft-fixture"
    queued_body = "Queued-private-body"
    note = call("notes", method="POST", token=owner, status=201, payload={
        "title": "Shared note with queued draft",
        "content": json.dumps({"ops": [{"insert": content + "\n"}]}),
    })
    path = f"notes/{note['id']}"
    share = call(path + "/shares", method="POST", token=owner, status=201, payload={
        "sharedWithUserId": account["user"]["id"], "permission": "editor",
    })
    sync_notes()
    find(note["title"])
    adb("reverse", "--remove", tunnel)
    # Restart so no pooled connection outlives the tunnel and the draft stays queued.
    shell("am", "force-stop", package)
    shell("am", "start", "-W", "-n", f"{package}/anchor.AnchorActivity")
    click(note["title"])
    type_in(0, queued_title)
    type_in(1, queued_body)
    shell("input", "keyevent", "4")
    click("Save changes")
    find("Saved on device")
    click("Back to notes")
    find(queued_title)
    call(path + "/shares/" + share["id"], method="DELETE", token=owner)
    call(path, token=recipient, status=404)
    adb("reverse", tunnel, tunnel)
    sync_notes()
    find("Draft unavailable")
    shell("am", "force-stop", package)
    shell("am", "start", "-W", "-n", f"{package}/anchor.AnchorActivity")
    click("Draft unavailable")
    find("Discard draft")
    visible = [node.get("text", "") for node in nodes()]
    assert not any(content in text or queued_title in text or queued_body in text for text in visible)
    click("Close draft")
    owner_title = "Owner update while access was revoked"
    call(path, method="PATCH", token=owner, payload={"title": owner_title})
    call(path + "/shares", method="POST", token=owner, status=201, payload={
        "sharedWithUserId": account["user"]["id"], "permission": "editor",
    })
    sync_notes()
    click(queued_title + " (needs review)")
    find(queued_body)
    assert call(path, token=owner)["title"] == owner_title
    Path(artifact).write_text(json.dumps({
        "serverRevokedAccess": True, "editorClosed": True, "revokedTitleAndBodyHidden": True,
        "queuedDraftContentsHiddenAfterRestart": True, "queuedDraftStillAvailableToDiscard": True,
        "queuedDraftContentsVisibleAfterAccessRestored": True,
    }, indent=2) + "\n")
finally:
    adb("reverse", "--remove", tunnel)
