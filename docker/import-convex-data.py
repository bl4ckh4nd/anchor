#!/usr/bin/env python3
"""Import a verified Anchor bundle into an empty Convex deployment."""

import argparse
import base64
import hashlib
import json
import os
import time
import runpy
from collections import Counter, defaultdict
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from zipfile import ZipFile

backup = runpy.run_path(Path(__file__).with_name("export-convex-data.py"))
MAX_ROW_BYTES = 900 * 1024
MAX_BATCH_BYTES = 3 * 1024 * 1024


def rows(archive, table):
    with archive.open(backup["expected_document_name"](table)) as source:
        yield from map(json.loads, source)


def index(archive, table, fields):
    result = {}
    for record in rows(archive, table):
        key = record["id"]
        if not isinstance(key, str) or not key or key in result:
            raise ValueError(f"Invalid or duplicate source ID in {table}")
        result[key] = {field: record[field] for field in fields}
    return result


def timestamp(value):
    moment = datetime.fromisoformat(value)
    start = datetime(1970, 1, 1, tzinfo=UTC)
    elapsed = (moment if moment.tzinfo else moment.replace(tzinfo=UTC)) - start
    return (elapsed.days * 86400 + elapsed.seconds) * 1000 + elapsed.microseconds // 1000


def fields(record, *names):
    return {name: record[name] for name in names}


def dates(record, *names):
    return {name: timestamp(record[name]) if record[name] is not None else None for name in names}


def avatar_type(archive, path):
    with archive.open(path) as file:
        header = file.read(12)
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if header.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if header.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if header.startswith(b"RIFF") and header[8:12] == b"WEBP":
        return "image/webp"
    raise ValueError("Unsupported profile image contents")


