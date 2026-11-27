#!/usr/bin/env bash
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ "${1:-}" != --fixture ]]; then
    artifact="$(mktemp -d /tmp/anchor-passkeys.XXXXXX)"
    export ANCHOR_TEST_PASSKEY_ARTIFACT="$artifact"
    export ANCHOR_TEST_APP_URL=http://localhost:3990
    export ANCHOR_CONVEX_API_PORT=3986 ANCHOR_CONVEX_SITE_PORT=3987
    printf 'Artifacts at %s\n' "$artifact"
    if ! bash "$root/self-hosted-contracts.sh" --native-command bash "$root/self-hosted-passkeys.sh" --fixture > "$artifact/contracts.log" 2>&1; then
        tail -60 "$artifact/contracts.log" >&2
        exit 1
    fi
    cat "$artifact/verified.json"
    exit
fi

cd -- "${ANCHOR_TEST_PASSKEY_ARTIFACT:?Missing test artifact directory}"
session="anchor-passkeys-$$"
node -e 'for (const port of [3990, 3991]) require("node:http")
    .createServer((_request, response) => response.end("<title>Anchor WebAuthn fixture</title>"))
    .listen(port, "localhost")' > origins.log 2>&1 &
site=$!
trap 'playwright-cli -s="$session" close > close.log 2>&1 || true; kill "$site" 2>/dev/null || true; wait "$site" 2>/dev/null || true' EXIT
playwright-cli -s="$session" open about:blank > open.log
kill -0 "$site"
playwright-cli -s="$session" run-code --filename="$root/passkeys.mjs" > browser.log
awk '/^### Result$/ { getline; print; exit }' browser.log > verified.json
if [[ ! -s verified.json ]]; then
    sed -n '/^### Error/,+8p' browser.log >&2
    exit 1
fi
