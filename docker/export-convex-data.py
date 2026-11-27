#!/usr/bin/env python3
"""Export one read-only Anchor PostgreSQL snapshot, with optional upload files."""

import argparse
import hashlib
import json
import os
import signal
import stat
import subprocess
import tempfile
from contextlib import ExitStack
from pathlib import Path
from urllib.parse import urlsplit
from zipfile import ZIP_DEFLATED, ZipFile

TABLES = {
    "User": "users",
    "RecoveryCode": "recoveryCodes",
    "Passkey": "passkeys",
    "LoginChallenge": "loginChallenges",
    "Settings": "settings",
    "Note": "notes",
    "NoteReminder": "noteReminders",
    "NotePin": "notePins",
    "NotePosition": "notePositions",
    "NoteArchive": "noteArchives",
    "Tag": "tags",
    "NoteShare": "noteShares",
    "RefreshToken": "refreshTokens",
    "SyncState": "syncState",
    "ChangeLog": "changeLog",
    "NoteRevision": "noteRevisions",
    "NoteAttachment": "noteAttachments",
    "_NoteToTag": "noteTags",
}
BIGINT_COLUMNS = {
    "Passkey": ("counter",),
    "SyncState": ("lastSeq", "prunedThroughSeq"),
    "ChangeLog": ("seq",),
}

CHUNK_SIZE = 1024 * 1024
PROFILE_PREFIX = "/uploads/profiles/"


def expected_document_name(table):
    return f"{table}/documents.jsonl"


def path_component(value):
    if (not isinstance(value, str) or not value or value in (".", "..")
            or "/" in value or "\\" in value or any(ord(char) < 32 for char in value)):
        raise ValueError("Invalid upload path component in PostgreSQL metadata")
    return value


def profile_file(image):
    if image in (None, ""):
        return None
    if isinstance(image, str):
        if image.startswith(PROFILE_PREFIX):
            return "uploads/profiles/" + path_component(image[len(PROFILE_PREFIX):])
        url = urlsplit(image)
        if url.scheme == "https" and url.hostname and url.username is None and url.password is None:
            return None
    raise ValueError("Unsupported profile image reference")


def record_file(table, row, files):
    if table == "noteAttachments":
        directory = path_component(row["noteId"])
        name = path_component(row["storedFilename"])
        size = row["fileSize"]
        if type(size) is not int or size < 0:
            raise ValueError("Invalid attachment size in PostgreSQL metadata")
        path = f"uploads/attachments/{directory}/{name}"
        if path in files and files[path] != size:
            raise ValueError("Inconsistent attachment size for a shared file reference")
        files[path] = size
    elif table == "users" and (path := profile_file(row.get("profileImage"))) is not None:
        files[path] = None


def build_sql():
    tables = ", ".join(f"'{name}'" for name in sorted(TABLES))
    bigint_columns = ", ".join(
        f"'{table}.{column}'"
        for table, columns in sorted(BIGINT_COLUMNS.items())
        for column in sorted(columns)
    )
    yield "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;"
    yield "SET LOCAL bytea_output = 'hex';"
    yield f"""
DO $$
BEGIN
  IF (SELECT array_agg(tablename::text ORDER BY tablename COLLATE "C")
      FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> '_prisma_migrations')
      IS DISTINCT FROM ARRAY[{tables}] THEN
    RAISE EXCEPTION 'Anchor table inventory changed';
  END IF;
  IF (SELECT array_agg(field ORDER BY field COLLATE "C")
      FROM (SELECT table_name || '.' || column_name AS field
            FROM information_schema.columns
            WHERE table_schema = 'public' AND data_type = 'bigint') AS columns)
      IS DISTINCT FROM ARRAY[{bigint_columns}] THEN
    RAISE EXCEPTION 'Anchor bigint column inventory changed';
  END IF;
END $$;
"""
    for table, target in TABLES.items():
        yield f"SELECT '{target}';"
        document = "to_jsonb(t)"
        if table == "_NoteToTag":
            document = """jsonb_build_object('noteId', t."A", 'tagId', t."B")"""
        elif table in BIGINT_COLUMNS:
            fields = ", ".join(
                f"""'{column}', t."{column}"::text""" for column in BIGINT_COLUMNS[table]
            )
            document += f" || jsonb_build_object({fields})"
        yield f'SELECT {document} FROM public."{table}" AS t;'
    yield "COMMIT;"


def write_documents(archive, output, bundle=False):
    files = {}
    tables = {}
    line = output.readline()
    for target in TABLES.values():
        if line.rstrip(b"\n") != target.encode():
            raise RuntimeError(f"Expected PostgreSQL section {target}")
        with archive.open(expected_document_name(target), "w", force_zip64=True) as documents:
            digest = hashlib.sha256()
            count = 0
            line = output.readline()
            while line.startswith(b"{"):
                documents.write(line)
                if bundle:
                    count += 1
                    digest.update(line)
                    if target in ("users", "noteAttachments"):
                        record_file(target, json.loads(line), files)
                line = output.readline()
            if bundle:
                tables[target] = {"rows": count, "sha256": digest.hexdigest()}
    if line:
        raise RuntimeError("Unexpected data after last PostgreSQL section")
    return tables, files


