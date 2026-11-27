#!/usr/bin/env bash
set -euo pipefail
umask 077

if (( $# > 0 )); then
    if [[ "$1" != --native-command ]] || (( $# < 2 )); then
        printf 'Usage: %s [--native-command command [args...]]\n' "$0" >&2
        exit 2
    fi
    shift
fi

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
scratch="$(mktemp -d)"
export ANCHOR_CONVEX_PG_PASSWORD="$(openssl rand -hex 24)"
export ANCHOR_CONVEX_INSTANCE_SECRET="$(openssl rand -hex 32)"
export ANCHOR_CONVEX_INSTANCE_NAME=anchor_contract
export ANCHOR_CONVEX_API_PORT="${ANCHOR_CONVEX_API_PORT:-3640}"
export ANCHOR_CONVEX_SITE_PORT="${ANCHOR_CONVEX_SITE_PORT:-3641}"
compose=("${CONTAINER_ENGINE:-docker}" compose -f ../docker-compose.convex.yml -p "anchor-contract-$(openssl rand -hex 8)")
if [[ -n "${ANCHOR_TEST_RELEASE_ARTIFACT:-}" ]]; then
    compose+=(--profile release)
fi
cleanup() {
    status=$?
    trap - EXIT
    "${compose[@]}" down --volumes >/dev/null || status=1
    rm -rf -- "$scratch"
    exit "$status"
}
trap cleanup EXIT

"${compose[@]}" up -d --wait convex
api="http://127.0.0.1:$ANCHOR_CONVEX_API_PORT"
site="http://127.0.0.1:$ANCHOR_CONVEX_SITE_PORT"
key="$("${compose[@]}" exec -T convex ./generate_admin_key.sh | tail -n 1)"
[[ "$key" == *"|"* ]]
printf 'CONVEX_SELF_HOSTED_URL=%s\nCONVEX_SELF_HOSTED_ADMIN_KEY=%s\n' "$api" "$key" > "$scratch/cli.env"

export ANCHOR_TEST_ISSUER=https://anchor-e2e.invalid
export ANCHOR_TEST_KEY_ID=anchor-convex
node e2e/notes.mjs keys "$scratch/fixture.pem" > "$scratch/jwks"
cli=(node node_modules/convex/bin/main.js)
"${cli[@]}" env set ANCHOR_AUTH_ISSUER "$ANCHOR_TEST_ISSUER" --env-file "$scratch/cli.env"
"${cli[@]}" env set ANCHOR_AUTH_JWKS --env-file "$scratch/cli.env" < "$scratch/jwks"
if (( $# > 0 )); then
    export ANCHOR_TEST_CONVEX_ENV="$scratch/cli.env"
    "${cli[@]}" env set ANCHOR_CONVEX_SIGNING_KEY --env-file "$scratch/cli.env" < "$scratch/fixture.pem"
    openssl rand -hex 32 | "${cli[@]}" env set ANCHOR_SESSION_SECRET --env-file "$scratch/cli.env"
    "${cli[@]}" env set ANCHOR_NATIVE_PASSWORD_AUTH true --env-file "$scratch/cli.env"
    "${cli[@]}" env set ANCHOR_INTERNAL_CONVEX_URL http://127.0.0.1:3210 --env-file "$scratch/cli.env"
    if [[ -n "${ANCHOR_TEST_APP_URL:-}" ]]; then
        "${cli[@]}" env set APP_URL "$ANCHOR_TEST_APP_URL" --env-file "$scratch/cli.env"
    fi
fi
"${cli[@]}" deploy --yes --codegen disable --env-file "$scratch/cli.env"

if [[ -n "${ANCHOR_TEST_RELEASE_ARTIFACT:-}" ]]; then
    build=--build
    if [[ -n "${ANCHOR_CONVEX_WEB_IMAGE:-}" ]]; then
        build=--no-build
    fi
    "${compose[@]}" up -d "$build" --wait web
    "${compose[@]}" images --format json web convex > "$ANCHOR_TEST_RELEASE_ARTIFACT/images.json"
fi
if (( $# > 0 )); then
    "$@"
else
    node e2e/notes.mjs check "$scratch/fixture.pem" "$api"
    node e2e/compose-note.mjs "$site" "$scratch/fixture.pem"
    node e2e/attachments.mjs "$site" "$scratch/fixture.pem" "$api" "$scratch/cli.env"
fi
