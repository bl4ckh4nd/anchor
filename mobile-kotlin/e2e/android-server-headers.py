"""Verify origin-scoped proxy headers through password login and a cold-start refresh."""
import http.client
import json
import sys
import threading
import time
import urllib.request
import uuid
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from android_test_ui import account_action, adb, center, click, find, shell, sync_notes, type_in

upstream, artifact = sys.argv[1:]
app = "com.zhfahim.anchor.compose"
header = "X-Fixture-Proxy"
value = uuid.uuid4().hex
new_value = uuid.uuid4().hex
seen = Counter()
other_seen = []
allow_refresh = threading.Event()
refresh_blocked = threading.Event()
rotated = threading.Event()
proxy_refresh_rejected = threading.Event()
force_expired_access = threading.Event()
anchor_refresh_rejected = threading.Event()
last_refresh = []
draft_title = "Proxy-rotation-draft"
email = f"headers-{uuid.uuid4().hex}@example.test"
password = f"Synthetic{uuid.uuid4().hex}"
protocol = {"Content-Type": "application/json"}
request = urllib.request.Request(
    f"http://127.0.0.1:{upstream}/api/auth/register",
    json.dumps({"name": "Headers fixture", "email": email, "password": password}).encode(),
    protocol, method="POST",
)
with urllib.request.urlopen(request, timeout=20) as response:
    assert response.status == 201
    fixture_access = json.load(response)["access_token"]


def notes():
    request = urllib.request.Request(f"http://127.0.0.1:{upstream}/api/notes",
                                     headers={"Authorization": "Bearer " + fixture_access})
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)


class Gateway(BaseHTTPRequestHandler):
    def reply(self, status, body):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def forward(self):
        if self.server is other:
            other_seen.append(self.headers.get(header) is not None)
            self.reply(404, b"{}")
            return
        valid = self.headers.get(header) == (new_value if rotated.is_set() else value)
        seen[(self.path, valid)] += 1
        if rotated.is_set() and not valid:
            if self.path == "/api/auth/refresh":
                proxy_refresh_rejected.set()
            self.reply(401, b'{"error":"Proxy credential rejected"}')
            return
        if not valid or self.path == "/api/sync/events":
            self.reply(404, b"{}")
            return
        if self.path == "/api/auth/refresh" and not allow_refresh.is_set():
            refresh_blocked.set()
            self.reply(503, b"{}")
            return
        if self.path == "/api/auth/convex-token" and force_expired_access.is_set():
            self.reply(401, b'{"code":"UNAUTHENTICATED"}')
            return
        length = int(self.headers.get("Content-Length", "0"))
        data = self.rfile.read(length) if length else None
        headers = {k: v for k, v in self.headers.items()
                   if k.lower() in ("authorization", "content-type", "x-anchor-protocol")}
        target = http.client.HTTPConnection("127.0.0.1", int(upstream), timeout=15)
        try:
            target.request(self.command, self.path, data, headers)
            with target.getresponse() as response:
                status, body = response.status, response.read()
            if self.path == "/api/auth/login" and status == 200:
                account = json.loads(body)
                account["access_token"] = "synthetic-expired-access-token"
                body = json.dumps(account).encode()
            if self.path == "/api/auth/refresh" and status == 200:
                last_refresh[:] = [json.loads(body)["refresh_token"]]
            if self.path == "/api/auth/refresh" and status == 401:
                if json.loads(body).get("code") == "INVALID_REFRESH_TOKEN":
                    anchor_refresh_rejected.set()
            self.reply(status, body)
        finally:
            target.close()

    do_POST = do_GET = forward

    def log_message(self, *_):
        pass


relay = ThreadingHTTPServer(("127.0.0.1", 0), Gateway)
other = ThreadingHTTPServer(("127.0.0.1", 0), Gateway)
for server in (relay, other):
    threading.Thread(target=server.serve_forever, daemon=True).start()
    endpoint = f"tcp:{server.server_port}"
    adb("reverse", endpoint, endpoint)
