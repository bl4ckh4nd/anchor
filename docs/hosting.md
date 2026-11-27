# Host Bordo with Docker Compose

Bordo uses TanStack Start for the Web app and Convex with Effect and
PostgreSQL for the backend. Start with a fresh deployment for a new server.
For an existing self-hosted installation, follow the
[server migration](#postgresql-and-upload-backup-for-migration) before pointing
clients at the new deployment. Personal ZIP backups use the
[library import](backups.md).

Clone the Bordo repository and run the Compose commands from its root.

```sh
git clone https://github.com/bl4ckh4nd/bordo.git
cd bordo
```

The environment variables and the mobile callback URI below use the
identifiers supported by the current server and installed clients.

1. [Start Convex and PostgreSQL](#start-convex-and-postgresql).
2. [Configure authentication and deploy the backend](#local-convex-authentication).
3. [Start the Web service](#run-web-and-compose-on-one-convex-origin).

## Start Convex and PostgreSQL

`docker-compose.convex.yml` runs the Bordo backend locally. It has its own PostgreSQL and Convex data volumes. The database is
reachable only from the Compose network. The Convex API is at
`http://127.0.0.1:3640` and HTTP actions use `http://127.0.0.1:3641`.

From the repository root, generate the local credentials once and start the stack:

```sh
if [ ! -e .env.convex.local ]; then
  (umask 077
   printf 'ANCHOR_CONVEX_PG_PASSWORD=%s\nANCHOR_CONVEX_INSTANCE_SECRET=%s\n' \
     "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > .env.convex.local)
fi
podman compose --env-file .env.convex.local -f docker-compose.convex.yml up -d --wait
curl -fsS http://127.0.0.1:3640/version
```

Use `stop` with the same Compose flags to stop your Bordo instance and retain its data.

To test the existing attachment routes against Convex, set
`ANCHOR_CONVEX_ATTACHMENT_ORIGIN` in the local NestJS process to the
Convex HTTP Actions origin, for example `http://127.0.0.1:3641`.
NestJS must use the same Convex issuer and signing key as the Compose
token exchange. The legacy client endpoints still use the
existing sign-in or API tokens. The bridge applies to all note attachment
routes and assumes the target notes already exist in Convex. Test it
with an isolated backend and matching synthetic data before changing
routing for an existing installation.

For the legacy multipart route, set Nginx to `client_max_body_size 51m`
to allow the 50 MiB file plus multipart headers. Set
`proxy_request_buffering off` and `proxy_http_version 1.1` so Nginx
forwards the request as it arrives. NestJS enforces the exact file
limit. Keep the raw Compose upload's separate 50 MiB limit.

## PostgreSQL and upload backup for migration

Use a matching PostgreSQL and uploads snapshot from the same legacy
installation. Stop legacy writers before capturing the pair so that
uploaded files cannot change between the database and filesystem reads.
Use an output directory accessible only to the backup operator.
The exporter requires the legacy database schema supported by this
checkout and rejects a mismatched table inventory. For an older
installation, restore its backup to a separate database and apply the
legacy Prisma migrations there before exporting. Use that database with
its matching uploads.

```sh
python3 docker/export-convex-data.py --uploads-dir /path/to/frozen/uploads \
  /path/to/private/bordo-migration.zip psql --dbname bordo_snapshot
python3 docker/export-convex-data.py --verify /path/to/private/bordo-migration.zip
```

The bundle stores the PostgreSQL rows, referenced attachments, local
profile images and a manifest with counts, sizes and SHA-256 digests.
The verifier checks that the members agree with the database references
and manifest. The ZIP contains private notes and authentication data.
Keep the installation's encryption and signing configuration with the
separate protected backup. The command without `--uploads-dir` produces
the previous metadata-only snapshot.

Use Ctrl+C or SIGTERM to stop a running export. Before the final ZIP
is published, the exporter closes the source command and removes its
temporary archive. After a forced kill or host failure, inspect the
private output directory for incomplete temporary files. Use
`--verify` on any completed ZIP before importing it.

## Check the import plan before cutover

Run the same ZIP verification and row mapping that the importer uses,
without connecting to Convex or supplying a deploy key.

```sh
python3 docker/import-convex-data.py --preflight /path/to/private/bordo-migration.zip
python3 docker/import-convex-data.py --preflight --media-free-bytes "$free_bytes" /path/to/private/bordo-migration.zip
```

The report includes the archive hash and size, source counts, target
counts and batches, planned media uploads and local planning time.
For the second command, set `free_bytes` to the measured available
space in bytes on the target Convex media volume. The command rejects
a value below the planned media uploads. Size PostgreSQL, its WAL,
temporary files and rollback snapshots separately. Measure the write
freeze, import, readback and proxy handover in a rehearsal with the
approved dataset to estimate the maintenance window.

Have the target deploy key and issuer ready before running the real
import. For authentication and restore, preserve the matching JWKS
and signing key, session secret, and the original TOTP encryption key
where enabled. Browser sign-in also depends on the registered public
origin and provider configuration.

## Rehearse the proxy handover

Keep the source frozen while changing the proxy route and checking the
imported data. Use an explicit allowlist for maintenance probes because
some GET routes, including OAuth initiation, can change server state.
Keep direct upstream addresses private. After reloading the proxy, wait
for the previous workers to drain before accepting the new route.
Verify the note IDs, versions,
attachment hashes, and rejection of writes through the public route.
If a probe fails, point the proxy back to the still-frozen source.
Reopen writes only after accepting the target.

## Import notes and accounts into Convex

Deploy the Bordo Convex functions to a fresh target with an empty file
store. Keep application traffic off the target while importing. Pass the
configured `ANCHOR_AUTH_ISSUER` and the path to a private file containing
the target admin key.

```sh
python3 docker/import-convex-data.py \
  --origin http://127.0.0.1:3640 \
  --deploy-key-file /path/to/private/convex-deploy.key \
  --issuer https://notes.example.com \
  /path/to/private/bordo-migration.zip
```

Keep the same ZIP, importer version and issuer for every retry. The
importer validates the ZIP, commits batches with a checkpoint and verifies
file sizes and hashes against Convex storage metadata. A completed import reports
the migrated counts. `--stop-after 2` pauses a rehearsal after two batches.
Run a single importer per target. If the process stops before a media
batch commits, its upload can occupy space until the import finishes.
Allow capacity for retries. The attachment collector skips an unfinished
import and removes eligible unlinked uploads after completion and the
grace period.

The import brings over notes, shares, tags, per-user note settings,
revisions, attachments and accounts. Revoked shares retain their IDs
and contact history with access disabled. For a bundle containing revoked
shares, start on a fresh target if its checkpoint came from an older
importer. The importer preserves password hashes,
encrypted TOTP data, recovery-code state and passkeys. Convex stores only
SHA-256 digests of existing API tokens. Legacy refresh tokens, login
challenges and change-log history stay in the protected bundle. Keep the
original TOTP encryption configuration for the auth migration. Users
sign in again through the Convex authentication endpoints after the
switch.

Local avatars retain their `/uploads/profiles/` paths. The importer
accepts PNG, JPEG, WebP and GIF files up to 20 MiB, based on their file
headers. External HTTPS profile URLs stay as account data and the
importer leaves them unfetched. The Convex Actions origin serves the
imported local images for testing. Clients switching instances rebuild
their sync snapshot.

## Local Convex authentication

Use a fresh local Convex deployment for the first start. Configure
Bordo authentication before starting the Web service. If you plan to
migrate existing accounts, finish their import before opening the Web
service to users.

In a private CLI environment file, set `CONVEX_SELF_HOSTED_URL` to
the Compose API address and `CONVEX_SELF_HOSTED_ADMIN_KEY` to the key
from `docker compose exec -T convex ./generate_admin_key.sh`. Use the
same Compose file and environment as the running stack. Set
`ANCHOR_AUTH_ISSUER` and its `ANCHOR_AUTH_JWKS` on the deployment.
The default key ID is `anchor-convex`. Use it for the matching public RSA key in the JWKS. From
`convex-backend`, supply the matching private key and a separate
32-byte session secret over standard input. Reuse the secret when
restoring sessions from a backup.

```sh
pnpm exec convex env set ANCHOR_CONVEX_SIGNING_KEY --env-file /path/to/convex-cli.env < /path/to/private/signing.pem
openssl rand -hex 32 | pnpm exec convex env set ANCHOR_SESSION_SECRET --env-file /path/to/convex-cli.env
pnpm exec convex env set ANCHOR_NATIVE_PASSWORD_AUTH true --env-file /path/to/convex-cli.env
pnpm exec convex env set ANCHOR_INTERNAL_CONVEX_URL http://127.0.0.1:3210 --env-file /path/to/convex-cli.env
pnpm exec convex deploy --yes --codegen disable --env-file /path/to/convex-cli.env
```

With the flag enabled, the Convex Actions origin handles login, refresh,
logout, account readback, display name updates, password changes, and
the Compose token exchange. Login refuses
pending accounts. To rehearse authenticator sign-in, set the original
`TOTP_ENCRYPTION_KEY` on the target using the same standard-input method.
The password response then supplies the existing two-factor challenge,
and `POST /api/auth/login/2fa` accepts an authenticator or recovery code.
Set `APP_URL` on the Convex deployment to the exact HTTPS origin users
open in their browser to enable passkeys. Keep that hostname when
migrating existing credentials. For local browser tests, use an
`http://localhost` origin with the matching port.
Repeated refresh requests during the 24-hour reuse window receive the
same successor. Logging out invalidates that session immediately.

The Convex importer preserves the legacy OpenID Connect provider
settings. Authenticated administrators can read and update them at
`/api/admin/settings/oidc`. The response includes whether a client
secret is configured. Set `APP_URL` on the deployment to display the
callback URL for its public origin. Set `OIDC_ENABLED`,
`OIDC_ISSUER_URL`, and `OIDC_CLIENT_ID` together to manage the settings
through the environment. Keep the source snapshot and Convex backup
private because they contain the provider configuration and secret.
For the Convex browser flow, register
`{APP_URL}/api/auth/oidc/callback` with the HTTPS provider. Bordo uses
PKCE, a nonce, and a browser-bound one-time exchange code. Use
`OIDC_LEGACY_ISSUER_URL` when importing accounts whose stored OIDC
subjects came from a known provider. Set it to the exact issuer that
issued those identities so the first login can attach the issuer to
each existing subject. The Compose app starts sign-in from the same
server origin and returns through
`com.zhfahim.anchor.compose://oidc/callback`. Register the HTTPS Bordo
callback with the provider for both Web and Compose.

Installed clients that use the legacy mobile OIDC exchange can sign in
through the Convex deployment when the configured provider offers token
introspection. The provider must report an active token with Bordo's
`client_id` and a subject that matches the verified UserInfo profile.
Keep the provider's issuer and client ID during an installation
migration. Providers that cannot confirm the client binding use the
current browser and Compose authorization-code flows.

Existing API tokens are imported as SHA-256 digests. The Convex API
serves token status, replacement, and revocation under
`/api/auth/api-token`. Copy the replacement token from the response
when it is generated. The token works for the migrated note detail,
active, archive and trash lists, and tag management. It also works for
creating, editing, trashing, restoring, and permanently deleting
individual notes, copying readable notes, reading and restoring note revisions, and bulk
archive, pin, tagging and trash actions.
Note sharing and the contact picker also accept those credentials.
Note attachments accept them for multipart upload, list, reorder,
download, and deletion.
The existing `/api/sync/events` endpoint signals changes to connected
Web clients. Note and attachment data continue to use the authorized
read endpoints.
`POST /api/sync` accepts the existing Flutter protocols advertised
by `GET /api/health`. A cursor from the PostgreSQL server triggers a
fresh snapshot after applying the pending changes in that request.

Multipart uploads use a Convex Node action to parse the file. Set
`ANCHOR_INTERNAL_CONVEX_URL` in the Convex deployment environment if
its canonical storage URLs cannot be reached from the Node runtime.
Use `http://127.0.0.1:3210` for the single-container local Compose
deployment. The reverse proxy must allow multipart overhead above
the 50 MiB file limit. The Web proxy allows 51 MiB.

## Rotate the Convex signing key

Add the new public RSA key to the configured JWKS with a distinct
`kid`, alongside the current key. If the JWKS is in
`ANCHOR_AUTH_JWKS` as a data URL, update that value and deploy the
Convex functions before switching the signer.

Apply the new private key and its matching
`ANCHOR_CONVEX_SIGNING_KEY_ID` together with
the following command, using the same CLI environment file as the deployment.

```sh
pnpm exec convex env set --force --from-file /path/to/private/signer.env --env-file /path/to/convex-cli.env
```

Keep the file private. It contains `ANCHOR_CONVEX_SIGNING_KEY`
and `ANCHOR_CONVEX_SIGNING_KEY_ID`. Preserve
`ANCHOR_SESSION_SECRET` so that existing refresh sessions can
continue. Verify that an existing session refreshes with the
new key ID and that the previous access token still works.

Keep both public keys available for at least the 15-minute
access-token lifetime after the signer switches. Then remove
the retired public key and redeploy if using an inline JWKS.
[Convex custom JWT configuration](https://docs.convex.dev/auth/advanced/custom-jwt)

## Run Web and Compose on one Convex origin

Once the Convex deployment has the Bordo functions and authentication
settings, build and start the release Web service from the repository root.

```sh
podman compose --env-file .env.convex.local -f docker-compose.convex.yml --profile release up -d --build --wait
curl -fsS http://127.0.0.1:3000/api/health
```

Tagged releases build a separate GHCR image named
`<owner>/<repository>-web` for the Convex frontend. To deploy that image,
check out the same release for the Convex functions and Compose file.
Set `ANCHOR_CONVEX_WEB_IMAGE` to the matching image tag or digest, then
pull it and start the stack with `--no-build` in place of `--build`.
The release workflow also builds a single-container image for installations
that still use the previous backend.

Open `http://127.0.0.1:3000` in the browser. Use the same origin as
the server address in a local Compose test with loopback forwarding.
The Web service forwards `/api` and `/uploads` to Convex over the
Compose network. The published port defaults to loopback. Set
`ANCHOR_CONVEX_WEB_PORT` to change the port.

For a deployment behind HTTPS, point the reverse proxy at port 3000
and set `APP_URL` on Convex to the public HTTPS origin. Web and Compose
should use that public address. Use the same Compose flags with
`stop` to stop the services and keep their volumes.

The isolated release test requires the Convex dependencies and
Playwright CLI. It starts its own Compose project and removes those
test volumes on exit.

```sh
CONTAINER_ENGINE=podman ANCHOR_CONVEX_WEB_PORT=3985 \
  bash convex-backend/e2e/self-hosted-release.sh
```

With an API 35 emulator SDK and the Compose debug APK built, set
`ANCHOR_TEST_RELEASE_ANDROID=1` to run the Android app against that
same release URL during the test.

## Convex backup and restore

Run the pinned Convex CLI against the source deployment and save the
snapshot in a private directory. Keep the build and deployment
configuration with the backup. The snapshot contains table data
and can include file storage. Convex documents the snapshot scope.
[Convex backup and restore](https://docs.convex.dev/database/backup-restore)

For a cutover rehearsal, stop application writes while you capture the
snapshot you intend to restore. Prepare a separate fresh Convex project
with the same functions and the signing settings needed by the saved
sessions. Preserve the issuer, JWKS, signer and key ID, session secret
and, where used, the TOTP encryption key and provider configuration.

```sh
pnpm exec convex export --include-file-storage --path /path/to/private/convex.zip --env-file /path/to/source-cli.env
pnpm exec convex import --env-file /path/to/restore-cli.env /path/to/private/convex.zip
```

Verify note versions, file hashes, share visibility and sync cursors on
the restore target before reopening writes. For recovery after cutover,
capture the current Convex data before proceeding. An older snapshot
can omit acknowledged edits, uploaded files and access revocations.

The local regression test restores snapshots from both sides of a
synthetic write window in separate disposable Compose projects. It
checks the restored data through Bordo's HTTP APIs.

```sh
CONTAINER_ENGINE=podman ANCHOR_CONVEX_API_PORT=3986 ANCHOR_CONVEX_SITE_PORT=3987 \
  bash convex-backend/e2e/self-hosted-contracts.sh --native-command node e2e/restore-current.mjs
```

## Fresh local cutover database

For a fresh database alongside the rehearsal stack, create
`.env.convex.fresh.local` with its own random PostgreSQL password and instance
secret using the same generation steps above. Add these settings:

```dotenv
ANCHOR_CONVEX_INSTANCE_NAME=bordo_convex_fresh
ANCHOR_CONVEX_API_PORT=3660
ANCHOR_CONVEX_SITE_PORT=3661
```

Start it under a separate Compose project so both volumes are new:

```sh
podman compose -p bordo-convex-fresh --env-file .env.convex.fresh.local -f docker-compose.convex.yml up -d --wait
curl -fsS http://127.0.0.1:3660/version
```
