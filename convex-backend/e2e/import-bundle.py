#!/usr/bin/env python3
"""Rehearse a verified bundle import into a fresh local Convex deployment."""

import base64
import hashlib
import json
import os
import re
import runpy
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request
import urllib.error
import uuid
from pathlib import Path
from zipfile import ZipFile

root = Path(__file__).resolve().parents[2]
origin, site, key_file, jwt_key, *psql = sys.argv[1:]
assert (origin, site) in {("http://127.0.0.1:3686", "http://127.0.0.1:3687"),
                          ("http://127.0.0.1:3703", "http://127.0.0.1:3704"),
                          ("http://127.0.0.1:3708", "http://127.0.0.1:3709"),
                          ("http://127.0.0.1:3718", "http://127.0.0.1:3719"),
                          ("http://127.0.0.1:3722", "http://127.0.0.1:3723"),
                          ("http://127.0.0.1:3726", "http://127.0.0.1:3727"), ("http://127.0.0.1:3730", "http://127.0.0.1:3731"),
                          ("http://127.0.0.1:3760", "http://127.0.0.1:3761"),
                          ("http://127.0.0.1:3986", "http://127.0.0.1:3987")}
database = subprocess.check_output([*psql, "-XqAtc", "select current_database()"], text=True).strip()
assert re.fullmatch(r"anchor_bundle_fixture_[a-z0-9]+", database)
issuer = "https://anchor-e2e.invalid"
owner, reader, outsider, note, tag, share, revoked, revision, attachment = map(str, (uuid.uuid4() for _ in range(9)))
former_reader, former_share = map(str, (uuid.uuid4() for _ in range(2)))
size = 50 * 1024 * 1024
content = '{"ops":[{"insert":"Fixture\\n"}]}'
avatar_name = f"{owner}-fixture.png"
avatar_path = f"/uploads/profiles/{avatar_name}"
avatar = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jc6kAAAAASUVORK5CYII=")
password_hash = "$2b$10$NbNssu/3q62iP5IQjRwimuHYk//tGwgWgYWq4Fzk9oxmX0zGNVJ2u"
api_token = uuid.uuid4().hex
recovery, passkey = str(uuid.uuid4()), str(uuid.uuid4())
totp_key = os.environ.get("ANCHOR_TEST_TOTP_KEY_FILE")
policy = "everyone" if origin in ("http://127.0.0.1:3726", "http://127.0.0.1:3730") else None
secret_enc, recovery_hash = "fixture.encrypted.secret", "fixture-recovery-hash"
used_at = "'2024-06-02 12:00'"
if totp_key:
    assert origin in ("http://127.0.0.1:3718", "http://127.0.0.1:3722", "http://127.0.0.1:3726", "http://127.0.0.1:3730")
    secret_enc, recovery_hash = json.loads(subprocess.check_output(["node", "-e", """
    const { readFileSync } = require("node:fs");
    const { createCipheriv, createHmac, hkdfSync, randomBytes } = require("node:crypto");
    const master = Buffer.from(readFileSync(process.argv[1], "utf8").trim(), "base64");
    const key = (name) => Buffer.from(hkdfSync("sha256", master, "", "anchor/2fa/" + name, 32));
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key("encrypt"), iv);
    const data = Buffer.concat([cipher.update(process.argv[2], "utf8"), cipher.final()]);
    process.stdout.write(JSON.stringify([
        ["v1", ...[iv, cipher.getAuthTag(), data].map(part => part.toString("base64url"))].join("."),
        createHmac("sha256", key("mac")).update("k7m29xqp3a").digest("hex"),
    ]));
    """, totp_key, base64.b32encode(b"12345678901234567890").decode()], text=True))
    used_at = "NULL"
if policy:
    subprocess.run([*psql, "-XqAt", "-v", "ON_ERROR_STOP=1", "-c",
        f"""INSERT INTO "Settings" ("id","key","value","updatedAt") VALUES ('fixture-policy','two_factor_policy','{policy}',now());"""], check=True)
