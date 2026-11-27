"""Share a WAV file from Android Files through the system sharesheet on API 35."""
import io
import json
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
import wave
from pathlib import Path

from android_test_ui import adb, center, click, find, nodes, shell, type_in
from benchmark_fixture import stopped_database


package, port, output = sys.argv[1:]
result = Path(output)
origin = f"http://127.0.0.1:{port}"
tunnel = f"tcp:{port}"
filename = "Anchor-file-share.wav"
suffix = uuid.uuid4().hex
email = f"share-{suffix}@example.test"
password = "Fixture" + suffix


def api(path, payload=None, token=None, binary=False):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    data = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(f"{origin}/api/{path}", data=data, headers=headers)
    with urllib.request.urlopen(request, timeout=15) as response:
        return response.read() if binary else json.load(response)


def launch():
    shell("am", "start", "-W", "-n", f"{package}/anchor.AnchorActivity")


account = api("auth/register", {"name": "File share fixture", "email": email, "password": password})
token = account["access_token"]
adb("reverse", tunnel, tunnel)
try:
    launch()
    find("Sign in")
    for index, value in enumerate((origin, email, password)):
        type_in(index, value)
    shell("input", "keyevent", "4")
    click("Sign in")
    find("New note")

    audio = io.BytesIO()
    with wave.open(audio, "wb") as wav:
        wav.setparams((1, 2, 8000, 0, "NONE", "not compressed"))
        wav.writeframes(bytes(16000))
    content = audio.getvalue()
    with tempfile.TemporaryDirectory() as directory:
        target = Path(directory, filename)
        target.write_bytes(content)
        adb("push", str(target), f"/sdcard/Download/{filename}")
    adb("reverse", "--remove", tunnel)

    shell("am", "start", "-W", "-n", "com.google.android.documentsui/com.android.documentsui.LauncherActivity")
    find("Show roots")
    if not any(node.get("text") == "Downloads" and node.get("resource-id", "").endswith("/breadcrumb_text")
               for node in nodes()):
        click("Show roots")
        click("Downloads")
    x, y = center(find(filename))
    shell("input", "swipe", x, y, x, y, "900")
    click("Share")
    find("Sharing 1 file", "headline")
    click("Anchor")
    find("1 attachment")
    result.with_name(result.stem + "-confirmation.png").write_bytes(adb("exec-out", "screencap", "-p"))
    click("Save note")
    find("Shared note saved on this device.")
    shell("am", "force-stop", package)

    with stopped_database(package, "databases/anchor-drafts.db") as (database, _):
        note_id, = database.execute("SELECT id FROM pending_notes").fetchone()
        attachment_id, name, mime, size = database.execute(
            "SELECT id, filename, mimeType, fileSize FROM pending_attachment_uploads WHERE noteId = ?", (note_id,),
        ).fetchone()
        assert (name, mime, size) == (filename, "audio/wav", len(content))
        rows = database.execute(
            "SELECT bytes FROM pending_attachment_parts WHERE uploadId = ? ORDER BY partNumber", (attachment_id,),
        )
        assert b"".join(row[0] for row in rows) == content
    assert api("notes", token=token) == []
    print("Room retained the shared attachment after the app stopped.", flush=True)

    adb("reverse", tunnel, tunnel)
    launch()
    convex_token = api("auth/convex-token", {}, token)["token"]
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        try:
            files = api(f"compose/attachments/list?noteId={note_id}", token=convex_token)
            if files:
                break
        except urllib.error.HTTPError as error:
            assert error.code == 404
        time.sleep(0.5)
    else:
        raise AssertionError("The shared attachment did not reach Convex")
    file, = files
    assert (file["id"], file["originalFilename"], file["fileSize"]) == (attachment_id, filename, len(content))
    assert api(f"compose/attachments?noteId={note_id}&attachmentId={attachment_id}",
               token=convex_token, binary=True) == content
    note, = api("notes", token=token)
    assert note["id"] == note_id
    result.write_text(json.dumps({
        "selectedAnchorFromSystemSharesheet": True,
        "roomRetainedFileBytesAfterProcessStop": True,
        "convexRetainedOriginalNoteAndAttachmentIds": True,
        "downloadMatchedOriginalFile": True,
    }, indent=2) + "\n")
finally:
    subprocess.run(["adb", "reverse", "--remove", tunnel], capture_output=True, timeout=10)
