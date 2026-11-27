#!/usr/bin/env bash
set -euo pipefail
umask 077

artifact=$(realpath "${1:?Pass an existing artifact directory}")
if [[ "${2:-}" != --fixture ]]; then
  binary=$(realpath "${2:?Pass the local Convex backend binary}")
  : "${BORDO_TEST_CHROMIUM:?Set the path to Chromium for Testing}"
  repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
  cd "$repo"
  (cd web && pnpm build) > "$artifact/web-build.log" 2>&1
  bash convex-backend/e2e/local-compose-fixture.sh "$binary" \
    bash convex-backend/e2e/chrome-clipper.sh "$artifact" --fixture > "$artifact/fixture.log" 2>&1
  cat "$artifact/api.json" "$artifact/browser.json"
  exit
fi

repo=$PWD
node convex-backend/e2e/chrome-clipper.mjs "$ANCHOR_COMPOSE_FIXTURE_URL" > "$artifact/api.json"
cp -r chrome-extension "$artifact/extension"
# Grant only the fixture origin in this isolated browser. Chrome's
# native permission prompt is outside the Playwright page DOM.
python3 - "$artifact/extension/manifest.json" <<'PY'
import json, sys
from pathlib import Path
p = Path(sys.argv[1])
manifest = json.loads(p.read_text())
manifest["host_permissions"] = ["http://127.0.0.1/*"]
p.write_text(json.dumps(manifest))
PY

(
  cd web
  export SERVER_URL="$ANCHOR_COMPOSE_FIXTURE_URL" HOSTNAME=127.0.0.1 PORT=4178
  exec node start/serve.mjs
) > "$artifact/web.log" 2>&1 &
web=$!
browser=
session="bordo-clipper-$$"
cleanup() {
  playwright-cli -s="$session" detach > "$artifact/browser-close.log" 2>&1 || true
  kill "$web" 2>/dev/null || true
  if [[ -n "$browser" ]]; then kill -- "-$browser" 2>/dev/null || true; fi
}
trap cleanup EXIT
origin=http://127.0.0.1:4178
for tries in {1..20}; do
  curl -fsS --max-time 2 "$origin/api/health" > "$artifact/health.json" 2>/dev/null && break
  [[ "$tries" != 20 ]]
  sleep 0.4
done
setsid xvfb-run -a "$BORDO_TEST_CHROMIUM" \
  --no-sandbox --disable-dev-shm-usage --no-first-run --remote-debugging-port=0 --user-data-dir="$artifact/profile" \
  --disable-extensions-except="$artifact/extension" --load-extension="$artifact/extension" "$origin/login" > "$artifact/chrome.log" 2>&1 &
browser=$!
for tries in {1..30}; do
  test ! -s "$artifact/profile/DevToolsActivePort" || break
  [[ "$tries" != 30 ]]
  sleep 0.4
done
port=$(head -1 "$artifact/profile/DevToolsActivePort")
cd "$artifact"
playwright-cli -s="$session" attach --cdp "http://127.0.0.1:$port" > browser-open.log
playwright-cli -s="$session" goto "$origin/login" >> browser-open.log
playwright-cli -s="$session" run-code --filename="$repo/convex-backend/e2e/chrome-clipper-browser.mjs" > browser.log
awk '/^### Result$/ { getline; print; exit }' browser.log > browser.json
test -s browser.json || { tail -20 browser.log >&2; exit 1; }