subprocess.run([*psql, "-XqAt", "-v", "ON_ERROR_STOP=1", "-c", f"""
INSERT INTO "User" ("id","email","name","updatedAt") VALUES
  ('{owner}','{owner}@example.test','Owner',now()),
  ('{reader}','{reader}@example.test','Reader',now()),
  ('{former_reader}','{former_reader}@example.test','Former reader',now()),
  ('{outsider}','{outsider}@example.test','Outsider',now());
UPDATE "User" SET "profileImage"='{avatar_path}', "password"='{password_hash}',
  "apiToken"='{api_token}', "isAdmin"=true, "totpSecretEnc"='{secret_enc}',
  "totpEnabledAt"='2024-06-01 12:00', "totpLastStep"=123, "sessionsRevokedAt"='2024-06-01 13:00'
WHERE "id"='{owner}';
UPDATE "User" SET "password"='{password_hash}' WHERE "id" IN ('{reader}', '{outsider}');
UPDATE "User" SET "status"='pending', "oidcSubject"='fixture:oidc',
  "profileImage"='https://example.test/provider-avatar.webp' WHERE "id"='{outsider}';
INSERT INTO "RecoveryCode" ("id","userId","codeHash","usedAt")
VALUES ('{recovery}','{owner}','{recovery_hash}',{used_at});
INSERT INTO "Passkey" ("id","userId","credentialId","publicKey","counter","transports","name","deviceType","backedUp")
VALUES ('{passkey}','{owner}','fixture-credential',decode('00ff17','hex'),9007199254740993,ARRAY['internal'],'Fixture key','singleDevice',true);
INSERT INTO "Note" ("id","title","content","version","userId","updatedAt")
VALUES ('{note}','Imported note','{content}',7,'{owner}','2024-06-03 12:10');
INSERT INTO "NoteShare" ("id","noteId","sharedWithUserId","sharedByUserId","permission","isDeleted","updatedAt") VALUES
  ('{share}','{note}','{reader}','{owner}','editor',false,now()),
  ('{former_share}','{note}','{former_reader}','{owner}','viewer',true,'2024-06-04 09:00'),
  ('{revoked}','{note}','{outsider}','{owner}','viewer',true,now());
INSERT INTO "Tag" ("id","name","userId","updatedAt") VALUES ('{tag}','Imported tag','{reader}',now());
INSERT INTO "_NoteToTag" ("A","B") VALUES ('{note}','{tag}');
INSERT INTO "NotePin" ("noteId","userId") VALUES ('{note}','{reader}');
INSERT INTO "NoteArchive" ("noteId","userId") VALUES ('{note}','{reader}');
INSERT INTO "NotePosition" ("noteId","userId","position","updatedAt") VALUES ('{note}','{reader}','a0',now());
INSERT INTO "NoteReminder" ("noteId","userId","remindAt","recurrence","version","updatedAt")
VALUES ('{note}','{reader}','2027-01-04T09:00','weekly',3,now());
INSERT INTO "NoteRevision" ("id","noteId","version","title","content","cause","createdAt")
VALUES ('{revision}','{note}',6,'Prior title',NULL,'edit','2024-06-01 10:00');
INSERT INTO "NoteAttachment" ("id","noteId","uploadedByUserId","type","originalFilename","storedFilename","mimeType","fileSize","position","createdAt","updatedAt")
VALUES ('{attachment}','{note}','{owner}','audio','Mikrofon ä.wav','fixture.wav','audio/wav',{size},4,'2024-06-02 10:00',now());
"""], check=True)

def token(subject):
    return subprocess.check_output(["node", "-e", """
    const c = require('node:crypto'), fs = require('node:fs');
    const encode = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const iat = Math.floor(Date.now()/1000);
    const j = encode({alg:'RS256',kid:'anchor-convex'})+'.'+encode({
      iss:'https://anchor-e2e.invalid',sub:process.argv[2],aud:'anchor',iat,exp:iat+120,
    });
    process.stdout.write(j+'.'+c.sign('RSA-SHA256',Buffer.from(j),fs.readFileSync(process.argv[1])).toString('base64url'));
    """, jwt_key, subject], text=True)

def query(subject, path, args):
    request = urllib.request.Request(origin + "/api/query",
        headers={"Authorization": "Bearer " + token(subject), "Content-Type": "application/json"},
        data=json.dumps({"path": path, "args": args}).encode())
    with urllib.request.urlopen(request, timeout=15) as response:
        result = json.load(response)
        assert result["status"] == "success", path
        return result["value"]


