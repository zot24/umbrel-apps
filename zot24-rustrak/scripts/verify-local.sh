#!/usr/bin/env bash
# Start the local stack and check that one Sentry SDK message becomes an issue.
# Secrets stay in $RUSTRAK_VERIFY_STATE (default /tmp/rustrak-verify).
# The script prints the issue title and writes a redacted JSON result.
set -euo pipefail

app_dir="$(cd "$(dirname "$0")/.." && pwd)"
repo_dir="$(cd "$app_dir/.." && pwd)"
state_dir="${RUSTRAK_VERIFY_STATE:-/tmp/rustrak-verify}"
out_dir="${RUSTRAK_VERIFY_OUT:-$repo_dir/_scratch/demo}"
umask 077
mkdir -p "$state_dir" "$out_dir"

if [[ ! -s "$state_dir/session" ]]; then
  openssl rand -hex 32 > "$state_dir/session"
fi
if [[ ! -s "$state_dir/password" ]]; then
  openssl rand -hex 16 > "$state_dir/password"
fi

python3 - "$state_dir/session" "$state_dir/password" <<'PY'
import sys
from pathlib import Path
session = Path(sys.argv[1]).read_text().strip()
password = Path(sys.argv[2]).read_text().strip()
if len(session) < 64 or any(c not in "0123456789abcdef" for c in session):
    raise SystemExit("session file must be at least 64 hex characters")
if not password or ":" in password:
    raise SystemExit("password file must be non-empty and must not contain a colon")
print(f"session_len={len(session)} password_len={len(password)}")
PY

if [[ -z "${PUBLIC_URL:-}" ]]; then
  if getent hosts zot24-dockyard_dind_1 >/dev/null 2>&1; then
    PUBLIC_URL="http://zot24-dockyard_dind_1:8686"
  else
    PUBLIC_URL="http://127.0.0.1:8686"
  fi
fi

export SESSION_SECRET_KEY
SESSION_SECRET_KEY="$(cat "$state_dir/session")"
export CREATE_SUPERUSER="admin@rustrak.local:$(cat "$state_dir/password")"
export PUBLIC_URL

docker compose -f "$app_dir/docker-compose.local.yml" -p rustrak-verify up -d

health_url="${PUBLIC_URL%/}/health/ready"
ready=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
  if curl -fsS --max-time 3 "$health_url" >/dev/null; then
    ready=1
    break
  fi
  sleep 2
done
if [[ "$ready" != 1 ]]; then
  echo "server did not become ready at ${health_url}" >&2
  exit 1
fi

python_bin="${PYTHON:-python3}"
"$python_bin" - "$state_dir" "$PUBLIC_URL" "$out_dir" <<'PY'
import json, sys, time, urllib.error, urllib.request, http.cookiejar
from pathlib import Path

state = Path(sys.argv[1])
base = sys.argv[2].rstrip("/")
out = Path(sys.argv[3])
password = (state / "password").read_text().strip()

try:
    import sentry_sdk
except ImportError:
    raise SystemExit("install sentry-sdk in this Python, then rerun")

cj = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

def call(method, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(base + path, data=data, method=method)
    req.add_header("Accept", "application/json")
    if body is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with opener.open(req, timeout=30) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as err:
        return err.code, err.read()

code, raw = call("POST", "/auth/login", {"email": "admin@rustrak.local", "password": password})
if code != 200:
    raise SystemExit(f"login failed with HTTP {code}. The data volume may belong to a different password file.")

code, raw = call("GET", "/api/projects")
if code != 200:
    raise SystemExit(f"list projects failed with HTTP {code}")
projects = json.loads(raw)
items = projects["items"] if isinstance(projects, dict) else projects
project = next((item for item in items if item.get("slug") == "verify-sdk"), None)
if project is None:
    code, raw = call("POST", "/api/projects", {"name": "verify-sdk", "platform": "python", "slug": "verify-sdk"})
    if code != 201:
        raise SystemExit(f"create project failed with HTTP {code}")
    project = json.loads(raw)

dsn = project["dsn"]
project_id = project["id"]
dsn_path = state / "dsn"
dsn_path.write_text(dsn)
dsn_path.chmod(0o600)

marker = f"rustrak-umbrel-verify-{int(time.time())}"
sentry_sdk.init(dsn=dsn, traces_sample_rate=0)
try:
    sentry_sdk.capture_message(marker)
    sentry_sdk.flush(timeout=15)
finally:
    sentry_sdk.get_client().close(timeout=5)

found = None
for _ in range(30):
    code, raw = call("GET", f"/api/projects/{project_id}/issues")
    if code != 200:
        time.sleep(1)
        continue
    body = json.loads(raw)
    for item in body.get("items", []):
        title = item.get("title") or ""
        if marker in title or marker in json.dumps({k: v for k, v in item.items() if k != "dsn"}):
            found = {"id": item.get("id"), "title": title}
            break
    if found:
        break
    time.sleep(1)

if not found:
    raise SystemExit("issue did not appear")

result = {
    "health": "ready",
    "project_slug": "verify-sdk",
    "issue_id": found["id"],
    "issue_title": found["title"],
    "marker": marker,
}
text = json.dumps(result, indent=2) + "\n"
(out / "verify-result.json").write_text(text)
print(text, end="")
PY
