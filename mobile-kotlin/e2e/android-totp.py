#!/usr/bin/env python3
"""Verify Android account flows against isolated Convex fixtures."""
import argparse
import base64
import hashlib
import hmac
import json
import re
import sqlite3
import struct
import subprocess as sp
import tempfile
import time
import uuid
import zlib
from pathlib import Path
from urllib.request import Request, urlopen
from xml.etree import ElementTree as ET

parser = argparse.ArgumentParser()
parser.add_argument("port", type=int, choices=(3719, 3723, 3731, 3735))
parser.add_argument("admin_env", type=Path)
parser.add_argument("output", type=Path)
parser.add_argument("--settings-key", type=Path)
modes = parser.add_mutually_exclusive_group()
modes.add_argument("--profile", action="store_true")
modes.add_argument("--profile-image", action="store_true")
modes.add_argument("--delete-account", action="store_true")
args = parser.parse_args()
backend = Path(__file__).resolve().parents[2] / "convex-backend"
app = "com.zhfahim.anchor.compose"
origin = f"http://127.0.0.1:{args.port}"
tunnel = f"tcp:{args.port}"


def inspect(query):
    return json.loads(sp.check_output([
        "node", "--env-file=" + str(args.admin_env.resolve()), "node_modules/convex/bin/main.js",
        "run", "--inline-query", query,
    ], cwd=backend, text=True))


enrollment = args.port == 3731 and args.settings_key is None
signup = args.port == 3735
assert not (args.profile or args.profile_image or args.delete_account) or signup, "Account settings tests require the signup fixture"
account = None if signup else inspect('const row = await ctx.db.query("accounts").filter(q => q.eq(q.field("name"), ' + json.dumps('Reader' if enrollment or args.settings_key else 'Owner') + ')).unique(); return {id:row.id,email:row.email};')


def adb(*cli):
    return sp.check_output(["adb", *cli])


def shell(*cli):
    return adb("shell", *cli)


def nodes(all_packages=False):
    shell("uiautomator", "dump", "/data/local/tmp/anchor-totp.xml")
    tree = ET.fromstring(shell("cat", "/data/local/tmp/anchor-totp.xml"))
    return [item for item in tree.iter("node") if all_packages or item.get("package") == app]


def find(text, attempts=10, last=False):
    for _ in range(attempts):
        matches = [node for node in nodes() if text in (node.get("text"), node.get("content-desc"))]
        if matches:
            return matches[-1 if last else 0]
        time.sleep(0.25)
    raise AssertionError(f"Missing label: {text}")


def account(text):
    tap(find("Open menu"))
    tap(find("Account menu"))
    tap(find(text))


