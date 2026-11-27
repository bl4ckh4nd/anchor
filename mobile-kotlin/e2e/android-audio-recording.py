"""Record an audio attachment on a disposable Android emulator and verify its stored bytes."""
import hashlib
import json
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid
from pathlib import Path

from android_test_ui import adb, click, find, shell, type_in

port, artifact = sys.argv[1:]
result = Path(artifact)
origin = f"http://127.0.0.1:{port}"
package = "com.zhfahim.anchor.compose"
password = f"Fixture{uuid.uuid4().hex}"
email = f"audio-{uuid.uuid4().hex}@example.test"
title = "Audio recording fixture"
tunnel = f"tcp:{port}"


def call(path, *, payload=None, token=None, status=200):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(origin + "/api/" + path,
                                     json.dumps(payload).encode() if payload is not None else None, headers)
    with urllib.request.urlopen(request, timeout=15) as response:
        assert response.status == status, (path, response.status, status)
        content = response.read()
        return json.loads(content) if response.headers.get_content_type() == "application/json" else content


token = call("auth/register", payload={"name": "Audio fixture", "email": email, "password": password},
             status=201)["access_token"]
note = call("notes", payload={"title": title}, token=token, status=201)
path = f"notes/{note['id']}/attachments"
adb("reverse", tunnel, tunnel)
connected = True
try:
    shell("am", "start", "-W", "-n", f"{package}/anchor.AnchorActivity")
    find("Sign in")
    for index, value in enumerate((origin, email, password)):
        type_in(index, value)
    shell("input", "keyevent", "4")
    click("Sign in")
    click(title)
    click("Add to note")
    click("Record audio")
    click("While using the app")
    find("Stop recording")
    click("Cancel")
    assert call(path, token=token) == []

    click("Add to note")
    click("Record audio")
    find("Stop recording")
    time.sleep(2)
    click("Stop recording")
    find("Attach recording")
    find("Playback position")
    assert call(path, token=token) == []
    result.with_suffix(".png").write_bytes(adb("exec-out", "screencap", "-p"))
    click("Attach recording")
    for _ in range(30):
        attachments = call(path, token=token)
        if attachments:
            break
        time.sleep(0.5)
    assert len(attachments) == 1, attachments
    attachment = attachments[0]
    assert attachment["mimeType"] == "audio/mp4"
    audio = call(path + "/" + attachment["id"], token=token)
    assert len(audio) == attachment["fileSize"]
    with tempfile.NamedTemporaryFile(suffix=".m4a") as sample:
        sample.write(audio)
        sample.flush()
        inspection = subprocess.check_output([
            "ffprobe", "-v", "error", "-show_streams", "-of", "json", sample.name,
        ], text=True)
    stream, = json.loads(inspection)["streams"]
    assert stream["codec_name"] == "aac" and float(stream["duration"]) > 0

    queued_title = "Offline-audio-note"
    adb("reverse", "--remove", tunnel)
    connected = False
    shell("am", "force-stop", package)
    shell("am", "start", "-W", "-n", f"{package}/anchor.AnchorActivity")
    click("New note")
    type_in(0, queued_title)
    shell("input", "keyevent", "4")
    click("Add to note")
    find("Stop recording")
    time.sleep(2)
    click("Stop recording")
    click("Save note with recording")
    find("Pending notes")
    find(queued_title)
    assert all(row["title"] != queued_title for row in call("notes", token=token))

    shell("am", "force-stop", package)
    shell("am", "start", "-W", "-n", f"{package}/anchor.AnchorActivity")
    find("Pending notes")
    find(queued_title)
    adb("reverse", tunnel, tunnel)
    connected = True
    for _ in range(100):
        created = [row for row in call("notes", token=token) if row["title"] == queued_title]
        if created:
            queued_path = f"notes/{created[0]['id']}/attachments"
            uploaded = call(queued_path, token=token)
            if uploaded:
                break
        time.sleep(0.5)
    else:
        raise AssertionError("The note and recording did not sync after restart")
    assert len(created) == 1 and len(uploaded) == 1, (created, uploaded)
    assert uploaded[0]["mimeType"] == "audio/mp4"
    queued_audio = call(queued_path + "/" + uploaded[0]["id"], token=token)
    assert len(queued_audio) == uploaded[0]["fileSize"] and b"ftyp" in queued_audio[:16]

    result.write_text(json.dumps({
        "permissionGranted": True, "cancelDidNotUpload": True, "reviewDidNotUpload": True,
        "attachedAfterConfirmation": True, "recordingPreviewHasSeekControl": True, "codec": stream["codec_name"],
        "durationSeconds": float(stream["duration"]), "sha256": hashlib.sha256(audio).hexdigest(),
        "newNoteAndRecordingSavedOffline": True, "newNoteSurvivedOfflineRestart": True,
        "recordingUploadedToNewNote": True, "newNoteRecordingSha256": hashlib.sha256(queued_audio).hexdigest(),
    }, indent=2) + "\n")
finally:
    if connected:
        adb("reverse", "--remove", tunnel)
