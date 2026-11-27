#!/usr/bin/env bash
set -euo pipefail
repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
artifact="$(realpath "${1:?Pass an existing artifact directory}")"
test -d "$artifact"
export ANCHOR_TEST_MIGRATION_ARTIFACT="$artifact"
: "${ANCHOR_TEST_CONVEX_ENV:?Run inside the disposable native Convex fixture}"
work="$(mktemp -d)"
pg="anchor-proxy-source-$(basename "$work" | tr -cd '[:alnum:]' | tr '[:upper:]' '[:lower:]')"
db=anchor_proxy_cutover
legacy_pid=
cleanup() {
    if [[ -n "$legacy_pid" ]]; then
        kill "$legacy_pid" 2>/dev/null || true
        wait "$legacy_pid" 2>/dev/null || true
    fi
    podman rm -f "$pg" >/dev/null 2>&1 || true
    rm -rf -- "$work"
}
trap cleanup EXIT
podman run -d --name "$pg" -p 127.0.0.1::5432 --tmpfs /var/lib/postgresql:rw,size=512m \
    -e POSTGRES_DB="$db" -e POSTGRES_HOST_AUTH_METHOD=trust docker.io/library/postgres:18-alpine > /dev/null
psql=(podman exec -i "$pg" psql -U postgres -d "$db")
for i in $(seq 1 30); do
    if "${psql[@]}" -Atc 'select 1' 2>/dev/null | grep -qx 1; then break; fi
    [[ "$i" != 30 ]]
    sleep 1
done
for m in "$repo"/server/prisma/migrations/*/migration.sql; do
    "${psql[@]}" -q -v ON_ERROR_STOP=1 < "$m"
done
pg_port="$(podman port "$pg" 5432/tcp | awk -F: '{print $NF}')"
mkdir "$work/server"
tar -C "$repo/server" --exclude=./node_modules --exclude=./dist --exclude='./.env*' -cf - . | tar -C "$work/server" -xf -
ln -s "$repo/server/node_modules" "$work/server/node_modules"
proxy_port="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
(
    cd "$work/server"
    node_modules/.bin/nest build
    exec env -i PATH="$PATH" NODE_ENV=production PORT_FILE="$work/legacy-port" DATA_DIR="$work/data" USER_SIGNUP=enabled \
        JWT_SECRET="$(openssl rand -hex 32)" DATABASE_URL="postgresql://postgres@127.0.0.1:$pg_port/$db" \
        node -e 'const {NestFactory}=require("@nestjs/core");
        const {AppModule}=require("./dist/src/app.module.js");
        const {setupApp}=require("./dist/src/app.setup.js");
        NestFactory.create(AppModule).then(async app => {
            setupApp(app);
            await app.listen(0, "127.0.0.1");
            require("node:fs").writeFileSync(process.env.PORT_FILE, String(app.getHttpServer().address().port));
        })
        .catch(error => { console.error(error); process.exit(1); });'
) > "$artifact/legacy.log" 2>&1 &
legacy_pid=$!
for i in $(seq 1 60); do
    if [[ -s "$work/legacy-port" ]]; then break; fi
    kill -0 "$legacy_pid"
    [[ "$i" != 60 ]]
    sleep 1
done
legacy_port="$(cat "$work/legacy-port")"
python3 -B "$repo/convex-backend/e2e/proxy-cutover.py" "$legacy_port" "$ANCHOR_CONVEX_API_PORT" \
    "$ANCHOR_CONVEX_SITE_PORT" "$proxy_port" "$work/data/uploads" "${psql[@]}"