origin = f"http://127.0.0.1:{relay.server_port}"
other_origin = f"http://127.0.0.1:{other.server_port}"


def launch():
    shell("am", "start", "-W", "-n", f"{app}/anchor.AnchorActivity")


try:
    launch()
    find("Sign in")
    type_in(0, origin)
    shell("input", "keyevent", "4")
    click("Server headers")
    type_in(0, "Authorization")
    type_in(1, value)
    shell("input", "keyevent", "4")
    click("Save headers")
    find("This header name is reserved.")
    type_in(0, header)
    shell("input", "keyevent", "4")
    click("Save headers")
    find("Sign in")
    type_in(0, other_origin)
    shell("input", "keyevent", "4")
    click("Create account")
    find("Could not check registration on this server. Try again.")
    assert other_seen and not any(other_seen)
    type_in(0, origin)
    type_in(1, email)
    type_in(2, password)
    shell("input", "keyevent", "4")
    click("Sign in")
    find("New note")
    assert seen[("/api/auth/login", True)] == 1
    assert refresh_blocked.wait(15), seen
    shell("am", "force-stop", app)
    before = seen[("/api/auth/refresh", True)]
    allow_refresh.set()
    launch()
    find("New note")
    sync_notes()
    for _ in range(10):
        find("New note")
        if seen[("/api/auth/refresh", True)] > before and seen[("/api/compose/sync", True)]:
            break
    assert seen[("/api/auth/refresh", True)] > before, seen
    assert seen[("/api/compose/sync", True)], seen
    assert all(valid for (path, valid), count in seen.items()
               if count and path in ("/api/auth/login", "/api/auth/refresh", "/api/compose/sync"))
    record = adb("exec-out", "run-as", app, "cat", "no_backup/anchor-server-headers")
    assert len(record) > 29 and value.encode() not in record

    rotated.set()
    sync_notes()
    assert proxy_refresh_rejected.wait(15)
    find("Could not finish syncing notes. Try again.")
    find("New note")
    assert adb("exec-out", "run-as", app, "cat", "no_backup/anchor-session")
    click("New note")
    type_in(0, draft_title)
    shell("input", "keyevent", "4")
    click("Save note")
    find("Pending notes")
    assert all(row["title"] != draft_title for row in notes())
    account_action("Server headers")
    type_in(1, new_value)
    shell("input", "keyevent", "4")
    click("Save headers")
    find("New note")
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        stored = [row for row in notes() if row["title"] == draft_title]
        if stored:
            break
        time.sleep(0.5)
    assert len(stored) == 1
    assert seen[("/api/auth/login", True)] == 1
    updated_record = adb("exec-out", "run-as", app, "cat", "no_backup/anchor-server-headers")
    assert updated_record != record and new_value.encode() not in updated_record

    request = urllib.request.Request(f"http://127.0.0.1:{upstream}/api/auth/logout",
                                     json.dumps({"refreshToken": last_refresh[0]}).encode(),
                                     protocol, method="POST")
    with urllib.request.urlopen(request, timeout=20) as response:
        assert response.status == 200
    click("Open menu")
    sync = center(find("Sync notes"))
    force_expired_access.set()
    shell("input", "tap", *sync)
    assert anchor_refresh_rejected.wait(15)
    find("Sign in")
    shell("run-as", app, "test", "!", "-e", "no_backup/anchor-session")
    assert adb("exec-out", "run-as", app, "cat", "no_backup/anchor-server-headers") == updated_record
    Path(artifact).write_text(json.dumps({
        "reservedHeaderRejected": True, "differentPortReceivedNoHeader": True,
        "passwordLoginUsedHeader": True, "restartRefreshAndSyncUsedHeader": True,
        "storedBytesDoNotContainHeaderValue": True,
        "proxyRejectionRetainedSession": True, "rotationSentPendingDraftWithoutLogin": True,
        "genuineRevocationStillClearsSession": True,
    }, indent=2) + "\n")
finally:
    for server in (relay, other):
        adb("reverse", "--remove", f"tcp:{server.server_port}")
        server.shutdown()
        server.server_close()
