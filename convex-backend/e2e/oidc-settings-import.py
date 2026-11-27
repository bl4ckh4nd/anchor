#!/usr/bin/env python3
"""Export and import synthetic legacy OIDC settings on disposable databases."""

import json
import os
import re
import runpy
import subprocess
import sys
import tempfile
from pathlib import Path
from zipfile import ZipFile

root = Path(__file__).resolve().parents[2]
origin, key_file, *psql = sys.argv[1:]
assert origin == "http://127.0.0.1:3736"
assert psql
database = subprocess.check_output([*psql, "-XqAtc", "select current_database()"], text=True).strip()
assert re.fullmatch(r"anchor_bundle_fixture_[a-z0-9]+", database)
issuer = "https://anchor-e2e.invalid"
expected = {
    "enabled": True,
    "providerName": "Migrated SSO",
    "issuerUrl": "https://provider.example.test/tenant",
    "clientId": "anchor-legacy-client",
    "clientSecret": "synthetic-legacy-secret",
    "disableInternalAuth": True,
}

subprocess.run([*psql, "-XqAt", "-v", "ON_ERROR_STOP=1", "-c", """
INSERT INTO "Settings" ("id", "key", "value", "updatedAt") VALUES
    ('oidc-import-1', 'oidc_enabled', 'TRUE', now()),
    ('oidc-import-2', 'oidc_provider_name', 'Migrated SSO', now()),
    ('oidc-import-3', 'oidc_issuer_url', 'https://provider.example.test/tenant', now()),
    ('oidc-import-4', 'oidc_client_id', 'anchor-legacy-client', now()),
    ('oidc-import-5', 'oidc_client_secret', 'synthetic-legacy-secret', now()),
    ('oidc-import-6', 'oidc_disable_internal_auth', 'true', now())
ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value";
"""], check=True)

with tempfile.TemporaryDirectory(prefix="anchor-oidc-source-") as temporary:
    folder = Path(temporary)
    bundle = folder / "legacy.zip"
    uploads = folder / "uploads"
    uploads.mkdir()
    subprocess.run([sys.executable, root / "docker/export-convex-data.py", "--uploads-dir", uploads, bundle, *psql], check=True)
    importer = runpy.run_path(root / "docker/import-convex-data.py")
    with ZipFile(bundle) as archive:
        batches, counts = importer["plan_import"](archive)
    assert counts.get("oidcSettings") == 1, "The PostgreSQL snapshot must produce one OIDC settings row"
    assert next(entries for table, entries, _ in batches if table == "oidcSettings") == [{"data": expected}]
    command = [sys.executable, root / "docker/import-convex-data.py", "--origin", origin,
               "--deploy-key-file", key_file, "--issuer", issuer, bundle]
    imported = json.loads(subprocess.check_output(command, text=True))
    assert imported["complete"] and imported["counts"]["oidcSettings"] == 1
    replay = json.loads(subprocess.check_output(command, text=True))
    assert replay["complete"] and replay["appliedBatches"] == 0

env = {**os.environ, "CONVEX_SELF_HOSTED_URL": origin,
       "CONVEX_SELF_HOSTED_ADMIN_KEY": Path(key_file).read_text().strip()}
query = 'const { _id, _creationTime, issuer, ...settings } = await ctx.db.query("oidcSettings").unique(); return {issuer, settings};'
saved = json.loads(subprocess.check_output(
    ["node", "node_modules/convex/bin/main.js", "run", "--inline-query", query],
    cwd=root / "convex-backend", env=env, text=True,
))
assert saved == {"issuer": issuer, "settings": expected}, "The migrated provider configuration must match"
print(json.dumps({"oidcSettings": 1, "allFieldsVerified": True, "replayAppliedBatches": 0}))