def tap(node):
    x1, y1, x2, y2 = map(int, re.findall(r"\d+", node.attrib["bounds"]))
    shell("input", "tap", str((x1 + x2) // 2), str((y1 + y2) // 2))


def scroll_settings(to_bottom):
    width, height = map(int, re.findall(r"(\d+)x(\d+)", shell("wm", "size").decode())[-1])
    top, bottom = height // 4, height * 4 // 5
    start, end = (bottom, top) if to_bottom else (top, bottom)
    x = str(width // 2)
    shell("input", "swipe", x, str(start), x, str(end), "350")


def fill(index, text):
    field = [node for node in nodes() if node.get("class") == "android.widget.EditText"][index]
    if field.get("text") == text:
        return
    tap(field)
    shell("input", "keyevent", "123", *(["67"] * len(field.get("text", ""))))
    shell("input", "text", text.replace(" ", "%s"))


def hide_keyboard():
    if "mInputShown=true" in shell("dumpsys", "input_method").decode():
        shell("input", "keyevent", "4")


def code(step, key=b"12345678901234567890"):
    digest = hmac.new(key, step.to_bytes(8, "big"), hashlib.sha1).digest()
    offset = digest[-1] & 15
    return f"{(int.from_bytes(digest[offset:offset + 4], 'big') & 0x7fffffff) % 1_000_000:06d}"


def submit(value):
    fill(0, value)
    hide_keyboard()
    tap(find("Verify code"))


def sign_in():
    fill(0, origin)
    fill(1, account["email"])
    fill(2, "native-auth-fixture-password")
    hide_keyboard()
    tap(find("Sign in"))
    find("Set up an authenticator" if enrollment else "Verify your sign-in")


def save_note(method, require_cache=False):
    tap(find("New note"))
    title = f"Mobile-{method}-" + uuid.uuid4().hex
    fill(0, title)
    fill(1, "Signed in using two factors")
    hide_keyboard()
    tap(find("Save note"))
    query = (
        'const rows = await ctx.db.query("notes").collect(); '
        f'return rows.filter(row => row.title === {json.dumps(title)})'
        '.map(({id, owner, version, content}) => ({id, owner, version, content}));'
    )
    for _ in range(20):
        if rows := inspect(query):
            break
        time.sleep(0.5)
    [note] = rows
    assert note["owner"] == account["id"] and note["version"] == 1
    assert json.loads(note["content"]) == {"ops": [{"insert": "Signed in using two factors\n"}]}
    if require_cache:
        tap(find("Open menu"))
        tap(find("Sync notes"))
        find(title)
    account("Sign out")
    find("Sign in")
    return note["id"]


def signup_override(value=None):
    cli = ["node", "node_modules/convex/bin/main.js", "env"]
    operation = ["set", "USER_SIGNUP", value] if value else ["remove", "USER_SIGNUP"]
    sp.run([*cli, *operation, "--env-file", str(args.admin_env.resolve())],
           cwd=backend, stdout=sp.DEVNULL, check=True)


def profile_sign_in(email, password):
    fill(0, origin)
    fill(1, email)
    fill(2, password)
    hide_keyboard()
    tap(find("Sign in"))
    find("New note")


def register_fixture(email, password):
    signup_override("enabled")
    try:
        body = json.dumps({"email": email, "name": "Before", "password": password}).encode()
        with urlopen(Request(origin + "/api/auth/register", body, {"Content-Type": "application/json"}), timeout=10) as response:
            assert response.status == 201
            return json.load(response)["user"]
    finally:
        signup_override()


def verify_profile():
    email = f"profile-{uuid.uuid4().hex}@example.test"
    current = "synthetic-compose-password"
    replacement = "synthetic-compose-changed"
    user = register_fixture(email, current)
    profile_sign_in(email, current)
    account("Settings")
    find("Name")
    fill(0, "Renamed on Compose")
    hide_keyboard()
    tap(find("Save name"))
    find("Name saved.")
    snapshot = inspect(f'const row = await ctx.db.query("accounts").withIndex("by_issuer_id", q => q.eq("issuer","https://anchor-e2e.invalid").eq("id", {json.dumps(user["id"])})).unique(); return {{name:row.name}};')
    assert snapshot == {"name": "Renamed on Compose"}
    args.output.with_suffix(".png").write_bytes(adb("exec-out", "screencap", "-p"))

    fill(2, "wrong")
    fill(3, replacement)
    hide_keyboard()
    tap(find("Change password"))
    find("The current password was not accepted.")
    fill(2, current)
    hide_keyboard()
    tap(find("Change password"))
    find("Password changed.")
    tap(find("Back to notes"))
    account("Sign out")
    find("Sign in")
    profile_sign_in(email, replacement)
    account("Sign out")
    find("Sign in")
    args.output.write_text(json.dumps({"renamedAccount": user["id"], "passwordChangedAndUsedToSignIn": True}) + "\n")
    print(args.output.read_text().strip())


def verify_profile_image():
    email = f"avatar-{uuid.uuid4().hex}@example.test"
    password = "synthetic-compose-avatar"
    user = register_fixture(email, password)
    profile_sign_in(email, password)
    account("Settings")
    find("Upload a picture", attempts=3)

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    pixels = b"".join(b"\0" + bytes((35, 130, 190) if y < 32 else (238, 131, 84)) * 64 for y in range(64))
    image = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 64, 64, 8, 2, 0, 0, 0))
             + chunk(b"IDAT", zlib.compress(pixels)) + chunk(b"IEND", b""))
    filename = f"anchor-avatar-{uuid.uuid4().hex[:8]}.png"
    device_path = f"/sdcard/Download/{filename}"
    with tempfile.TemporaryDirectory() as directory:
        target = Path(directory) / filename
        target.write_bytes(image)
        adb("push", str(target), device_path)

    def click_picker(*labels):
        for node in reversed(nodes(all_packages=True)):
            description = node.get("content-desc", "")
            if node.get("package") != app and any(
                label in (node.get("text"), description) or description.startswith(label + ",")
                for label in labels
            ):
                tap(node)
                return True
        return False

    try:
        tap(find("Upload a picture"))
        if not click_picker(filename):
            click_picker("Show roots", "Root-Verzeichnis anzeigen", "Browse files in other apps")
            click_picker("Downloads", "Download")
            for _ in range(5):
                if click_picker(filename):
                    break
            else:
                raise AssertionError(f"Fixture {filename} not visible in the system picker")
        find("Profile picture")
        query = f'const user = await ctx.db.query("accounts").withIndex("by_issuer_id", q => q.eq("issuer","https://anchor-e2e.invalid").eq("id",{json.dumps(user["id"])})).unique(); return {{profileImage: user.profileImage}};'
        avatar = inspect(query)["profileImage"]
        with urlopen(origin + avatar, timeout=10) as response:
            assert response.read() == image
        args.output.with_suffix(".png").write_bytes(adb("exec-out", "screencap", "-p"))
        shell("am", "force-stop", app)
        shell("am", "start", "-W", "-n", f"{app}/anchor.AnchorActivity")
        account("Settings")
        find("Profile picture")
        tap(find("Remove"))
        find("Picture removed.")
        assert inspect(query)["profileImage"] is None
        tap(find("Back to notes"))
        account("Sign out")
        find("Sign in")
        args.output.write_text(json.dumps({"account": user["id"], "downloadMatched": True, "previewAfterRestart": True, "removed": True}) + "\n")
        print(args.output.read_text().strip())
    finally:
        dismiss_file_picker()
        shell("rm", "-f", device_path)


