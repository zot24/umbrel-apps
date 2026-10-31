#!/usr/bin/env bash
# The local proof, with made-up data and credentials only: a fake Supabase
# project and a fake R2, then backup, restore, refusal, drill, the read-only
# checks, the 26-hour alert and screenshots (written to test/out/).
set -euo pipefail
cd "$(dirname "$0")/.."

SECRET=fake-jwt-secret-for-the-local-proof-only-0000
LB_ANON_KEY=$(node test/jwt.mjs anon "$SECRET")
LB_SERVICE_KEY=$(node test/jwt.mjs service_role "$SECRET")
export LB_ANON_KEY LB_SERVICE_KEY COMPOSE_PROJECT_NAME=lifeboat-e2e
SOURCE_URL=postgresql://lifeboat_ro:fake-readonly-password@db:5432/postgres
TARGET_URL=postgresql://postgres:fake-target-password@target:5432/postgres
OUT=test/out
mkdir -p "$OUT"

dc() { docker compose -f docker-compose.local.yml "$@"; }
step() { printf '\n=== %s\n' "$*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

# Runs a command in a service and waits for it. The command runs detached,
# so a remote Docker daemon dropping the exec stream cannot cut it short.
inside() {
  local service=$1 id=$RANDOM$RANDOM rc
  shift
  dc exec -T -d "$service" sh -c "mkdir -p /tmp/e2e && { $(printf '%q ' "$@"); } > /tmp/e2e/$id.out 2>&1; echo \$? > /tmp/e2e/$id.rc"
  until dc exec -T "$service" test -f "/tmp/e2e/$id.rc"; do sleep 2; done
  dc exec -T "$service" cat "/tmp/e2e/$id.out"
  rc=$(dc exec -T "$service" cat "/tmp/e2e/$id.rc")
  return "${rc//[^0-9]/}"
}
lb() { inside lifeboat lifeboat "$@"; }
sql() { dc exec -T target psql -U postgres -d postgres -Atc "$1"; }

step "start a fake Supabase project, a fake R2 and an empty target"
dc down -v --remove-orphans >/dev/null 2>&1 || true
dc up -d --build --wait

step "seed FAKE data"
dc exec -T db psql -q -U supabase_admin -d postgres -f /seed.sql
inside gateway node /app/seed-storage.mjs

step "backup"
lb backup | tee "$OUT/backup.json"
step "second backup: only changed objects are fetched"
lb backup | tee "$OUT/backup2.json"
grep -q '"fetched": 0' "$OUT/backup2.json" || fail "second backup fetched objects again"
lb snapshots

step "the R2 copy is a restic repo of its own"
lb snapshots --from r2

step "restore refuses the source project"
DB_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$(dc ps -q db)")
for url in "$SOURCE_URL" "postgresql://supabase_admin:fake-postgres-password@$DB_IP:5432/postgres"; do
  if out=$(lb restore latest "$url" /data/restores/refused 2>&1); then fail "restore into $url was not refused"; fi
  grep -q 'refusing to restore into the source project' <<<"$out" || fail "unexpected error: $out"
  echo "refused: ${url/:*@/://***@}"
done

step "restore into a fresh Postgres"
lb restore latest "$TARGET_URL" /data/restores/e2e | tee "$OUT/restore.json"
for q in "select count(*) from public.residents" "select count(*) from public.bookings" "select count(*) from auth.users" "select count(*) from storage.objects"; do
  echo "target: $q -> $(sql "$q")"
done

step "drill"
lb drill | tee "$OUT/drill.json"

step "reinstall: a new local repo carries on the history in R2"
FIRST=$(grep -o '"snapshot": "[0-9a-f]*"' "$OUT/backup.json" | cut -d'"' -f4)
inside lifeboat rm -rf /data/repo /data/stage /data/cache
lb backup > "$OUT/backup-reinstalled.json"
lb snapshots | grep -q "\"id\": \"$FIRST\"" || fail "the first snapshot did not come back from R2"
echo "first snapshot ${FIRST:0:8} is back, and a new one was added"

step "read-only proof"
node test/readonly-check.mjs
node --test lifeboat/lib.test.mjs test/readonly-check.test.mjs 2>&1 | grep -E '^# (pass|fail)'
dc exec -T gateway cat /tmp/requests.log > "$OUT/requests.log"
echo "requests Lifeboat made, by side and method:"
awk '{print $1, $2}' "$OUT/requests.log" | sort | uniq -c
if grep -E '^supabase ' "$OUT/requests.log" | grep -vE '^supabase GET |^supabase POST /auth/v1/token\?grant_type=password 200$'; then
  fail "a request to the source other than a GET or the sign-in"
fi
grep -qE '^r2 .* 403 ' "$OUT/requests.log" && fail "R2's lock rejected a request"
if inside lifeboat psql "$SOURCE_URL" -c "create table public.lifeboat_probe (id int)"; then fail "the read-only role can write"; fi
echo "the source role cannot write: ok"

step "screenshot"
inside browser npx -y playwright@1.56.1 screenshot --full-page --viewport-size=1200,1060 --wait-for-timeout=1500 http://lifeboat:7746/ /tmp/lifeboat.png
docker cp "$(dc ps -q browser):/tmp/lifeboat.png" "$OUT/lifeboat.png"

step "alert after 26 hours without a successful backup"
inside lifeboat node -e "const fs = require('fs'); const s = JSON.parse(fs.readFileSync('/data/state.json')); s.lastSuccessAt = new Date(Date.now() - 27 * 3600e3).toISOString(); delete s.alertedAt; fs.writeFileSync('/data/state.json', JSON.stringify(s));"
dc restart lifeboat >/dev/null
dc up -d --wait lifeboat >/dev/null
for _ in $(seq 1 60); do dc exec -T gateway grep -q '^webhook POST' /tmp/requests.log && break; sleep 3; done
dc exec -T gateway grep '^webhook POST' /tmp/requests.log || fail "no webhook alert"
inside browser node -e "fetch('http://lifeboat:7746/widgets/status').then((r) => r.text()).then(console.log)" | tee "$OUT/widget.json"
grep -q OVERDUE "$OUT/widget.json" || fail "widget does not show OVERDUE"
inside browser npx -y playwright@1.56.1 screenshot --full-page --viewport-size=1200,1060 --wait-for-timeout=1500 http://lifeboat:7746/ /tmp/overdue.png
docker cp "$(dc ps -q browser):/tmp/overdue.png" "$OUT/lifeboat-overdue.png"

step "all checks passed"
