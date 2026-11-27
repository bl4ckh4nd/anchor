#!/usr/bin/env python3
"""Exercise the Compose sign-in screens against the existing Anchor auth contract."""

import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Event, Thread

from android_test_ui import adb, click, find, shell, type_in

parser = argparse.ArgumentParser()
parser.add_argument("artifacts", type=Path)
args = parser.parse_args()
args.artifacts.mkdir(parents=True, exist_ok=True)

app = "com.zhfahim.anchor.compose"
web_opened = Event()
enrollment = {
    "twoFactorSetupRequired": True,
    "methods": {"totp": False, "passkey": True},
    "challenge": "f" * 128,
}


class Handler(BaseHTTPRequestHandler):
    def send_json(self, status, body):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(body).encode())

    def do_GET(self):
        if self.path == "/login":
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(b'<title>Anchor sign-in fixture</title>')
            web_opened.set()
        elif self.path == "/api/auth/oidc/config":
            self.send_json(200, {"enabled": False})
        elif self.path == "/api/auth/registration-mode":
            self.send_json(200, {"mode": "enabled"})
        else:
            self.send_json(404, {})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path == "/api/auth/login":
            if body["email"] == "passkey@example.test":
                self.send_json(403, {"passkeyRequired": True})
            elif body["email"] == "both@example.test":
                self.send_json(403, {**enrollment, "methods": {"totp": True, "passkey": True}})
            else:
                self.send_json(403, enrollment)
        elif self.path == "/api/auth/register":
            self.send_json(201, enrollment)
        else:
            self.send_json(404, {})


def submit(email):
    type_in(1, email)
    type_in(2, "PasskeyFixture2026")
    shell("input", "keyevent", "KEYCODE_BACK")
    click("Sign in")


def evidence(name, heading):
    find(heading)
    find("Open sign-in in browser")
    (args.artifacts / (name + ".png")).write_bytes(adb("exec-out", "screencap", "-p"))


with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
    port = server.server_port
    tunnel = f"tcp:{port}"
    Thread(target=server.serve_forever, daemon=True).start()
    adb("reverse", tunnel, tunnel)
    try:
        shell("am", "start", "-n", f"{app}/anchor.AnchorActivity")
        find("Sign in to Anchor")
        type_in(0, f"http://127.0.0.1:{port}")
        submit("passkey@example.test")
        evidence("sign-in", "Sign in with a passkey")
        click("Open sign-in in browser")
        if not web_opened.wait(2):
            for label in ("Use without an account", "Continue without an account", "No thanks"):
                try:
                    click(label)
                    break
                except AssertionError:
                    continue
        assert web_opened.wait(20), "The browser did not request /login from the selected server"
        shell("am", "start", "-n", f"{app}/anchor.AnchorActivity")
        click("Back to sign in")

        submit("enroll@example.test")
        evidence("sign-in-setup", "Set up a passkey")
        click("Back to sign in")
        click("Create account")
        find("Create an Anchor account")
        type_in(1, "Anchor")
        type_in(2, "new@example.test")
        type_in(3, "PasskeyFixture2026")
        shell("input", "keyevent", "KEYCODE_BACK")
        click("Create account")
        evidence("registration-setup", "Set up a passkey")
        click("Back to sign in")
        find("Sign in to Anchor")
        submit("both@example.test")
        find("Set up an authenticator")
        click("Back to sign in")
        find("Sign in to Anchor")
        (args.artifacts / "verified.json").write_text(json.dumps({
            "passkeyOnlySignIn": True,
            "passkeyOnlySignInEnrollment": True,
            "passkeyOnlyRegistrationEnrollment": True,
            "selectedServerLoginOpened": True,
            "returnsToSignIn": True,
            "nativeAuthenticatorPreferredWhenAvailable": True,
        }, indent=2) + "\n")
    finally:
        adb("reverse", "--remove", tunnel)
