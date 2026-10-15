#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
# Exercise the smoke script with real curl against a local HTTP fixture.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
WORK=$(mktemp -d)
fixture_pid=''
cleanup() {
  [[ -z "$fixture_pid" ]] || kill "$fixture_pid" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT
export REAL_CURL="$(command -v curl)"
mkdir -p "$WORK/bin" "$WORK/catalog"
cat > "$WORK/catalog/fixture.yaml" <<'EOF'
name: fixture
type: node
is_primary_host: true
EOF

python3 -u - "$WORK/port" <<'PY' &
import http.server, json, sys
counts = {}
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        scenario = self.path.split('/')[1]
        if scenario == 'stats':
            body = json.dumps(counts).encode()
            self.send_response(200)
        else:
            counts[scenario] = counts.get(scenario, 0) + 1
            unavailable = scenario == 'persistent' or (scenario == 'transient' and counts[scenario] == 1)
            self.send_response(503 if unavailable else 200)
            body = json.dumps({'status': 'degraded' if scenario == 'wrong-status' else 'alive'}).encode()
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *args):
        pass
server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
with open(sys.argv[1], 'w') as output:
    output.write(str(server.server_port))
server.serve_forever()
PY
fixture_pid=$!
for _ in {1..100}; do
  [[ ! -s "$WORK/port" ]] || break
  sleep 0.05
done
[[ -s "$WORK/port" ]] || { echo 'fixture failed to start' >&2; exit 1; }
export SMOKE_TEST_PORT="$(cat "$WORK/port")"
cat > "$WORK/bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
args=("$@")
for index in "${!args[@]}"; do
  if [[ "${args[$index]}" == https://* ]]; then
    args[$index]="http://127.0.0.1:${SMOKE_TEST_PORT}/${SMOKE_SCENARIO}/livez"
  fi
done
exec "$REAL_CURL" "${args[@]}"
EOF
chmod +x "$WORK/bin/curl"

smoke() {
  env PATH="$WORK/bin:$PATH" COGNI_CATALOG_ROOT="$WORK/catalog" \
    DOMAIN=fixture.invalid PROMOTED_APPS=fixture CURL_TIMEOUT=2 \
    SMOKE_SCENARIO="$1" bash "$REPO_ROOT/scripts/ci/smoke-candidate.sh"
}
smoke transient > "$WORK/transient.log" 2>&1
if smoke persistent > "$WORK/persistent.log" 2>&1; then
  echo 'persistent HTTP503 incorrectly passed' >&2; exit 1
fi
grep -q 'unreachable after bounded retries' "$WORK/persistent.log"
if smoke wrong-status > "$WORK/wrong-status.log" 2>&1; then
  echo 'degraded liveness incorrectly passed' >&2; exit 1
fi
"$REAL_CURL" -fsS "http://127.0.0.1:${SMOKE_TEST_PORT}/stats" | python3 -c '
import json,sys
counts=json.load(sys.stdin)
assert counts == {"transient": 2, "persistent": 3, "wrong-status": 1}, counts
print("PASS: transient503 recovers; persistent503 fails after3 attempts; non-alive JSON fails")
'
