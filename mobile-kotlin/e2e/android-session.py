#!/usr/bin/env python3
"""Run against the synthetic, password-only Convex fixture on ports 3708/3709."""
import argparse
import base64
import http.client
import json
import re
import sqlite3
import subprocess as sp
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from xml.etree import ElementTree as ET

parser = argparse.ArgumentParser()
parser.add_argument("port", type=int, choices=(3712, 3713, 3714, 3715))
parser.add_argument("admin_env", type=Path)
parser.add_argument("signing_key", type=Path)
parser.add_argument("output", type=Path)
parser.add_argument("--restart", action="store_true")
args = parser.parse_args()
backend = Path(__file__).resolve().parents[2] / "convex-backend"
app = "com.zhfahim.anchor.compose"
origin = f"http://127.0.0.1:{args.port}"
tunnel = f"tcp:{args.port}"
title = "Renew-" + uuid.uuid4().hex
body = "Compose renewed its session"
revoked_draft = "After-Revoke-" + uuid.uuid4().hex
blocked = threading.Event()
allow_refresh = threading.Event()
block_create = threading.Event()
exchanges, refreshes, creates = [], [], []
active_refresh = []
login_responses, logout_responses = [], []


def inspect(statement):
    return json.loads(sp.check_output([
        "node", "--env-file=" + str(args.admin_env.resolve()), "node_modules/convex/bin/main.js",
        "run", "--inline-query", statement,
    ], cwd=backend, text=True))


[email, owner] = inspect(
    'return (await ctx.db.query("accounts").collect()).filter(row => row.name === "Reader")'
    '.map(({email,id}) => [email,id]);'
)[0]


def expire(token):
    header, payload, _ = token.split(".")
    claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    claims["iat"] -= 172800
    claims["exp"] -= 172800
    encode = lambda data: base64.urlsafe_b64encode(data).rstrip(b"=")
    message = header.encode() + b"." + encode(json.dumps(claims).encode())
    signature = sp.check_output(
        ["openssl", "dgst", "-sha256", "-sign", str(args.signing_key)], input=message,
    )
    return (message + b"." + encode(signature)).decode()


class Relay(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, status, payload, mime="application/json"):
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def forward(self):
        length = int(self.headers.get("Content-Length", "0"))
        data = self.rfile.read(length) if length else None
        if self.path == "/api/auth/refresh" and not allow_refresh.is_set():
            refreshes.append(503)
            blocked.set()
            self.reply(503, b"{}")
            return
        if self.path == "/api/compose/notes" and block_create.is_set():
            self.reply(503, b"{}")
            return
        headers = {key: value for key, value in self.headers.items()
                   if key.lower() in ("authorization", "content-type")}
        target = http.client.HTTPConnection("127.0.0.1", 3709, timeout=15)
        try:
            target.request(self.command, self.path, data, headers)
            with target.getresponse() as response:
                status, payload = response.status, response.read()
                mime = response.headers.get("Content-Type", "application/json")
            if self.path == "/api/auth/login" and status == 200:
                session = json.loads(payload)
                active_refresh[:] = [session["refresh_token"]]
                login_responses.append(status)
                if len(login_responses) == 1:
                    session["access_token"] = expire(session["access_token"])
                payload = json.dumps(session).encode()
            if self.path == "/api/auth/logout":
                logout_responses.append(status)
            if self.path == "/api/auth/convex-token":
                exchanges.append(status)
            if self.path == "/api/auth/refresh":
                refreshes.append(status)
                if status == 200:
                    active_refresh[:] = [json.loads(payload)["refresh_token"]]
            if self.path == "/api/compose/notes":
                creates.append(status)
            self.reply(status, payload, mime)
        finally:
            target.close()

    do_POST = do_GET = forward


def adb(*cli):
    return sp.check_output(["adb", *cli])


def shell(*cli):
    return adb("shell", *cli)


def nodes():
    shell("uiautomator", "dump", "/data/local/tmp/anchor-renewal.xml")
    tree = ET.fromstring(shell("cat", "/data/local/tmp/anchor-renewal.xml"))
    return [node for node in tree.iter("node") if node.get("package") == app]


