"""Deliver an older Convex page after a newer Compose edit was acknowledged."""
import http.client
import json
import sys
from contextlib import closing
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Event, Thread
import time
import urllib.request
import uuid

from android_test_ui import adb, center, click, find, shell, type_in

port, report = sys.argv[1:]
upstream = f"http://127.0.0.1:{port}"
package = "com.zhfahim.anchor.compose"
suffix = uuid.uuid4().hex[:8]
email, password = f"delayed-pull-{suffix}@example.test", f"Fixture{suffix}"
old_title, new_title = f"Original-{suffix}", f"Compose-{suffix}"
text = "Quill text from the original note"
content = json.dumps({"ops": [{"insert": text + "\n"}]})


def api(path, *, method="GET", payload=None, token=None, status=200):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    request = urllib.request.Request(
        upstream + "/api/" + path, headers=headers, method=method,
        data=json.dumps(payload).encode() if payload is not None else None,
    )
    with urllib.request.urlopen(request, timeout=6) as response:
        assert response.status == status
        return json.load(response)


account = api("auth/register", method="POST", status=201,
              payload={"name": "Delayed pull fixture", "email": email, "password": password})
viewer = api("auth/register", method="POST", status=201,
             payload={"name": "Viewer fixture", "email": f"viewer-{email}", "password": password})
token = account["access_token"]
note = api("notes", method="POST", status=201, token=token, payload={"title": old_title, "content": content})
note_path = f"notes/{note['id']}"
armed, held, allow_delivery, delivered, acknowledged, newer_page = (Event() for _ in range(6))
observed = {}
sync_path = "/api/compose/sync"


class Relay(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def forward(self):
        if self.path == "/api/sync/events":
            self.send_error(404)  # Exercise the periodic pull without an event stream.
            return

        body = self.rfile.read(int(self.headers.get("Content-Length", 0))) or None
        headers = {key: value for key, value in self.headers.items()
                   if key.lower() not in {"host", "connection", "accept-encoding"}}
        with closing(http.client.HTTPConnection("127.0.0.1", port, timeout=10)) as connection:
            connection.request(self.command, self.path, body=body, headers=headers)
            response = connection.getresponse()
            data = response.read()
        delay = False
        if self.path == sync_path and response.status == 200:
            request = json.loads(body)
            reply = json.loads(data)
            if request.get("changes"):
                change = request["changes"][0]
                if change.get("id") == note["id"] and change.get("title") == new_title:
                    observed["pushResult"] = reply["results"][0]
                    observed["pushAt"] = time.monotonic()
                    acknowledged.set()
            else:
                current = next((entry["note"] for entry in reply["entries"]
                                if (entry.get("note") or {}).get("id") == note["id"]), None)
                if current and current["title"] == old_title and armed.is_set() and not held.is_set():
                    delay = True
                    observed.update(heldVersion=current["version"], heldAt=time.monotonic(),
                                    heldCursor=reply["nextCursor"])
                    held.set()
                    if not allow_delivery.wait(12):
                        self.send_error(504)
                        return
                elif current and current["title"] == new_title and not newer_page.is_set():
                    observed.update(pullVersion=current["version"], pullFrom=request.get("cursor"),
                                    pullAt=time.monotonic())
                    newer_page.set()

        self.send_response(response.status)
        for key, value in response.getheaders():
            if key.lower() not in {"connection", "transfer-encoding", "content-length"}:
                self.send_header(key, value)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
            if delay:
                observed["deliveredAt"] = time.monotonic()
                delivered.set()
        except (BrokenPipeError, ConnectionResetError):
            pass

    do_GET = forward
    do_POST = forward


def start():
    shell("am", "start", "-W", "-n", f"{package}/anchor.AnchorActivity")


with ThreadingHTTPServer(("127.0.0.1", 0), Relay) as relay:
    thread = Thread(target=relay.serve_forever, daemon=True)
    thread.start()
    proxy_port = relay.server_port
    tunnel = f"tcp:{proxy_port}"
    adb("reverse", tunnel, tunnel)
    try:
        start()
        find("Sign in")
        for index, value in enumerate((f"http://127.0.0.1:{proxy_port}", email, password)):
            type_in(index, value)
        shell("input", "keyevent", "4")
        click("Sign in")
        click(old_title)
        type_in(0, new_title)
        shell("input", "keyevent", "4")
        save = center(find("Save changes"))

        armed.set()
        api(note_path + "/shares", method="POST", status=201, token=token,
            payload={"sharedWithUserId": viewer["user"]["id"], "permission": "viewer"})
        assert api(note_path, token=token)["version"] == note["version"]
        assert held.wait(18), "No older Convex page containing the shared note"
        shell("input", "tap", *save)
        assert acknowledged.wait(9), "The Compose edit was not acknowledged while the older page was held"
        assert observed["pushResult"]["status"] == "applied", observed["pushResult"]
        stored = api(note_path, token=token)
        assert stored["id"] == note["id"] and stored["version"] == note["version"] + 1
        assert stored["title"] == new_title and json.loads(stored["content"]) == json.loads(content)
        assert api(note_path, token=viewer["access_token"])["version"] == stored["version"]
        assert not delivered.is_set()
        allow_delivery.set()
        assert delivered.wait(3), "The old page did not reach the app"

        assert newer_page.wait(20), "The app did not pull the newer note"
        assert observed["heldVersion"] == note["version"]
        assert observed["pullFrom"] == observed["heldCursor"]
        assert observed["pullVersion"] == stored["version"]
        assert observed["heldAt"] < observed["pushAt"] < observed["deliveredAt"] < observed["pullAt"]
        find(new_title)

        adb("reverse", "--remove", tunnel)
        shell("am", "force-stop", package)
        start()
        click(new_title)
        find(text)
        Path(report).write_text(json.dumps({
            "noteId": note["id"],
            "heldVersion": observed["heldVersion"],
            "acknowledgedVersion": stored["version"],
            "newerPullVersion": observed["pullVersion"],
            "oldReplyDeliveredAfterNewEdit": True,
            "resumedFromDelayedPageCursor": True,
            "shareStillReadsNewVersion": True,
            "localNoteSurvivedOfflineRestart": True,
            "originalQuillContentRetained": True,
        }, indent=2) + "\n")
    finally:
        allow_delivery.set()
        if tunnel in adb("reverse", "--list").decode().split():
            adb("reverse", "--remove", tunnel)
        relay.shutdown()