def encode(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode()


def plan_import(archive):
    users = index(archive, "users", ())
    notes = index(archive, "notes", ())
    tags = index(archive, "tags", ("userId",))
    revisions = index(archive, "noteRevisions", ())
    attachments = index(archive, "noteAttachments", ())
    manifest = json.loads(archive.read("manifest.json"))
    media = {record["path"]: record for record in manifest["files"]}

    def user(subject):
        if subject not in users:
            raise ValueError("Unknown source user reference")
        return subject

    def related(record, data):
        if record["noteId"] not in notes:
            raise ValueError("Unknown source note reference")
        return {"note": record["noteId"], "data": data}

    grouped_tags = defaultdict(list)
    for link in rows(archive, "noteTags"):
        if link["tagId"] not in tags or link["noteId"] not in notes:
            raise ValueError("Unknown note/tag reference")
        subject = user(tags[link["tagId"]]["userId"])
        grouped_tags[link["noteId"], subject].append(link["tagId"])

    def entries():
        fields_by_key = {
            "oidc_enabled": "enabled",
            "oidc_provider_name": "providerName",
            "oidc_issuer_url": "issuerUrl",
            "oidc_client_id": "clientId",
            "oidc_client_secret": "clientSecret",
            "oidc_disable_internal_auth": "disableInternalAuth",
        }
        oidc = {}
        for record in rows(archive, "settings"):
            if record["key"] == "user_signup":
                mode = record["value"]
                if mode not in ("disabled", "enabled", "review"):
                    raise ValueError("Unknown legacy registration mode")
                yield "registrationPolicies", {"data": {"mode": mode}}, None
            if record["key"] == "two_factor_policy":
                policy = record["value"]
                if policy not in ("optional", "admins", "everyone"):
                    raise ValueError("Unknown legacy two-factor policy")
                yield "authPolicies", {"data": {"policy": policy}}, None
            if field := fields_by_key.get(record["key"]):
                value = record["value"]
                if field in oidc or not isinstance(value, str):
                    raise ValueError("Invalid legacy OIDC setting")
                oidc[field] = value.lower() == "true" if field in ("enabled", "disableInternalAuth") else value
        if oidc:
            defaults = {"enabled": False, "providerName": "", "issuerUrl": "",
                        "clientId": "", "clientSecret": "", "disableInternalAuth": False}
            yield "oidcSettings", {"data": {**defaults, **oidc}}, None
        avatar_paths = set()
        for record in rows(archive, "users"):
            image = record["profileImage"]
            if path := backup["profile_file"](image):
                avatar_paths.add(path)
            token = record["apiToken"]
            yield "accounts", {"data": {
                **fields(record, "id", "email", "name", "status", "isAdmin", "oidcSubject",
                         "totpSecretEnc", "totpPendingSecretEnc", "totpLastStep", "twoFactorFailedAttempts"),
                **dates(record, "createdAt", "updatedAt", "totpEnabledAt", "totpLastUsedAt",
                        "twoFactorLockedUntil", "sessionsRevokedAt"),
                "profileImage": image or None, "passwordHash": record["password"],
                "apiTokenHash": hashlib.sha256(token.encode()).hexdigest() if token is not None else None,
            }}, None
        for record in rows(archive, "recoveryCodes"):
            yield "recoveryCodes", {"data": {
                **fields(record, "id", "codeHash"), **dates(record, "createdAt", "usedAt"),
                "userId": user(record["userId"]),
            }}, None
        for record in rows(archive, "passkeys"):
            public_key = record["publicKey"]
            if not isinstance(public_key, str) or not public_key.startswith("\\x"):
                raise ValueError("Invalid legacy credential public key")
            yield "passkeys", {"data": {
                **fields(record, "id", "credentialId", "counter", "transports", "name", "deviceType", "backedUp"),
                **dates(record, "createdAt", "lastUsedAt"),
                "userId": user(record["userId"]),
                "publicKey": base64.b64encode(bytes.fromhex(public_key[2:])).decode("ascii"),
            }}, None
        for path in sorted(avatar_paths):
            receipt = media[path]
            if not 0 < receipt["size"] <= 20 * 1024 * 1024:
                raise ValueError("Profile image is outside the target size contract")
            yield "profileImages", {"data": {
                "path": "/" + path, "mimeType": avatar_type(archive, path), "fileSize": receipt["size"],
            }}, receipt
        for record in rows(archive, "notes"):
            yield "notes", {"data": {
                **fields(record, "id", "title", "content", "background", "state", "version"),
                "owner": user(record["userId"]), "createdAt": timestamp(record["createdAt"]),
                "updatedAt": timestamp(record["updatedAt"]), "stateChangedAt": timestamp(record["stateChangedAt"]),
            }}, None
        for record in rows(archive, "tags"):
            yield "tags", {"data": {
                **fields(record, "id", "name", "color", "position", "version", "isDeleted"),
                "owner": user(record["userId"]), "createdAt": timestamp(record["createdAt"]),
                "updatedAt": timestamp(record["updatedAt"]),
            }}, None
        for record in rows(archive, "noteShares"):
            yield "noteShares", related(record, {
                "legacyId": record["id"], "subject": user(record["sharedWithUserId"]),
                "sharedByUserId": user(record["sharedByUserId"]), "permission": record["permission"],
                "createdAt": timestamp(record["createdAt"]), "updatedAt": timestamp(record["updatedAt"]),
                **({"isRevoked": True} if record["isDeleted"] else {}),
            }), None
        for table, keys in (("notePins", ()), ("noteArchives", ()), ("notePositions", ("position",)),
                            ("noteReminders", ("remindAt", "recurrence", "version"))):
            for record in rows(archive, table):
                yield table, related(record, {**fields(record, *keys), "subject": user(record["userId"])}), None
        # The history index orders by insertion time. Write imported revisions oldest first.
        for record in sorted(rows(archive, "noteRevisions"), key=lambda row: (timestamp(row["createdAt"]), row["id"])):
            author = record["authorUserId"]
            yield "noteRevisions", related(record, {
                **fields(record, "version", "title", "content", "cause"),
                "legacyId": record["id"], "reportedAt": timestamp(record["createdAt"]),
                "authorSubject": user(author) if author is not None else None,
            }), None
        for (note, subject), identifiers in sorted(grouped_tags.items()):
            if len(identifiers) != len(set(identifiers)):
                raise ValueError("Duplicate source note/tag relation")
            yield "noteTags", {"note": note, "data": {"subject": subject}, "tags": sorted(identifiers)}, None
        for record in rows(archive, "noteAttachments"):
            name = f"uploads/attachments/{record['noteId']}/{record['storedFilename']}"
            receipt = media[name]
            if receipt["size"] != record["fileSize"] or record["fileSize"] > 50 * 1024 * 1024:
                raise ValueError("Attachment is outside the target size contract")
            entry = related(record, {
                **fields(record, "id", "originalFilename", "mimeType", "fileSize", "position"),
                "uploadedByUserId": user(record["uploadedByUserId"]),
                "createdAt": timestamp(record["createdAt"]),
            })
            yield "noteAttachments", entry, receipt

    batches = []
    counts = Counter()
    current, pending, pending_size = None, [], 0
    for table, row, file in entries():
        counts[table] += 1
        size = len(encode(row))
        if size > MAX_ROW_BYTES:
            raise ValueError(f"Source document is too large for Convex: {table}")
        if pending and (table != current or len(pending) == 32 or pending_size + size > MAX_BATCH_BYTES or file):
            batches.append((current, pending, None))
            pending, pending_size = [], 0
        if file is not None:
            batches.append((table, [row], file))
        else:
            current = table
            pending.append(row)
            pending_size += size
    if pending:
        batches.append((current, pending, None))
    assert counts["noteRevisions"] == len(revisions) and counts["noteAttachments"] == len(attachments)
    return batches, dict(counts)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Deployment:
    def __init__(self, origin, key):
        address = urlsplit(origin)
        if (address.scheme not in ("https", "http") or not address.hostname
                or address.username or address.password or address.path not in ("", "/")
                or address.query or address.fragment
                or (address.scheme == "http" and address.hostname not in ("127.0.0.1", "::1", "localhost"))):
            raise ValueError("Use a Convex HTTPS origin or local loopback HTTP origin")
        self.origin = origin.rstrip("/")
        self.key = key
        self.opener = build_opener(NoRedirect())

    def request(self, url, data, headers, operation):
        try:
            with self.opener.open(Request(url, data=data, headers=headers, method="POST"), timeout=180) as response:
                return json.load(response)
        except HTTPError as error:
            if error.code == 560:
                code = json.load(error).get("errorData")
                if isinstance(code, str) and code.startswith("IMPORT_"):
                    raise RuntimeError(f"{operation}: {code}") from None
            raise RuntimeError(f"{operation}: HTTP {error.code}") from None

    def call(self, function, **args):
        result = self.request(self.origin + "/api/function",
                              encode({"path": f"migrations:{function}", "format": "convex_encoded_json", "args": args}),
                              {"Content-Type": "application/json", "Authorization": f"Convex {self.key}"}, function)
        if result.get("status") != "success":
            detail = result.get("errorData")
            reason = detail if isinstance(detail, str) and detail.startswith("IMPORT_") else "Convex function failed"
            raise RuntimeError(f"{function}: {reason}")
        return result["value"]

    def upload(self, url, source, size, content_type):
        address, expected = urlsplit(url), urlsplit(self.origin)
        if (address.scheme, address.netloc) != (expected.scheme, expected.netloc):
            raise ValueError("Convex upload URL is outside the configured deployment")
        result = self.request(url, source, {"Content-Type": content_type,
                                            "Content-Length": str(size)}, "file upload")
        return result["storageId"]


@contextmanager
def prepared_import(snapshot):
    started = time.monotonic()
    with snapshot.open("rb") as source:
        initial = os.fstat(source.fileno())
        digest = backup["digest_stream"](source)["sha256"]
        source.seek(0)
        source_counts = backup["verify_bundle"](source)
        with ZipFile(source) as archive:
            batches, counts = plan_import(archive)
            final = os.fstat(source.fileno())
            if (final.st_size, final.st_mtime_ns, final.st_ctime_ns) != (
                initial.st_size, initial.st_mtime_ns, initial.st_ctime_ns,
            ):
                raise ValueError("Migration bundle changed during verification")
            report = {
                "bundleSha256": digest,
                "archiveBytes": initial.st_size,
                "source": source_counts,
                "localPlanningSeconds": time.monotonic() - started,
            }
            yield archive, batches, counts, report


def preflight(snapshot, media_free_bytes):
    with prepared_import(snapshot) as (_, batches, counts, report):
        files = [file["size"] for _, _, file in batches if file is not None]
        media_bytes = sum(files)
        if media_free_bytes is not None and media_free_bytes < media_bytes:
            raise ValueError(
                f"Available media space is {media_free_bytes} bytes, below {media_bytes} bytes of known media uploads"
            )
        report["importPlan"] = {
            "rowsByTable": counts,
            "batches": len(batches),
            "mediaUploads": len(files),
            "mediaUploadBytes": media_bytes,
            "largestMediaUploadBytes": max(files, default=0),
            "mappedRowsJsonBytes": sum(len(encode(entries)) for _, entries, _ in batches),
        }
        if media_free_bytes is not None:
            report["availableMediaBytes"] = media_free_bytes
        return report


def migrate(snapshot, deployment, issuer, stop_after):
    with prepared_import(snapshot) as (archive, batches, counts, report):
        digest = report["bundleSha256"]
        version = "v2"
        for table, revision in (("authPolicies", "v3"), ("registrationPolicies", "v4"), ("oidcSettings", "v5")):
            if table in counts:
                version = revision
        if any(record["isDeleted"] for record in rows(archive, "noteShares")):
            version = "v6"
        bundle = hashlib.sha256((f"anchor-import-{version}:" + digest).encode()).hexdigest()
        state = deployment.call("begin", bundle=bundle, issuer=issuer,
                                totalBatches=len(batches), expectedCounts=counts)
        applied = 0
        for batch in range(int(state["nextBatch"]), len(batches)):
            if stop_after is not None and applied >= stop_after:
                break
            table, entries, file = batches[batch]
            if file is not None:
                url = deployment.call("upload", bundle=bundle, batch=batch)
                if url is not None:
                    kind = "profile" if table == "profileImages" else "attachment"
                    with archive.open(file["path"]) as body:
                        storage_id = deployment.upload(url, body, file["size"], "application/vnd.anchor." + kind)
                    entries[0]["blob"] = {"id": storage_id, "sha256": file["sha256"]}
            state = deployment.call("apply", bundle=bundle, batch=batch, table=table, rows=entries)
            applied += 1
        if state["nextBatch"] == len(batches):
            state = deployment.call("finish", bundle=bundle)
        return {**state, "appliedBatches": applied}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preflight", action="store_true", help="verify and plan locally without deployment access")
    parser.add_argument("--media-free-bytes", type=int, help="compare measured media volume space with planned uploads")
    parser.add_argument("--origin")
    parser.add_argument("--deploy-key-file", type=Path)
    parser.add_argument("--issuer")
    parser.add_argument("--stop-after", type=int, help="apply up to this many batches before checkpointing")
    parser.add_argument("bundle", type=Path)
    args = parser.parse_args()
    if args.preflight:
        if any(value is not None for value in (args.origin, args.deploy_key_file, args.issuer, args.stop_after)):
            parser.error("--preflight only takes a bundle and optional --media-free-bytes")
        if args.media_free_bytes is not None and args.media_free_bytes < 0:
            parser.error("--media-free-bytes must be nonnegative")
        print(json.dumps(preflight(args.bundle, args.media_free_bytes), sort_keys=True))
        return
    if args.media_free_bytes is not None:
        parser.error("--media-free-bytes requires --preflight")
    if not all((args.origin, args.deploy_key_file, args.issuer)):
        parser.error("import requires --origin, --deploy-key-file and --issuer")
    if args.stop_after is not None and args.stop_after < 0:
        parser.error("--stop-after must be nonnegative")
    deployment = Deployment(args.origin, args.deploy_key_file.read_text().strip())
    print(json.dumps(migrate(args.bundle, deployment, args.issuer, args.stop_after), sort_keys=True))


if __name__ == "__main__":
    main()
