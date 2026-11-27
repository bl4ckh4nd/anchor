#!/usr/bin/env python3
"""Exercise the migration bundle against a disposable, migrated PostgreSQL database."""

import hashlib
import json
import os
import re
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path
from zipfile import ZipFile

psql = [*sys.argv[1:], "-XqAt", "-v", "ON_ERROR_STOP=1"]
database = subprocess.check_output([*psql, "-c", "SELECT current_database()"], text=True).strip()
assert re.fullmatch(r"anchor_bundle_fixture_[a-z0-9]+", database)
exporter = Path(__file__).resolve().parents[2] / "docker" / "export-convex-data.py"
ids = [str(uuid.uuid4()) for _ in range(3)]
owner, note, attachment = ids
avatar_name = f"{owner}-fixture.png"
attachment_name = "fixture.wav"
avatar = b"avatar fixture"
payload = (b"attachment fixture" * (50 * 1024 * 1024 // 18 + 1))[:50 * 1024 * 1024]

subprocess.run([*psql, "-c", f"""
INSERT INTO "User" ("id","email","name","profileImage","updatedAt")
VALUES ('{owner}','{owner}@example.test','Fixture owner','/uploads/profiles/{avatar_name}',now());
INSERT INTO "Note" ("id","title","userId","content","updatedAt")
VALUES ('{note}','Fixture note','{owner}',(SELECT string_agg(md5(n::text), '') FROM generate_series(1, 2048) n),now());
INSERT INTO "NoteAttachment" ("id","noteId","uploadedByUserId","type","originalFilename","storedFilename","mimeType","fileSize","updatedAt")
VALUES ('{attachment}','{note}','{owner}','audio','fixture.wav','{attachment_name}','audio/wav',{len(payload)},now());
"""], check=True)

with tempfile.TemporaryDirectory() as folder:
    root = Path(folder)
    uploads = root / "uploads"
    avatar_file = uploads / "profiles" / avatar_name
    attachment_file = uploads / "attachments" / note / attachment_name
    avatar_file.parent.mkdir(parents=True)
    attachment_file.parent.mkdir(parents=True)
    avatar_file.write_bytes(avatar)
    attachment_file.write_bytes(payload)

    def run_export(dest, expect_success=True):
        result = subprocess.run([sys.executable, exporter, "--uploads-dir", uploads, dest, *psql],
                                capture_output=True, text=True)
        assert (result.returncode == 0) == expect_success, result.stderr
        assert dest.exists() == expect_success

    def verify(dest, expect_success=True):
        result = subprocess.run([sys.executable, exporter, "--verify", dest], capture_output=True, text=True)
        assert (result.returncode == 0) == expect_success, result.stderr
        return json.loads(result.stdout) if expect_success else None

    bundle = root / "bundle.zip"
    interrupted_dir = root / "interrupted"
    interrupted_dir.mkdir()
    interrupted_bundle = interrupted_dir / "bundle.zip"
    source_pid = root / "source.pid"
    paused_source = root / "paused-source.py"
    paused_source.write_text(
        "import json, os, signal, subprocess, sys, time\n"
        "from pathlib import Path\n"
        "pid_file, psql, *args = sys.argv[1:]\n"
        "output = subprocess.check_output([*json.loads(psql), *args])\n"
        "sys.stdout.buffer.write(output)\n"
        "sys.stdout.buffer.flush()\n"
        "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
        "Path(pid_file).write_text(str(os.getpid()))\n"
        "time.sleep(120)\n"
    )
    psql_command = sys.argv[1:]
    with subprocess.Popen(
        [sys.executable, exporter, "--uploads-dir", uploads, interrupted_bundle, sys.executable,
         paused_source, source_pid, json.dumps(psql_command)],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    ) as interrupted:
        try:
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                if source_pid.exists() and any(path.stat().st_size > 0 for path in interrupted_dir.iterdir()):
                    break
                assert interrupted.poll() is None
                time.sleep(0.05)
            else:
                raise AssertionError("The PostgreSQL snapshot never reached the temporary archive")
            assert not interrupted_bundle.exists()
            interrupted.send_signal(signal.SIGTERM)
            return_code = interrupted.wait(timeout=10)
            assert not list(interrupted_dir.iterdir()), "The cancelled export left a staged archive"
            assert return_code == 128 + signal.SIGTERM
            try:
                os.kill(int(source_pid.read_text()), 0)
            except ProcessLookupError:
                pass
            else:
                raise AssertionError("The interrupted PostgreSQL source was still running")
        finally:
            if interrupted.poll() is None:
                interrupted.kill()
                interrupted.wait()
            if source_pid.exists():
                try:
                    os.kill(int(source_pid.read_text()), signal.SIGKILL)
                except ProcessLookupError:
                    pass
    run_export(interrupted_bundle)
    assert verify(interrupted_bundle)["fileCount"] == 2

    run_export(bundle)
    summary = verify(bundle)
    assert summary["fileCount"] == 2 and summary["tableCount"] == 18
    assert stat.S_IMODE(bundle.stat().st_mode) == 0o600
    with ZipFile(bundle) as archive:
        manifest = json.loads(archive.read("manifest.json"))
        rows = [json.loads(line) for line in archive.read("noteAttachments/documents.jsonl").splitlines()]
        assert any(row["id"] == attachment for row in rows)
        by_path = {row["path"]: row for row in manifest["files"]}
        for path, expected in [(f"uploads/profiles/{avatar_name}", avatar),
                               (f"uploads/attachments/{note}/{attachment_name}", payload)]:
            assert archive.read(path) == expected
            assert by_path[path]["sha256"] == hashlib.sha256(expected).hexdigest()
            assert by_path[path]["size"] == len(expected)

        tampered = root / "tampered.zip"
        with ZipFile(tampered, "w") as modified:
            for path in archive.namelist():
                modified.writestr(path, bytes(len(avatar)) if path == f"uploads/profiles/{avatar_name}" else archive.read(path))
        verify(tampered, expect_success=False)

    attachment_file.unlink()
    run_export(root / "missing.zip", expect_success=False)
    attachment_file.write_bytes(b"wrong length")
    run_export(root / "wrong-size.zip", expect_success=False)
    attachment_file.unlink()
    attachment_file.symlink_to(avatar_file)
    run_export(root / "symlink.zip", expect_success=False)
    attachment_file.unlink()
    attachment_file.write_bytes(payload)
    original_parent = attachment_file.parent
    moved_parent = original_parent.with_name("moved")
    original_parent.rename(moved_parent)
    original_parent.symlink_to(moved_parent, target_is_directory=True)
    run_export(root / "symlink-dir.zip", expect_success=False)

    legacy = root / "metadata.zip"
    subprocess.run([sys.executable, exporter, legacy, *psql], check=True)
    with ZipFile(legacy) as archive:
        assert len(archive.namelist()) == 18 and "manifest.json" not in archive.namelist()
    print(json.dumps({"snapshotMode": "bundle", **summary, "tamperDetected": True, "partialArtifacts": 0,
                      "metadataOnlyCompatible": True, "terminatedExportSourceReaped": True,
                      "terminatedExportLeftNoArchive": True, "retryAfterTerminationVerified": True}))
