#!/usr/bin/env bash
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ "${1:-}" != --fixture ]]; then
    artifact="$(mktemp -d /tmp/anchor-convex-release.XXXXXX)"
    export ANCHOR_TEST_RELEASE_ARTIFACT="$artifact"
    export ANCHOR_CONVEX_API_PORT="${ANCHOR_CONVEX_API_PORT:-3986}"
    export ANCHOR_CONVEX_SITE_PORT="${ANCHOR_CONVEX_SITE_PORT:-3987}"
    export ANCHOR_CONVEX_WEB_PORT="${ANCHOR_CONVEX_WEB_PORT:-3735}"
    printf 'Artifacts at %s\n' "$artifact"
    if ! bash "$root/self-hosted-contracts.sh" --native-command bash "$root/self-hosted-release.sh" --fixture > "$artifact/stack.log" 2>&1; then
        tail -60 "$artifact/stack.log" >&2
        exit 1
    fi
    cat "$artifact/verified.json"
    exit
fi

artifact="${ANCHOR_TEST_RELEASE_ARTIFACT:?Missing test artifact directory}"
origin="http://127.0.0.1:$ANCHOR_CONVEX_WEB_PORT"
curl -fsS --max-time 5 "$origin/api/health" > "$artifact/health.json"
(
    cd "$artifact"
    session="anchor-convex-release-$$"
    trap 'playwright-cli -s="$session" close > browser-close.log 2>&1 || true' EXIT
    playwright-cli -s="$session" open "$origin/login" > browser-open.log
    playwright-cli -s="$session" run-code --filename="$root/standalone-web.mjs" > browser.log
    awk '/^### Result$/ { getline; print; exit }' browser.log > browser.json
    if [[ ! -s browser.json ]]; then
        sed -n '/^### Error/,+8p' browser.log >&2
        exit 1
    fi
)
node "$root/web-attachments.mjs" "$origin" > "$artifact/attachments.json"
node "$root/profile-image.mjs" "$origin" "$ANCHOR_TEST_CONVEX_ENV" > "$artifact/profile-image.json"
ANCHOR_CONVEX_SITE_PORT="$ANCHOR_CONVEX_WEB_PORT" node "$root/user-export.mjs" --large > "$artifact/export.json"
node "$root/legacy-live-sync.mjs" "$origin" > "$artifact/live-sync.json"
if [[ "${ANCHOR_TEST_RELEASE_ANDROID:-}" == 1 ]]; then
    ANCHOR_CONVEX_SITE_PORT="$ANCHOR_CONVEX_WEB_PORT" \
        bash "$root/../../mobile-kotlin/e2e/android-board-ci.sh" "$artifact/android"
fi
node --input-type=module - "$artifact" <<'JS'
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
const dir = process.argv[2];
const read = (name) => JSON.parse(readFileSync(dir + "/" + name + ".json", "utf8"));
const health = read("health");
assert.equal(health.app, "anchor");
assert.equal(health.status, "ok");
const result = {
  origin: "http://127.0.0.1:" + process.env.ANCHOR_CONVEX_WEB_PORT,
  protocols: health.protocols,
  browser: read("browser"),
  attachments: read("attachments"),
  profileImage: read("profile-image"),
  export: read("export"),
  liveSync: read("live-sync"),
  ...(process.env.ANCHOR_TEST_RELEASE_ANDROID === "1" ? { android: read("android/board") } : {}),
};
writeFileSync(dir + "/verified.json", JSON.stringify(result, null, 2) + "\n");
JS