def tap(node):
    x1, y1, x2, y2 = map(int, re.findall(r"\d+", node.attrib["bounds"]))
    shell("input", "tap", str((x1 + x2) // 2), str((y1 + y2) // 2))


def fill(index, text):
    tap([node for node in nodes() if node.get("class") == "android.widget.EditText"][index])
    shell("input", "text", text.replace(" ", "%s"))


def label(text):
    for _ in range(10):
        for node in nodes():
            if text in (node.get("text"), node.get("content-desc")):
                return node
        time.sleep(0.25)
    raise AssertionError(f"Missing label: {text}")


def saved_notes():
    return inspect(
        'const notes = await ctx.db.query("notes").collect(); '
        f'return notes.filter(row => row.title === {json.dumps(title)})'
        '.map(({id, owner, version, content}) => ({id, owner, version, content}));'
    )


def pending_rows(title):
    with tempfile.TemporaryDirectory() as directory:
        database = Path(directory) / "anchor-drafts.db"
        for suffix in ("", "-wal"):
            result = sp.run(["adb", "exec-out", "run-as", app, "cat", f"databases/{database.name}{suffix}"],
                            capture_output=True, check=not suffix)
            if result.returncode == 0 and result.stdout:
                database.with_name(database.name + suffix).write_bytes(result.stdout)
        with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True) as snapshot:
            return snapshot.execute(
                "SELECT id, content FROM pending_notes WHERE origin = ? AND userId = ? AND title = ?",
                (origin, owner, title),
            ).fetchall()


def revoke():
    if not active_refresh:
        return
    target = http.client.HTTPConnection("127.0.0.1", 3709, timeout=15)
    try:
        target.request("POST", "/api/auth/logout", json.dumps({"refreshToken": active_refresh[0]}),
                       {"Content-Type": "application/json"})
        with target.getresponse() as response:
            assert response.status == 200
            response.read()
    finally:
        target.close()


assert tunnel not in adb("reverse", "--list").decode().split()
server = ThreadingHTTPServer(("127.0.0.1", args.port), Relay)
threading.Thread(target=server.serve_forever, daemon=True).start()
adb("reverse", tunnel, tunnel)
try:
    shell("am", "force-stop", app)
    shell("am", "start", "-W", "-n", f"{app}/anchor.AnchorActivity")
    fill(0, origin)
    fill(1, email)
    fill(2, "native-auth-fixture-password")
    shell("input", "keyevent", "4")
    tap(label("Sign in"))
    label("New note")
    fill(0, title)
    fill(1, body)
    shell("input", "keyevent", "4")
    tap(label("Save note"))
    label("Pending notes")
    [(queued_id, queued_body)] = pending_rows(title)
    assert queued_body == body
    assert not saved_notes()
    assert 401 in exchanges, exchanges
    assert blocked.wait(3), "The installed Compose build queued the draft but never attempted refresh."
    allow_refresh.set()
    for _ in range(50):
        if rows := saved_notes():
            break
        time.sleep(1)
    [note] = rows
    assert note["owner"] == owner and note["version"] == 1 and note["id"] == queued_id
    assert json.loads(note["content"]) == {"ops": [{"insert": body + "\n"}]}
    assert refreshes.count(200) == 1 and creates == [200], (refreshes, creates)
    for _ in range(10):
        if not pending_rows(title):
            break
        time.sleep(0.5)
    assert not pending_rows(title)
    if args.restart:
        adb("reverse", "--remove", tunnel)
        shell("am", "force-stop", app)
        shell("am", "start", "-W", "-n", f"{app}/anchor.AnchorActivity")
        label("New note")
        assert login_responses == [200], login_responses
        with sp.Popen(["adb", "exec-out", "run-as", app, "cat", "no_backup/anchor-session"], stdout=sp.PIPE) as job:
            encrypted = job.communicate()[0]
            assert job.returncode == 0 and len(encrypted) > 28
        assert active_refresh[0].encode() not in encrypted and owner.encode() not in encrypted
        adb("reverse", tunnel, tunnel)
    block_create.set()
    fill(0, revoked_draft)
    fill(1, body)
    shell("input", "keyevent", "4")
    tap(label("Save note"))
    label("Pending notes")
    [(retained_id, retained_body)] = pending_rows(revoked_draft)
    assert retained_body == body
    revoke()
    label("Sign in to Anchor")
    assert 401 in refreshes, refreshes
    assert pending_rows(revoked_draft) == [(retained_id, body)]
    if args.restart:
        shell("am", "force-stop", app)
        shell("am", "start", "-W", "-n", f"{app}/anchor.AnchorActivity")
        label("Sign in to Anchor")
        fill(0, origin)
        fill(1, email)
        fill(2, "native-auth-fixture-password")
        shell("input", "keyevent", "4")
        tap(label("Sign in"))
        label("New note")
        tap(label("Open menu"))
        tap(label("Account menu"))
        tap(label("Sign out"))
        label("Sign in to Anchor")
        shell("am", "force-stop", app)
        shell("am", "start", "-W", "-n", f"{app}/anchor.AnchorActivity")
        label("Sign in to Anchor")
        assert logout_responses == [200], logout_responses
        assert pending_rows(revoked_draft) == [(retained_id, body)]
    result = {"noteId": note["id"], "version": note["version"], "expiredExchange": 401,
              "refreshUnavailable": 503, "successfulRefreshes": refreshes.count(200),
              "createResponses": creates, "forcedSignInAfterRevocation": True,
              "retainedDraftAfterRevocation": retained_id, "restartedWithoutLogin": args.restart,
              "signedOutAfterRestart": args.restart}
    args.output.write_text(json.dumps(result) + "\n")
    print(json.dumps(result))
finally:
    allow_refresh.set()
    if tunnel in adb("reverse", "--list").decode().split():
        adb("reverse", "--remove", tunnel)
    shell("am", "force-stop", app)
    server.shutdown()
    revoke()
