#!/usr/bin/env bash
set -euo pipefail
umask 077

binary=${1:?Pass the Convex local backend binary}
shift
if (( $# == 0 )); then
    printf 'Pass a command to run against the fixture.\n' >&2
    exit 2
fi
binary="$(cd -- "$(dirname -- "$binary")" && pwd)/$(basename -- "$binary")"
repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
scratch=$(mktemp -d)
backend=
cleanup() {
    status=$?
    if [[ -n "$backend" ]]; then
        kill "$backend" 2>/dev/null || true
        wait "$backend" 2>/dev/null || true
    fi
    rm -rf -- "$scratch"
    exit "$status"
}
trap cleanup EXIT

name=anchor_simulator
secret=$(openssl rand -hex 32)
api=http://127.0.0.1:3970
site=http://127.0.0.1:3971
export ANCHOR_COMPOSE_FIXTURE_URL="$site"
"$binary" --interface 127.0.0.1 --port 3970 --site-proxy-port 3971 \
    --instance-name "$name" --instance-secret "$secret" --disable-beacon \
    --local-storage "$scratch/storage" "$scratch/convex.sqlite3" > "$scratch/backend.log" 2>&1 &
backend=$!
for attempt in {1..60}; do
    if ! kill -0 "$backend" 2>/dev/null; then
        tail -60 "$scratch/backend.log" >&2
        exit 1
    fi
    if curl -fsS --max-time 2 "$api/version" >/dev/null 2>&1; then break; fi
    if (( attempt == 60 )); then
        tail -60 "$scratch/backend.log" >&2
        exit 1
    fi
    sleep 1
done

config="$scratch/cli.env"
key=$("$binary" keygen admin-key --instance-name "$name" --instance-secret "$secret")
printf 'CONVEX_SELF_HOSTED_URL=%s\nCONVEX_SELF_HOSTED_ADMIN_KEY=%s\n' "$api" "$key" > "$config"
(
    cd "$repo"
    export ANCHOR_TEST_ISSUER=https://anchor-e2e.invalid ANCHOR_TEST_KEY_ID=anchor-convex
    node e2e/notes.mjs keys "$scratch/fixture.pem" > "$scratch/jwks"
    cli=(node node_modules/convex/bin/main.js)
    "${cli[@]}" env set ANCHOR_AUTH_ISSUER "$ANCHOR_TEST_ISSUER" --env-file "$config"
    "${cli[@]}" env set ANCHOR_AUTH_JWKS --env-file "$config" < "$scratch/jwks"
    "${cli[@]}" env set ANCHOR_CONVEX_SIGNING_KEY --env-file "$config" < "$scratch/fixture.pem"
    openssl rand -hex 32 | "${cli[@]}" env set ANCHOR_SESSION_SECRET --env-file "$config"
    "${cli[@]}" env set ANCHOR_NATIVE_PASSWORD_AUTH true --env-file "$config"
    "${cli[@]}" env set ANCHOR_INTERNAL_CONVEX_URL "$api" --env-file "$config"
    "${cli[@]}" deploy --yes --codegen disable --env-file "$config"
)

"$@"
