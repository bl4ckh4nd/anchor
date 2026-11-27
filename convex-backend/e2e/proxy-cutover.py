"""Exercise a frozen NestJS-to-Convex handover through a disposable Nginx proxy."""
import base64
import hashlib
import io
import json
import os
import re
import secrets
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
import wave
from pathlib import Path

repo = Path(__file__).resolve().parents[2]
legacy_port, target_api, target_port, nginx_port, uploads, *psql = sys.argv[1:]
assert all(port.isdigit() for port in (legacy_port, target_api, target_port, nginx_port))
origins = [f"http://127.0.0.1:{port}" for port in (legacy_port, target_api, target_port, nginx_port)]
legacy, target, target_site, proxy = origins
fixture_env = Path(os.environ["ANCHOR_TEST_CONVEX_ENV"])
artifact = Path(os.environ["ANCHOR_TEST_MIGRATION_ARTIFACT"])
database = "anchor_proxy_cutover"


def call(origin, path, status, *, method="GET", token=None, data=None, route=None,
         content_type="application/json"):
    headers = {"Content-Type": content_type, "X-Anchor-Protocol": "4"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    body = json.dumps(data).encode() if data is not None and not isinstance(data, bytes) else data
    request = urllib.request.Request(origin + "/api/" + path, data=body,
                                     headers=headers, method=method)
    try:
        response = urllib.request.urlopen(request, timeout=10)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        assert response.status == status, (method, path, response.status, status)
        if route is not None:
            assert response.headers["X-Anchor-Fixture-Route"] == route
        if "application/json" in response.headers.get("Content-Type", ""):
            return json.load(response)
        return response.read()


def sql(statement):
    return subprocess.check_output([*psql, "-XqAt", "-v", "ON_ERROR_STOP=1", "-c", statement], text=True).strip()


def snapshot(token, route):
    entries = []
    cursor = None
    for _ in range(16):
        data = {"limit": 1}
        if cursor is not None:
            data["cursor"] = cursor
        page = call(proxy, "sync", 200, method="POST", token=token, route=route, data=data)
        assert not page.get("resetRequired")
        entries.extend(page["entries"])
        assert page["nextCursor"]
        if not page["hasMore"]:
            return entries, page["nextCursor"]
        assert page["nextCursor"] != cursor
        cursor = page["nextCursor"]
    raise AssertionError(f"Snapshot exceeded expected pages on {route}")


assert sql("SELECT current_database()") == database


def nginx_config(port, label, frozen):
    # Maintenance permits only exact, read-only probe routes, including HEAD.
    guard = "if ($probe = 0) { return 503; }" if frozen else ""
    return f'''
pid /tmp/anchor-nginx.pid;
error_log stderr;
events {{}}
http {{
  access_log off;
  map "$request_method:$uri" $probe {{
    default 0;
    ~^(GET|HEAD):/api/health$ 1;
    ~^(GET|HEAD):/api/notes(/[a-f0-9-]+(/attachments/[a-f0-9-]+)?)?$ 1;
  }}
  server {{
    listen 127.0.0.1:{nginx_port};
    add_header X-Anchor-Fixture-Route {label} always;
    location /api/ {{
      {guard}
      proxy_connect_timeout 2s;
      proxy_pass http://127.0.0.1:{port};
    }}
  }}
}}
'''


with tempfile.TemporaryDirectory() as scratch, socket.socket() as unavailable:
    directory = Path(scratch)
    config = directory / "nginx.conf"
    unavailable.bind(("127.0.0.1", 0))
    unavailable_port = unavailable.getsockname()[1]
    name = f"anchor-proxy-cutover-{secrets.token_hex(5)}"
    container = ["podman", "exec", name, "nginx", "-c", "/fixture/nginx.conf"]

    def worker_pids():
        output = subprocess.check_output(["podman", "exec", name, "ps", "-o", "pid,args"], text=True)
        return {line.split()[0] for line in output.splitlines() if "nginx: worker process" in line}

    def route_to(port, label, frozen, *, start=False, ready_status=200):
        new = directory / "candidate.conf"
        new.write_text(nginx_config(port, label, frozen))
        new.replace(config)
        if start:
            previous_workers = set()
            subprocess.run(["podman", "run", "-d", "--network", "host", "--name", name,
                            "-v", f"{directory}:/fixture:ro,Z", "docker.io/library/nginx:1.27-alpine",
                            "nginx", "-c", "/fixture/nginx.conf", "-g", "daemon off;"],
                           check=True, stdout=subprocess.DEVNULL)
        else:
            previous_workers = worker_pids()
            assert previous_workers, "No Nginx workers to drain"
            subprocess.run([*container, "-t"], check=True, capture_output=True)
            subprocess.run([*container, "-s", "reload"], check=True, capture_output=True)
        for _ in range(50):
            try:
                call(proxy, "health", ready_status, route=label)
                if previous_workers.isdisjoint(worker_pids()):
                    return
            except (AssertionError, KeyError, urllib.error.URLError):
                pass
            time.sleep(0.1)
        raise AssertionError(f"Proxy never reached {label}")

    credentials = {"email": "proxy-fixture@example.test", "password": "ProxyFixture2026!"}
    try:
        route_to(legacy_port, "legacy-before", False, start=True)
        account = call(proxy, "auth/register", 201, method="POST", route="legacy-before",
                       data={**credentials, "name": "Cutover fixture"})
        token = account["access_token"]
        before = call(proxy, "notes", 201, method="POST", token=token, route="legacy-before",
                      data={"title": "Existing note", "content": '{"ops":[{"insert":"Before cutover\\n"}]}'})
        note_path = "notes/" + before["id"]
        assert re.fullmatch("[a-f0-9-]+", before["id"])
        payload = io.BytesIO()
        with wave.open(payload, "wb") as wav:
            wav.setparams((1, 2, 8_000, 0, "NONE", "not compressed"))
            wav.writeframes(bytes(3200))
        attachment_bytes = payload.getvalue()
        boundary = "anchor-cutover-" + secrets.token_hex(8)
        multipart = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="Cutover.wav"\r\n'
                     "Content-Type: audio/wav\r\n\r\n").encode()
        attachment = call(proxy, note_path + "/attachments", 201, method="POST", token=token,
                          content_type=f"multipart/form-data; boundary={boundary}",
                          data=multipart + attachment_bytes + f"\r\n--{boundary}--\r\n".encode())
        assert re.fullmatch("[a-f0-9-]+", attachment["id"])
        download_path = note_path + "/attachments/" + attachment["id"]
        backup = call(proxy, "export?format=anchor", 200, token=token, route="legacy-before")
        (artifact / "legacy-backup.zip").write_bytes(backup)
        source_before = sql('SELECT row_to_json(n)::text FROM "Note" n ORDER BY id')
        source_entries, legacy_cursor = snapshot(token, "legacy-before")
        assert any(entry["entityId"] == before["id"] for entry in source_entries)
        decoded = json.loads(base64.urlsafe_b64decode(legacy_cursor + "=" * (-len(legacy_cursor) % 4)))
        assert decoded["v"] == 3 and decoded["m"] == "d"

        route_to(legacy_port, "legacy-frozen", True)
        sql(f"ALTER DATABASE {database} SET default_transaction_read_only = on")
        sql("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database()"
            " AND pid <> pg_backend_pid()")
        assert sql("SHOW default_transaction_read_only") == "on"
        rejected = subprocess.run([*psql, "-XqAt", "-v", "ON_ERROR_STOP=1", "-c",
                                   'UPDATE "Note" SET title = title WHERE false'],
                                  capture_output=True, text=True)
        assert rejected.returncode and "read-only transaction" in rejected.stderr
        assert sql('SELECT row_to_json(n)::text FROM "Note" n ORDER BY id') == source_before
        call(proxy, "notes", 503, method="POST", data={"title": "Blocked legacy write"}, token=token,
             route="legacy-frozen")
        call(proxy, "auth/oidc/initiate", 503, route="legacy-frozen")

        archive = directory / "bundle.zip"
        deploy_key = directory / "convex.key"
        key, = [line.removeprefix("CONVEX_SELF_HOSTED_ADMIN_KEY=")
                for line in fixture_env.read_text().splitlines()
                if line.startswith("CONVEX_SELF_HOSTED_ADMIN_KEY=")]
        deploy_key.write_text(key)
        deploy_key.chmod(0o600)
        subprocess.run([sys.executable, repo / "docker/export-convex-data.py", "--uploads-dir", uploads,
                        archive, *psql], check=True, stdout=subprocess.DEVNULL)
        report = json.loads(subprocess.check_output([
            sys.executable, repo / "docker/import-convex-data.py", "--origin", target,
            "--deploy-key-file", deploy_key, "--issuer", "https://anchor-e2e.invalid", archive,
        ], text=True))
        assert report["complete"] and report["counts"]["notes"] == 1

        route_to(unavailable_port, "target-failed", True, ready_status=502)
        call(proxy, note_path, 502, token=token, route="target-failed")
        call(proxy, "notes", 503, method="POST", data={"title": "Blocked during failure"}, token=token,
             route="target-failed")
        route_to(legacy_port, "legacy-rollback", True)
        restored = call(proxy, note_path, 200, token=token, route="legacy-rollback")
        assert restored["id"] == before["id"] and restored["content"] == before["content"]
        assert call(proxy, download_path, 200, token=token, route="legacy-rollback") == attachment_bytes
        call(proxy, note_path, 503, method="DELETE", token=token, route="legacy-rollback")

        target_account = call(target_site, "auth/login", 200, method="POST", data=credentials)
        assert target_account["user"]["id"] == account["user"]["id"]
        target_token = target_account["access_token"]
        route_to(target_port, "target-frozen", True)
        imported = call(proxy, note_path, 200, token=target_token, route="target-frozen")
        assert imported["id"] == restored["id"] and imported["content"] == restored["content"]
        assert imported["version"] == restored["version"]
        assert call(proxy, download_path, 200, token=target_token, route="target-frozen") == attachment_bytes
        call(proxy, "notes", 503, method="POST", data={"title": "Blocked target write"}, token=target_token,
             route="target-frozen")
        assert [note["id"] for note in call(target_site, "notes", 200, token=target_token)] == [before["id"]]

        route_to(target_port, "target-open", False)
        queued = {"type": "note", "id": str(uuid.uuid4()), "title": "Queued before cutover"}
        switched = call(proxy, "sync", 200, method="POST", route="target-open", token=target_token,
                        data={"cursor": legacy_cursor, "changes": [queued]})
        assert switched["resetRequired"] and switched["nextCursor"] is None
        assert [result["status"] for result in switched["results"]] == ["applied"]
        target_entries, target_cursor = snapshot(target_token, "target-open")
        assert target_cursor != legacy_cursor
        assert {entry["entityId"] for entry in target_entries if entry["entityType"] == "note"} == {
            before["id"], queued["id"],
        }
        attachments = next(entry["attachments"] for entry in target_entries
                           if entry["entityType"] == "attachments" and entry["entityId"] == before["id"])
        assert [item["id"] for item in attachments] == [attachment["id"]]
        assert call(target_site, f"notes/{queued['id']}", 200, token=target_token)["title"] == queued["title"]
        call(legacy, f"notes/{queued['id']}", 404, token=token)
        assert sql('SELECT row_to_json(n)::text FROM "Note" n ORDER BY id') == source_before
        assert sql("SHOW default_transaction_read_only") == "on"
        assert call(proxy, download_path, 200, token=target_token, route="target-open") == attachment_bytes
        print(json.dumps({
            "samePublicOrigin": proxy, "sourceReadOnly": True, "proxyFailureStatus": 502,
            "frozenWritesRejectedOnBothRoutes": True, "authInitiationBlockedWhileFrozen": True,
            "legacySessionWorkedDuringRollback": True, "migratedAccountAndNotePreserved": True,
            "targetOnlyWriteAfterRelease": True, "legacyRowsByteIdentical": True,
            "realLegacyCursorReset": True, "queuedWriteSurvivedCutover": True,
            "freshSnapshotContainsMigratedNoteAttachmentAndQueuedWrite": True,
            "attachmentSha256": hashlib.sha256(attachment_bytes).hexdigest(),
        }))
    finally:
        subprocess.run(["podman", "rm", "-f", name], capture_output=True)
