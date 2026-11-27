"""Verify that a cached private image survives offline restart and is purged on revocation."""
import base64
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from android_test_ui import adb, click, find, nodes, shell, sync_notes, type_in
from benchmark_fixture import stopped_database

port, artifact = sys.argv[1:]
package = "com.zhfahim.anchor.compose"
origin = f"http://127.0.0.1:{port}"
password = f"Fixture{uuid.uuid4().hex}"
filename = "Private-fixture.png"
content = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAAH0lEQVR4nGOQ6N5OFcQwatCoQaMGjRo0atCoQQNvEAArIQqu/dnjaAAAAABJRU5ErkJggg==")


def call(path, *, method="GET", payload=None, token=None, status=200, upload=False):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    data = json.dumps(payload).encode() if payload is not None else None
    if upload:
        headers.update({"Content-Type": "image/png", "X-Anchor-Filename-Encoded": filename})
        data = content
    request = urllib.request.Request(f"{origin}/api/{path}", data=data, headers=headers, method=method)
    try:
        response = urllib.request.urlopen(request, timeout=15)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        assert response.status == status, (path, response.status, status)
        return json.load(response)


def register(name):
    email = f"cache-{uuid.uuid4().hex}@example.test"
    account = call("auth/register", method="POST", status=201, payload={"name": name, "email": email, "password": password})
    return email, account


def start():
    shell("am", "start", "-W", "-n", f"{package}/anchor.AnchorActivity")


_, owner = register("Owner")
email, recipient = register("Recipient")
token = owner["access_token"]
host_token = call("auth/convex-token", method="POST", token=token)["token"]
title = "Private attachment fixture"
note_id = str(uuid.uuid4())
file_id = str(uuid.uuid4())
path = f"notes/{note_id}"
call("compose/notes", method="POST", token=host_token, payload={"id": note_id, "title": title})
call(f"compose/attachments?noteId={note_id}&attachmentId={file_id}", method="POST", token=host_token, status=201, upload=True)
share = call(path + "/shares", method="POST", token=token, status=201,
             payload={"sharedWithUserId": recipient["user"]["id"], "permission": "viewer"})
tunnel = f"tcp:{port}"
adb("reverse", tunnel, tunnel)
try:
    start()
    for index, value in enumerate((origin, email, password)):
        type_in(index, value)
    shell("input", "keyevent", "4")
    click("Sign in")
    upgrade_apk = os.environ.get("ANCHOR_TEST_CACHE_UPGRADE_APK")
    if upgrade_apk:
        find(title)
        shell("am", "force-stop", package)
        with stopped_database(package, "databases/anchor-drafts.db") as (db, _):
            assert db.execute("PRAGMA user_version").fetchone() == (26,)
            assert db.execute("SELECT count(*) FROM cached_attachments WHERE id=?", (file_id,)).fetchone() == (1,)
        adb("install", "-r", upgrade_apk)
        start()
    click(title)
    click(filename)
    find("Close preview")
    click("Close preview")
    click("Back to notes")
    revised_title = "Updated shared attachment fixture"
    call(path, method="PATCH", token=token, payload={"title": revised_title})
    sync_notes()
    find(revised_title)

    adb("reverse", "--remove", tunnel)
    shell("am", "force-stop", package)
    start()
    click(revised_title)
    click(filename)
    find("Close preview")
    assert any(node.get("content-desc") == filename for node in nodes())
    shell("am", "force-stop", package)
    with stopped_database(package, "databases/anchor-drafts.db") as (db, _):
        assert db.execute("PRAGMA user_version").fetchone() == (28,)
        chunks = db.execute(
            "SELECT bytes FROM cached_attachment_parts WHERE attachmentId=? ORDER BY partNumber", (file_id,),
        )
        assert b"".join(row[0] for row in chunks) == content

    call(path + "/shares/" + share["id"], method="DELETE", token=token)
    call(path, token=recipient["access_token"], status=404)
    adb("reverse", tunnel, tunnel)
    start()
    sync_notes()
    find("No notes yet")
    shell("am", "force-stop", package)
    with stopped_database(package, "databases/anchor-drafts.db") as (db, _):
        assert db.execute("SELECT count(*) FROM cached_attachments WHERE id=?", (file_id,)).fetchone() == (0,)
        assert db.execute("SELECT count(*) FROM cached_attachment_parts WHERE attachmentId=?", (file_id,)).fetchone() == (0,)
    Path(artifact).write_text(json.dumps({
        "openedOfflineAfterProcessRestart": True, "survivedMetadataSync": True,
        "cachedBytesSha256": hashlib.sha256(content).hexdigest(), "cachePurgedAfterRevocation": True,
        "room26InPlaceUpgrade": bool(upgrade_apk),
    }) + "\n")
finally:
    if tunnel in adb("reverse", "--list").decode().split():
        adb("reverse", "--remove", tunnel)