def crash_import(script, bundle, marker, boundary):
    # Stop the real importer before it receives the already successful Convex response.
    child = """
import json, runpy, sys, time
from pathlib import Path
script, origin, key_file, issuer, bundle, marker, boundary = sys.argv[1:]
module = runpy.run_path(script)
marker = Path(marker)

def pause(receipt):
    pending = marker.with_suffix(".pending")
    pending.write_text(json.dumps({**receipt, "recordedAtUnixMs": time.time_ns() // 1_000_000}))
    pending.replace(marker)
    time.sleep(120)
    raise AssertionError("Importer was not terminated by the fixture")

class InterruptedDeployment(module["Deployment"]):
    def upload(self, url, source, size, content_type):
        storage_id = super().upload(url, source, size, content_type)
        if boundary == "upload" and content_type == "application/vnd.anchor.attachment":
            pause({"storageId": storage_id, "bytes": size})
        return storage_id

    def call(self, function, **args):
        result = super().call(function, **args)
        if boundary == "commit" and function == "apply" and args["table"] == "noteAttachments":
            pause(result)
        return result

module["migrate"](Path(bundle), InterruptedDeployment(origin, Path(key_file).read_text().strip()), issuer, None)
"""
    with subprocess.Popen([sys.executable, "-B", "-c", child, script, origin, key_file, issuer,
                           bundle, marker, boundary], stdout=subprocess.DEVNULL) as importer:
        try:
            deadline = time.monotonic() + 60
            while not marker.exists() and time.monotonic() < deadline:
                assert importer.poll() is None, (boundary, importer.returncode)
                time.sleep(0.05)
            assert marker.exists() and importer.poll() is None, boundary
            receipt = json.loads(marker.read_text())
        finally:
            if importer.poll() is None:
                importer.kill()
                importer.wait(timeout=10)
        assert importer.returncode == -signal.SIGKILL, boundary
    return receipt


