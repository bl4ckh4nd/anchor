import http.client
import json
import os
import socket
import sys
import threading
import time
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from android_test_ui import adb, click, find, shell, type_in

BACKEND = int(os.environ.get("ANCHOR_CONVEX_SITE_PORT", "3735"))
PACKAGE = "com.zhfahim.anchor.compose"
port = int(sys.argv[1])
output = Path(sys.argv[2])
state = {"stream": None, "connections": 0, "signals": 0, "last_signal": 0.0,
         "last_pull": 0.0, "pulls": 0, "poll_cadence": 0.0, "pull_requests": 0,
         "event_error": None, "rejected": {503: 0, 404: 0}, "reject_pulls": False, "pull_failures": 0}
started = time.monotonic()
trace = []


def record(event, **details):
    trace.append({"event": event, "elapsedSeconds": round(time.monotonic() - started, 3), **details})

class Proxy(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):
        pass

    def forward(self):
        headers = {key: value for key, value in self.headers.items() if key.lower() not in {"host", "connection", "accept-encoding"}}
        body = self.rfile.read(int(self.headers.get("Content-Length", 0))) or None
        events = self.path == "/api/sync/events"
        pull = self.path == "/api/compose/sync"
        if pull:
            state["pull_requests"] += 1
            record("pull requested")
        failure = state["event_error"] if events else 503 if pull and state["reject_pulls"] else None
        if failure:
            self.send_response(failure)
            self.send_header("Connection", "close")
            self.send_header("Content-Length", "0")
            self.end_headers()
            self.wfile.flush()
            if events:
                state["rejected"][failure] += 1
                record("SSE rejected", status=failure)
            else:
                state["pull_failures"] += 1
                record("pull rejected", status=failure)
            self.close_connection = True
            return
        upstream = http.client.HTTPConnection("127.0.0.1", BACKEND, timeout=48)
        try:
            upstream.request(self.command, self.path, body=body, headers=headers)
            reply = upstream.getresponse()
            self.send_response(reply.status)
            for name, value in reply.getheaders():
                if name.lower() not in {"connection", "transfer-encoding", "content-length"}:
                    self.send_header(name, value)
            self.send_header("Connection", "close")
            self.close_connection = True
            if events and reply.status == 200:
                state["stream"] = self.connection
                state["connections"] += 1
                self.end_headers()
                record("SSE connected")
                sync_frame = False
                while line := reply.readline():
                    if line == b"event: sync\n":
                        sync_frame = True
                    self.wfile.write(line)
                    self.wfile.flush()
                    if sync_frame and line == b"\n":
                        state["last_signal"] = time.monotonic()
                        state["signals"] += 1
                        record("SSE sync frame forwarded")
                        sync_frame = False
            else:
                data = reply.read()
                if pull:
                    record("pull response", status=reply.status)
                    if reply.status == 200:
                        finished = time.monotonic()
                        if state["last_pull"]:
                            state["poll_cadence"] = finished - state["last_pull"]
                        state["last_pull"] = finished
                        state["pulls"] += 1
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError, TimeoutError, http.client.IncompleteRead):
            pass
        finally:
            if events and state["stream"] is self.connection:
                state["stream"] = None
            upstream.close()

    do_GET = forward
    do_POST = forward
    do_PATCH = forward

def wait_for(predicate, label, seconds=12):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        result = predicate()
        if result is not None and result is not False:
            return result
        time.sleep(0.1)
    raise AssertionError(label)

def api(path, body, token=None, method="POST"):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(
        f"http://127.0.0.1:{BACKEND}/api/{path}", json.dumps(body).encode(), headers, method=method,
    )
    with urllib.request.urlopen(request, timeout=12) as reply:
        return json.load(reply)

def edit(note, title, token):
    updated = api(f"notes/{note['id']}", {"title": title}, token, "PATCH")
    assert updated["id"] == note["id"] and updated["version"] == note["version"] + 1, updated
    record("fixture edit acknowledged", version=updated["version"])
    return updated


def interrupt_events(status):
    state["event_error"] = status
    active_socket = state["stream"]
    assert active_socket is not None
    active_socket.shutdown(socket.SHUT_RDWR)
    wait_for(lambda: state["rejected"][status] > 0, f"Compose did not receive the simulated SSE {status}")