def dismiss_file_picker():
    for _ in range(4):
        current = next((line for line in shell("dumpsys", "window").decode().splitlines() if "mCurrentFocus=" in line), "")
        if "documentsui" not in current:
            return
        shell("input", "keyevent", "4")
        time.sleep(0.3)


def cached_notes(user_id):
    with tempfile.TemporaryDirectory() as directory:
        database = Path(directory) / "anchor-drafts.db"
        for suffix in ("", "-wal"):
            result = sp.run(["adb", "exec-out", "run-as", app, "cat", f"databases/{database.name}{suffix}"],
                            capture_output=True, check=not suffix)
            if result.returncode == 0 and result.stdout:
                database.with_name(database.name + suffix).write_bytes(result.stdout)
        with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True) as snapshot:
            return snapshot.execute(
                "SELECT id FROM cached_notes WHERE origin = ? AND userId = ?", (origin, user_id),
            ).fetchall()


def verify_deletion():
    global account
    email = f"delete-{uuid.uuid4().hex}@example.test"
    password = "synthetic-compose-deletion"
    account = register_fixture(email, password)
    profile_sign_in(email, password)
    account("Settings")
    find("Name")
    scroll_settings(to_bottom=True)
    tap(find("Delete account", last=True))
    find("Delete your account?")
    tap(find("Cancel"))
    scroll_settings(to_bottom=False)
    tap(find("Back to notes"))
    note = save_note("account-deletion", require_cache=True)
    assert (note,) in cached_notes(account["id"])
    profile_sign_in(email, password)
    account("Settings")
    find("Name")
    scroll_settings(to_bottom=True)
    tap(find("Delete account", last=True))
    find("Delete your account?")
    args.output.with_suffix(".png").write_bytes(adb("exec-out", "screencap", "-p"))
    fill(0, "wrong")
    hide_keyboard()
    tap(find("Delete account", last=True))
    find("The current password was not accepted.")
    fill(0, password)
    hide_keyboard()
    tap(find("Delete account", last=True))
    find("Account deleted.")
    assert not cached_notes(account["id"])
    stored = sp.run(["adb", "shell", "run-as", app, "test", "-e", "no_backup/anchor-session"], capture_output=True)
    assert stored.returncode == 1
    query = f'return await ctx.db.query("accounts").withIndex("by_issuer_id", q => q.eq("issuer","https://anchor-e2e.invalid").eq("id", {json.dumps(account["id"])})).unique() === null;'
    assert inspect(query)
    args.output.write_text(json.dumps({"deletedAccount": account["id"], "cachedNoteCleared": note, "sessionCleared": True}) + "\n")
    print(args.output.read_text().strip())