with tempfile.TemporaryDirectory() as folder:
    folder = Path(folder)
    uploads = folder / "uploads"
    avatar_file = uploads / "profiles" / avatar_name
    avatar_file.parent.mkdir(parents=True)
    avatar_file.write_bytes(avatar)
    wav = uploads / "attachments" / note / "fixture.wav"
    wav.parent.mkdir(parents=True)
    block = bytes(range(256)) * 4096
    expected = hashlib.sha256()
    with wav.open("wb") as f:
        for _ in range(50):
            f.write(block)
            expected.update(block)
    bundle = folder / "bundle.zip"
    export_started = time.monotonic()
    subprocess.run([sys.executable, root / "docker/export-convex-data.py", "--uploads-dir", uploads, bundle, *psql], check=True)
    export_seconds = time.monotonic() - export_started
    script = root / "docker/import-convex-data.py"
    importer = runpy.run_path(str(script))
    with ZipFile(bundle) as archive:
        planned_batches, planned_counts = importer["plan_import"](archive)
    assert planned_counts["noteShares"] == 3, "The import plan dropped revoked shares"
    preflight = [sys.executable, script, "--preflight"]
    report = json.loads(subprocess.check_output([*preflight, bundle], text=True))
    with bundle.open("rb") as source:
        assert report["bundleSha256"] == hashlib.file_digest(source, "sha256").hexdigest()
    assert report["archiveBytes"] == bundle.stat().st_size
    assert report["importPlan"]["rowsByTable"] == planned_counts
    assert report["importPlan"]["batches"] == len(planned_batches)
    assert report["importPlan"]["mediaUploadBytes"] == len(avatar) + size
    assert report["importPlan"]["largestMediaUploadBytes"] == size
    for invalid_args, reason in [
        (["--media-free-bytes", str(size)], "known media uploads"),
        (["--origin", origin], "only takes a bundle"),
    ]:
        rejected = subprocess.run([*preflight, *invalid_args, bundle], capture_output=True, text=True)
        assert rejected.returncode != 0 and reason in rejected.stderr

    broken = folder / "invalid-reference.zip"
    with ZipFile(bundle) as valid, ZipFile(broken, "w") as output:
        manifest = json.loads(valid.read("manifest.json"))
        name = "noteRevisions/documents.jsonl"
        row = json.loads(valid.read(name))
        row["authorUserId"] = "missing-user"
        document = (json.dumps(row) + "\n").encode()
        manifest["tables"]["noteRevisions"]["sha256"] = hashlib.sha256(document).hexdigest()
        for member in valid.namelist():
            if member == name:
                output.writestr(member, document)
            elif member == "manifest.json":
                output.writestr(member, json.dumps(manifest))
            else:
                output.writestr(member, valid.read(member))
    assert importer["backup"]["verify_bundle"](broken)["fileCount"] == 2
    rejected = subprocess.run([*preflight, broken], capture_output=True, text=True)
    assert rejected.returncode != 0 and "Unknown source user reference" in rejected.stderr

    command = [sys.executable, root / "docker/import-convex-data.py", "--origin", origin,
               "--deploy-key-file", key_file, "--issuer", issuer, bundle]
    admin_env = {**os.environ, "CONVEX_SELF_HOSTED_URL": origin,
                 "CONVEX_SELF_HOSTED_ADMIN_KEY": Path(key_file).read_text().strip()}
    cli = ["node", "node_modules/convex/bin/main.js", "run"]

    def inspect(expression):
        return json.loads(subprocess.check_output([*cli, "--inline-query", expression],
                                                  cwd=root / "convex-backend", env=admin_env, text=True))

    def storage_state():
        return inspect("""
        const checkpoint = await ctx.db.query("legacyImport").unique();
        const attachments = await ctx.db.query("noteAttachments").collect();
        const storage = await ctx.db.system.query("_storage").collect();
        return {
          nextBatch: checkpoint.nextBatch, complete: checkpoint.complete,
          attachments: attachments.map(({id, storageId}) => ({id, storageId})),
          blobs: storage.map(({_id}) => _id).sort(),
        };
        """)

    def collect_orphans():
        subprocess.run([*cli, "attachments:collectOrphanUploads",
                        json.dumps({"cutoff": int(time.time() * 1000)})],
                       cwd=root / "convex-backend", env=admin_env, check=True, stdout=subprocess.DEVNULL)

    import_started = time.monotonic()
    partial = json.loads(subprocess.check_output([*command, "--stop-after", "2"], text=True))
    assert partial["complete"] is False and partial["nextBatch"] == 2
    media_batch, = [index for index, (table, _, _) in enumerate(planned_batches) if table == "noteAttachments"]
    upload = crash_import(script, bundle, folder / "upload-receipt.json", "upload")
    assert upload["bytes"] == size
    after_upload = storage_state()
    assert after_upload["nextBatch"] == media_batch and not after_upload["complete"]
    assert not after_upload["attachments"] and upload["storageId"] in after_upload["blobs"]
    collect_orphans()
    assert storage_state() == after_upload, "Collection touched an unfinished import"

    committed = crash_import(script, bundle, folder / "commit-receipt.json", "commit")
    after_commit = storage_state()
    assert committed["nextBatch"] == media_batch + 1 == after_commit["nextBatch"]
    assert not committed["complete"] and not after_commit["complete"]
    linked, = after_commit["attachments"]
    assert linked["id"] == attachment and linked["storageId"] != upload["storageId"]
    assert set(after_commit["blobs"]) - set(after_upload["blobs"]) == {linked["storageId"]}

    result = json.loads(subprocess.check_output(command, text=True))
    import_seconds = time.monotonic() - import_started
    assert result["complete"] is True
    assert result["appliedBatches"] == len(planned_batches) - committed["nextBatch"]
    after_finish = storage_state()
    assert after_finish["complete"] and after_finish["attachments"] == after_commit["attachments"]
    assert after_finish["blobs"] == after_commit["blobs"], "Resume uploaded the committed attachment again"
    collect_orphans()
    after_collection = storage_state()
    assert set(after_finish["blobs"]) - set(after_collection["blobs"]) == {upload["storageId"]}
    assert after_collection["attachments"] == after_finish["attachments"]
    repeat = json.loads(subprocess.check_output(command, text=True))
    assert repeat["complete"] is True and repeat["appliedBatches"] == 0
    assert repeat["counts"] == {"notes": 1, "tags": 1, "noteShares": 3, "noteTags": 1,
        "notePins": 1, "noteArchives": 1, "notePositions": 1, "noteReminders": 1,
        "noteRevisions": 1, "noteAttachments": 1, "accounts": 4, "profileImages": 1,
        "recoveryCodes": 1, "passkeys": 1, **({"authPolicies": 1} if policy else {})}, repeat["counts"]
    expression = """
    const rows = await ctx.db.query("accounts").collect();
    const recovery = await ctx.db.query("recoveryCodes").unique();
    const passkey = await ctx.db.query("passkeys").unique();
    return { rows, recovery, passkey };
    """
    private = inspect(expression)
    accounts = {account["id"]: account for account in private["rows"]}
    administrator = accounts[owner]
    assert administrator["isAdmin"] and administrator["passwordHash"] == password_hash
    assert administrator["apiTokenHash"] == hashlib.sha256(api_token.encode()).hexdigest()
    assert api_token not in json.dumps(private)
    assert administrator["totpSecretEnc"] == secret_enc and administrator["totpLastStep"] == 123
    assert administrator["sessionsRevokedAt"] == 1717246800000
    assert administrator["profileImage"] == avatar_path
    assert accounts[outsider]["status"] == "pending" and accounts[outsider]["oidcSubject"] == "fixture:oidc"
    assert accounts[outsider]["profileImage"] == "https://example.test/provider-avatar.webp"
    assert private["recovery"]["usedAt"] == (None if totp_key else 1717329600000)
    assert private["recovery"]["id"] == recovery and private["recovery"]["codeHash"] == recovery_hash
    assert private["passkey"]["id"] == passkey and private["passkey"]["counter"] == "9007199254740993"
    assert private["passkey"]["publicKey"] == "AP8X" and private["passkey"]["userId"] == owner
    with urllib.request.urlopen(site + avatar_path, timeout=15) as response:
        assert response.headers["Content-Type"] == "image/png"
        assert response.headers["X-Content-Type-Options"] == "nosniff"
        assert response.read() == avatar
    try:
        urllib.request.urlopen(site + "/uploads/profiles/missing.png", timeout=15)
    except urllib.error.HTTPError as failure:
        assert failure.code == 404
    else:
        raise AssertionError("missing profile image should return 404")
    public_request = urllib.request.Request(origin + "/api/query",
        headers={"Authorization": "Bearer " + token(reader), "Content-Type": "application/json"},
        data=json.dumps({"path": "profiles:findImage", "args": {"path": avatar_path}}).encode())
    try:
        with urllib.request.urlopen(public_request, timeout=15) as response:
            assert json.load(response)["status"] == "error"
    except urllib.error.HTTPError as failure:
        assert failure.code == 400 or failure.code == 560
    imported = query(reader, "notes:get", {"id": note})
    assert imported["content"] == content and imported["version"] == 7
    assert imported["permission"] == "editor" and imported["tagIds"] == [tag]
    assert imported["isPinned"] and imported["isArchived"] and imported["position"] == "a0"
    assert imported["reminder"]["version"] == 3 and imported["reminder"]["recurrence"] == "weekly"
    assert imported["attachments"][0]["id"] == attachment
    assert imported["attachments"][0]["createdAt"] == "2024-06-02T10:00:00.000Z"
    assert query(outsider, "notes:get", {"id": note}) is None
    assert query(former_reader, "notes:get", {"id": note}) is None
    history = query(reader, "notes:history", {"id": note})["revisions"]
    assert len(history) == 1 and history[0]["id"] == revision and history[0]["authorSubject"] is None
    assert query(reader, "notes:revision", {"id": note, "revisionId": revision})["title"] == "Prior title"
    download = f"{site}/api/compose/attachments?noteId={note}&attachmentId={attachment}"
    received = hashlib.sha256()
    with urllib.request.urlopen(urllib.request.Request(download, headers={"Authorization": "Bearer "+token(reader)}), timeout=60) as response:
        for chunk in iter(lambda: response.read(1024*1024), b""):
            received.update(chunk)
    assert received.digest() == expected.digest()
    if origin == "http://127.0.0.1:3760":
        def owner_request(path, body=None):
            request = urllib.request.Request(
                site + "/api/" + path,
                headers={"Authorization": "Bearer " + token(owner), "Content-Type": "application/json"},
                data=None if body is None else json.dumps(body).encode(),
            )
            with urllib.request.urlopen(request, timeout=15) as response:
                return json.load(response)
        assert [row["id"] for row in owner_request(f"notes/{note}/shares")] == [share]
        assert {row["id"] for row in owner_request("users/recent-contacts")} == {reader, former_reader}
        regranted = owner_request(f"notes/{note}/shares", {"sharedWithUserId": former_reader, "permission": "viewer"})
        assert regranted["id"] == former_share
        assert query(former_reader, "notes:get", {"id": note})["permission"] == "viewer"
    print(json.dumps({"sha256": received.hexdigest(), "bytes": size, "noteId": note,
                      "preflight": report, "insufficientMediaSpaceRejected": True,
                      "invalidReferenceRejected": True, "preflightRejectsTargetOptions": True,
                      "crashAfterUploadCheckpoint": after_upload["nextBatch"],
                      "crashAfterCommitCheckpoint": after_commit["nextBatch"],
                      "resumeAppliedBatches": result["appliedBatches"],
                      "orphanRemovedAfterFinish": True, "collectorSkippedUnfinishedImport": True,
                      "receiptsBeforeTermination": {"upload": upload, "commit": committed},
                      "committedAttachmentStorageId": linked["storageId"],
                      "storageCounts": {"afterUpload": len(after_upload["blobs"]),
                                        "afterCommit": len(after_commit["blobs"]),
                                        "afterFinish": len(after_finish["blobs"]),
                                        "afterCollection": len(after_collection["blobs"])},
                      "syntheticTimingSeconds": {"export": export_seconds, "checkpointAndResume": import_seconds},
                      "resumedAfter": 2, "repeatApplied": 0, "counts": repeat["counts"],
                      "revokedHistory": origin == "http://127.0.0.1:3760"}))