with ThreadingHTTPServer(("127.0.0.1", port), Proxy) as proxy:
    threading.Thread(target=proxy.serve_forever, daemon=True).start()
    port = proxy.server_address[1]
    tunnel = f"tcp:{port}"
    assert tunnel not in adb("reverse", "--list").decode().split()
    fixture = uuid.uuid4().hex[:8]
    email = f"android-live-{fixture}@example.test"
    password = "SyntheticSync" + fixture
    session = api("auth/register", {"name": "Android live fixture", "email": email, "password": password})
    token = session["access_token"]
    titles = [title + fixture for title in ("Initial ", "Live ", "Reconnect ", "Fallback ", "Polled after outage ", "Resumed ")]
    note = api("notes", {"title": titles[0]}, token)
    adb("reverse", tunnel, tunnel)
    try:
        shell("am", "force-stop", PACKAGE)
        shell("am", "start", "-W", "-n", f"{PACKAGE}/anchor.AnchorActivity")
        find("Sign in")
        for index, text in enumerate((f"http://127.0.0.1:{port}", email, password)):
            type_in(index, text)
        shell("input", "keyevent", "4")
        click("Sign in")
        wait_for(lambda: state["connections"] > 0, "Compose did not connect to the SSE endpoint", 12)
        first_connection = state["connections"]
        find(titles[0])

        wait_for(lambda: state["poll_cadence"] >= 8, "No regular foreground poll after SSE startup", 25)
        previous_pull = state["last_pull"]
        signals = state["signals"]
        note = edit(note, titles[1], token)
        wait_for(lambda: state["signals"] > signals, "No live sync frame for the remote edit", 6)
        wait_for(lambda: state["last_pull"] >= state["last_signal"], "No cursor pull followed the sync frame", 5)
        live_gap = state["last_pull"] - previous_pull
        assert live_gap < 8, f"The event did not advance the foreground poll: {live_gap:.2f}s"
        assert state["connections"] == first_connection, "The idle stream closed before delivering the update"
        find(titles[1])

        interrupt_events(503)
        note = edit(note, titles[2], token)
        before, connections = state["pulls"], state["connections"]
        state["event_error"] = None
        wait_for(lambda: state["connections"] > connections, "Compose did not reconnect", 12)
        wait_for(lambda: state["pulls"] > before, "Compose did not pull on reconnect", 6)
        find(titles[2])

        interrupt_events(404)
        connections, signals, polls = state["connections"], state["signals"], state["pulls"]
        note = edit(note, titles[3], token)
        wait_for(lambda: state["pulls"] > polls, "Polling stopped after SSE returned 404")
        find(titles[3])
        assert state["connections"] == connections and state["signals"] == signals

        state["reject_pulls"] = True
        wait_for(lambda: state["pull_failures"] > 0, "No cursor request during the outage")
        note = edit(note, titles[4], token)
        polls = state["pulls"]
        state["reject_pulls"] = False
        wait_for(lambda: state["pulls"] > polls, "Polling did not recover after a 503 without SSE")
        find(titles[4])
        assert state["connections"] == connections and state["signals"] == signals

        shell("input", "keyevent", "3")
        time.sleep(1)
        polls = state["pull_requests"]
        rejections = state["rejected"][404]
        edit(note, titles[5], token)
        time.sleep(11)
        assert state["pull_requests"] == polls, "Compose polled while the launcher was in the foreground"
        shell("am", "start", "-W", "-n", f"{PACKAGE}/anchor.AnchorActivity")
        wait_for(lambda: state["rejected"][404] > rejections, "No SSE check after resuming")
        find(titles[5])
        assert state["connections"] == connections
        output.write_text(json.dumps({
            "foregroundConnection": True, "liveSignal": True, "signalTriggeredPull": True, "reconnected": True,
            "originalConnectionKeptForLiveUpdate": True, "pollRecoveredAfter503WithoutSse": True,
            "recoveredTitlePainted": True, "fallbackWithoutSse": True, "backgroundPollingStopped": True,
            "resumedWithoutSse": True, "livePullGapSeconds": round(live_gap, 3),
            "connections": state["connections"], "simulatedSseStatuses": state["rejected"],
            "simulatedPoll503Count": state["pull_failures"],
        }) + "\n")
        print(output.read_text(), end="")
    finally:
        output.with_suffix(".trace.json").write_text(json.dumps(trace, indent=2) + "\n")
        adb("reverse", "--remove", tunnel)
        proxy.shutdown()