assert tunnel not in adb("reverse", "--list").decode().split()
adb("reverse", tunnel, tunnel)
try:
    if args.profile_image:
        dismiss_file_picker()
    shell("am", "force-stop", app)
    shell("am", "start", "-W", "-n", f"{app}/anchor.AnchorActivity")
    existing = next((node for node in nodes() if node.get("text") == "Sign out"), None)
    if existing is not None:
        tap(existing)
    find("Sign in")
    if args.delete_account:
        verify_deletion()
        raise SystemExit(0)
    if args.profile_image:
        verify_profile_image()
        raise SystemExit(0)
    if args.profile:
        verify_profile()
        raise SystemExit(0)
    if signup:
        email = "compose-review-" + uuid.uuid4().hex + "@example.test"
        fill(0, origin)
        hide_keyboard()
        tap(find("Create account"))
        find("Create an Anchor account")
        args.output.with_suffix(".png").write_bytes(adb("exec-out", "screencap", "-p"))
        fill(1, "Mobile signup")
        fill(2, email)
        fill(3, "synthetic-compose-password")
        hide_keyboard()
        tap(find("Create account"))
        find("Your account is waiting for administrator approval.")
        snapshot = inspect(f'const row = await ctx.db.query("accounts").withIndex("by_issuer_email", q => q.eq("issuer","https://anchor-e2e.invalid").eq("email", {json.dumps(email)})).unique(); return {{status:row?.status, isAdmin:row?.isAdmin}};')
        assert snapshot == {"status": "pending", "isAdmin": False}
        stored = sp.run(["adb", "shell", "run-as", app, "test", "-e", "no_backup/anchor-session"], capture_output=True)
        assert stored.returncode == 1
        signup_override("enabled")
        try:
            shell("am", "force-stop", app)
            shell("am", "start", "-W", "-n", f"{app}/anchor.AnchorActivity")
            find("Sign in")
            fill(0, origin)
            hide_keyboard()
            tap(find("Create account"))
            find("Create an Anchor account")
            fill(1, "Mobile active signup")
            active_email = "compose-active-" + uuid.uuid4().hex + "@example.test"
            fill(2, active_email)
            fill(3, "synthetic-compose-password")
            hide_keyboard()
            tap(find("Create account"))
            find("New note")
            active = inspect(f'const row = await ctx.db.query("accounts").withIndex("by_issuer_email", q => q.eq("issuer","https://anchor-e2e.invalid").eq("email", {json.dumps(active_email)})).unique(); return {{id:row.id,status:row.status}};')
            assert active["status"] == "active"
            account = active
            note = save_note("registration")
        finally:
            signup_override()
        args.output.write_text(json.dumps({"pendingAccount": True, "noStoredSessionDuringReview": True, "noteAfterRegistration": note}) + "\n")
        print(args.output.read_text().strip())
        raise SystemExit(0)
    sign_in()
    if args.settings_key:
        encrypted = inspect('return (await ctx.db.query("accounts").filter(q => q.eq(q.field("name"), "Reader")).unique()).totpSecretEnc;')
        key = base64.b32decode(sp.check_output(["node", "-e", """
            const fs = require("node:fs"), crypto = require("node:crypto");
            const master = Buffer.from(fs.readFileSync(process.argv[1], "utf8").trim(), "base64");
            const [, iv, tag, data] = process.argv[2].split(".");
            const key = crypto.hkdfSync("sha256", master, "", "anchor/2fa/encrypt", 32);
            const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
            decipher.setAuthTag(Buffer.from(tag, "base64url"));
            process.stdout.write(Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]));
        """, str(args.settings_key), encrypted], text=True))
        submit(code(int(time.time() // 30) - 1, key))
        find("New note")
        account("Two-factor authentication")
        find("Authenticator is on")
        tap(find("Generate new recovery codes"))
        fill(0, "native-auth-fixture-password")
        fill(1, code(int(time.time() // 30), key))
        hide_keyboard()
        tap(find("Generate codes"))
        find("Save your recovery codes")
        recovery_code = next(match.group(0) for node in nodes()
                             if (match := re.search(r"[a-z2-9]{5}-[a-z2-9]{5}", node.get("text") or "")))
        tap(find("I saved the codes"))
        find("Authenticator is on")
        assert not any(node.get("text") == "Turn off authenticator" for node in nodes())
        tap(find("Replace authenticator"))
        tap(find("Use a recovery code"))
        fill(0, recovery_code)
        hide_keyboard()
        tap(find("Continue"))
        replacement_key = next(node.get("text") for node in nodes()
                               if re.fullmatch(r"[A-Z2-7]{32}", node.get("text") or ""))
        assert base64.b32decode(replacement_key) != key
        submit(code(int(time.time() // 30), base64.b32decode(replacement_key)))
        find("Save your recovery codes")
        tap(find("I saved the codes"))
        find("Authenticator is on")
        tap(find("Back to notes"))
        note = save_note("settings")
        result = {"noteAfterReplacement": note, "recoveryCodesRegenerated": True, "policyRemovalUnavailable": True}
        args.output.write_text(json.dumps(result) + "\n")
        print(json.dumps(result))
    elif enrollment:
        args.output.with_suffix(".png").write_bytes(adb("exec-out", "screencap", "-p"))
        tap(find("Set up"))
        key = next(node.get("text") for node in nodes()
                   if re.fullmatch(r"[A-Z2-7]{32}", node.get("text") or ""))
        stored = sp.run(["adb", "shell", "run-as", app, "test", "-e", "no_backup/anchor-session"], capture_output=True)
        assert stored.returncode == 1
        digest = hmac.new(base64.b32decode(key), int(time.time()//30).to_bytes(8, "big"), hashlib.sha1).digest()
        offset = digest[-1] & 15
        submit(f"{(int.from_bytes(digest[offset:offset+4], 'big') & 0x7fffffff) % 1_000_000:06d}")
        find("Save your recovery codes")
        stored = sp.run(["adb", "shell", "run-as", app, "test", "-e", "no_backup/anchor-session"], capture_output=True)
        assert stored.returncode == 1
        tap(find("I saved the codes"))
        note = save_note("enrollment")
        result = {"enrollmentNote": note, "storedOnlyAfterAcknowledgement": True}
        args.output.write_text(json.dumps(result) + "\n")
        print(json.dumps(result))
    else:
        find("Authenticator code")
        args.output.with_suffix(".png").write_bytes(adb("exec-out", "screencap", "-p"))
        stored = sp.run(["adb", "shell", "run-as", app, "test", "-e", "no_backup/anchor-session"], capture_output=True)
        assert stored.returncode == 1, "A password challenge must not persist a session."
        tap(find("Use a recovery code"))
        find("Recovery code")
        tap(find("Back to sign in"))
        find("Sign in")
        sign_in()
        step = int(time.time() // 30)
        denied = next(f"{number:06d}" for number in range(100) if f"{number:06d}" not in {code(step + delta) for delta in (-1, 0, 1, 2)})
        submit(denied)
        find("The code was not accepted. Try again.")
        submit(code(int(time.time() // 30)))
        authenticator_note = save_note("authenticator")
        sign_in()
        tap(find("Use a recovery code"))
        submit("K7M29-XQP3A")
        recovery_note = save_note("recovery")
        assert inspect('return (await ctx.db.query("recoveryCodes").unique()).usedAt;') is not None
        result = {"authenticatorNote": authenticator_note, "recoveryNote": recovery_note,
                  "invalidCodeRejected": True, "cancelledChallenge": True,
                  "noStoredSessionUntilVerified": True, "recoveryCodeConsumed": True}
        args.output.write_text(json.dumps(result) + "\n")
        print(json.dumps(result))

finally:
    adb("reverse", "--remove", tunnel)
    shell("am", "force-stop", app)