def digest_stream(source, destination=None):
    digest = hashlib.sha256()
    size = 0
    while chunk := source.read(CHUNK_SIZE):
        digest.update(chunk)
        size += len(chunk)
        if destination is not None:
            destination.write(chunk)
    return {"size": size, "sha256": digest.hexdigest()}


def file_signature(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def write_upload(archive, uploads_dir, name, expected_size):
    parts = name.split("/")[1:]
    with ExitStack() as stack:
        directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        parent = os.open(uploads_dir, directory_flags)
        stack.callback(os.close, parent)
        for directory in parts[:-1]:
            parent = os.open(directory, directory_flags, dir_fd=parent)
            stack.callback(os.close, parent)
        flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
        with os.fdopen(os.open(parts[-1], flags, dir_fd=parent), "rb") as source:
            before = os.fstat(source.fileno())
            if not stat.S_ISREG(before.st_mode):
                raise ValueError(f"Not a regular upload file: {name}")
            if expected_size is not None and before.st_size != expected_size:
                raise ValueError(f"Attachment size does not match PostgreSQL: {name}")
            with archive.open(name, "w", force_zip64=True) as destination:
                receipt = digest_stream(source, destination)
            if (file_signature(os.fstat(source.fileno())) != file_signature(before)
                    or file_signature(os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)) != file_signature(before)
                    or receipt["size"] != before.st_size):
                raise ValueError(f"Upload changed while snapshot was being copied: {name}")
    return {"path": name, **receipt}


def verify_bundle(snapshot):
    with ZipFile(snapshot) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise ValueError("Snapshot contains duplicate ZIP members")
        for entry in archive.infolist():
            file_type = stat.S_IFMT(entry.external_attr >> 16)
            if entry.is_dir() or (entry.create_system == 3 and file_type not in (0, stat.S_IFREG)):
                raise ValueError("Snapshot contains a non-file ZIP member")
        tables = {}
        files = {}
        for table in TABLES.values():
            with archive.open(expected_document_name(table)) as documents:
                count = 0
                digest = hashlib.sha256()
                for line in documents:
                    row = json.loads(line)
                    if not isinstance(row, dict):
                        raise ValueError(f"Expected an object in snapshot table {table}")
                    record_file(table, row, files)
                    count += 1
                    digest.update(line)
                tables[table] = {"rows": count, "sha256": digest.hexdigest()}
        expected = {"manifest.json", *(expected_document_name(table) for table in tables), *files}
        if set(names) != expected:
            raise ValueError("Snapshot ZIP members do not match the PostgreSQL file references")
        receipts = []
        for name, expected_size in sorted(files.items()):
            with archive.open(name) as source:
                receipt = digest_stream(source)
            if expected_size is not None and receipt["size"] != expected_size:
                raise ValueError(f"Attachment size does not match PostgreSQL: {name}")
            receipts.append({"path": name, **receipt})
        actual = {"version": 1, "tables": tables, "files": receipts}
        if json.loads(archive.read("manifest.json")) != actual:
            raise ValueError("Snapshot content does not match its integrity manifest")
        return {"tableCount": len(tables), "fileCount": len(receipts),
                "rowCount": sum(table["rows"] for table in tables.values()),
                "fileBytes": sum(receipt["size"] for receipt in receipts)}


def export(output, psql, uploads_dir=None):
    if output.exists():
        raise FileExistsError(output)
    with tempfile.NamedTemporaryFile(dir=output.parent) as file:
        with ZipFile(file, "w", ZIP_DEFLATED) as archive, tempfile.TemporaryFile() as sql:
            sql.write("\n".join(build_sql()).encode())
            sql.seek(0)
            args = [*psql, "-XqAt", "-v", "ON_ERROR_STOP=1", "-f", "-"]
            with subprocess.Popen(args, stdin=sql, stdout=subprocess.PIPE) as process:
                try:
                    with process.stdout as documents:
                        tables, files = write_documents(archive, documents, bundle=uploads_dir is not None)
                    if process.wait():
                        raise RuntimeError("PostgreSQL snapshot failed")
                except BaseException:
                    if process.poll() is None:
                        process.terminate()
                        try:
                            process.wait(timeout=3)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait()
                    raise
            if uploads_dir is not None:
                receipts = [write_upload(archive, uploads_dir, name, size)
                            for name, size in sorted(files.items())]
                archive.writestr("manifest.json", json.dumps(
                    {"version": 1, "tables": tables, "files": receipts}, sort_keys=True,
                ) + "\n")
        file.flush()
        os.fsync(file.fileno())
        os.link(file.name, output)


def stop_export(signum, _frame):
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    raise SystemExit(128 + signum)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--uploads-dir", type=Path, help="uploads directory on a frozen legacy data snapshot")
    mode.add_argument("--verify", action="store_true", help="verify bundle membership, lengths and SHA-256 digests")
    parser.add_argument("snapshot", type=Path)
    parser.add_argument("psql", nargs=argparse.REMAINDER, help="psql command and connection options")
    args = parser.parse_args()
    if args.verify:
        if args.psql:
            parser.error("--verify does not take a psql command")
        print(json.dumps(verify_bundle(args.snapshot), sort_keys=True))
    else:
        signal.signal(signal.SIGINT, stop_export)
        signal.signal(signal.SIGTERM, stop_export)
        export(args.snapshot, args.psql or ["psql"], args.uploads_dir)


if __name__ == "__main__":
    main()
