#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
# Real owned HTTP server; mocked Kubernetes discovery and SSH-local process seam.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TEST_TMP="$(mktemp -d -t bao-get-test.XXXXXX)"
trap 'kill "${HTTP_PID:-}" 2>/dev/null || true; wait "${HTTP_PID:-}" 2>/dev/null || true; rm -rf "$TEST_TMP"' EXIT
mkdir -p "$TEST_TMP/bin"
REAL_CURL="$(command -v curl)"
export TEST_TMP REAL_CURL
cat > "$TEST_TMP/server.py" <<'PY'
import http.server,json,pathlib,sys
root=pathlib.Path(sys.argv[1])
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  assert self.headers.get('X-Vault-Token')=='owned-writer-token'
  mode=(root/'mode').read_text().strip()
  status=200; body={'data':{'data':{'KEY':'owned-value'}}}
  if mode=='missing':status=404;body={'errors':[]}
  elif mode=='denied':status=403;body={'errors':['private-error-token']}
  elif mode=='unavailable':status=503;body={'errors':['private-error-token']}
  elif mode=='false_missing':status=404;body={'errors':['private-error-token']}
  elif mode=='contradictory_missing':status=404;body={'errors':[],'data':{'data':{'KEY':'existing-private-value'}}}
  elif mode=='error_success':body={'errors':['private-error-token'],'data':{'data':{'KEY':'existing-private-value'}}}
  elif mode=='malformed':body={'data':{'data':None}}
  (root/'http.calls').open('a').write(self.path+'\n')
  self.send_response(status);self.end_headers()
  raw=json.dumps(body).encode()
  if mode=='invalid_json':raw=b'private-error-token invalid-json'
  elif mode=='multiple_json':raw+=raw
  self.wfile.write(raw)
server=http.server.HTTPServer(('127.0.0.1',0),Handler)
(root/'port').write_text(str(server.server_port));server.serve_forever()
PY
python3 "$TEST_TMP/server.py" "$TEST_TMP" & HTTP_PID=$!
for _ in {1..100}; do [[ ! -s "$TEST_TMP/port" ]] || break; sleep 0.02; done
[[ -s "$TEST_TMP/port" ]]
cat > "$TEST_TMP/bin/kubectl" <<'SH_KUBE'
#!/usr/bin/env bash
set -euo pipefail
[[ "$*" == '-n openbao get service openbao -o json' ]] || exit 9
printf '.\n' >> "$TEST_TMP/discovery.calls"
selector=server; [[ "$PROOF_CASE" != foreign_service ]] || selector=foreign
printf '{"metadata":{"name":"openbao","namespace":"openbao"},"spec":{"type":"ClusterIP","clusterIP":"127.0.0.1","selector":{"app.kubernetes.io/name":"openbao","app.kubernetes.io/instance":"openbao","component":"%s"},"ports":[{"port":8200,"targetPort":8200}]}}' "$selector"
SH_KUBE
cat > "$TEST_TMP/bin/curl" <<'PY_CURL'
#!/usr/bin/env python3
import os,pathlib,subprocess,sys
args=sys.argv[1:];root=pathlib.Path(os.environ['TEST_TMP'])
assert not any('owned-writer-token' in a for a in args)
config=pathlib.Path(args[args.index('--config')+1]);assert config.stat().st_mode&0o777==0o600
assert config.read_text().strip()=='header = "X-Vault-Token: owned-writer-token"'
assert config.parent.stat().st_mode&0o777==0o700
(root/'native-dir').write_text(str(config.parent))
assert args[args.index('--request')+1]=='GET'
assert 0<int(args[args.index('--max-time')+1])<=30
assert args[args.index('--max-time')+1]==args[args.index('--connect-timeout')+1]
assert args[-1].startswith('http://127.0.0.1:8200/v1/cogni/data/')
if os.environ['PROOF_CASE']=='timeout':sys.stderr.write('private-error-token');sys.exit(28)
port=(root/'port').read_text();args[-1]=args[-1].replace('127.0.0.1:8200','127.0.0.1:'+port)
sys.exit(subprocess.call([os.environ['REAL_CURL'],*args]))
PY_CURL
cat > "$TEST_TMP/bin/timeout" <<'SH_TIMEOUT'
#!/usr/bin/env bash
shift
exec "$@"
SH_TIMEOUT
chmod +x "$TEST_TMP/bin/"*
export PATH="$TEST_TMP/bin:$PATH"
source "$ROOT/scripts/ci/lib/openbao-kv-http-read.sh"
remote() {
  printf '%s\n' "$*" >> "$TEST_TMP/remote.calls"
  if [[ "$PROOF_CASE" == bare_exit2 && "$*" == bash* ]]; then return 2; fi
  bash -c "$*"
}
export DEPLOY_ENVIRONMENT=candidate-a SECRETS_CONTROL_ENV=production BAO_TOKEN=owned-writer-token
for PROOF_CASE in present missing denied unavailable false_missing contradictory_missing error_success malformed invalid_json multiple_json timeout foreign_service bare_exit2; do
  export PROOF_CASE
  CACHE_DIR="$TEST_TMP/$PROOF_CASE"; mkdir -m 700 "$CACHE_DIR"
  printf '%s' "$PROOF_CASE" > "$TEST_TMP/mode"
  rc=0
  if output="$(cogni_openbao_read_path candidate-a poly 2>"$TEST_TMP/errors")"; then :; else rc=$?; fi
  case "$PROOF_CASE" in
    present) [[ "$rc" == 0 && "$(printf '%s' "$output" | jq -r .data.data.KEY)" == owned-value ]] ;;
    missing) [[ "$rc" == 0 && "$(printf '%s' "$output" | jq -c .data.data)" == '{}' ]] ;;
    denied) [[ "$rc" == 77 && -z "$output" ]] ;;
    unavailable|timeout) [[ "$rc" == 75 && -z "$output" ]] ;;
    bare_exit2) [[ "$rc" == 2 && -z "$output" ]] ;;
    *) [[ "$rc" == 65 && -z "$output" ]] ;;
  esac
  [[ "$output" != *owned-writer-token* ]]
  if [[ -s "$TEST_TMP/native-dir" ]]; then [[ ! -e "$(cat "$TEST_TMP/native-dir")" ]]; fi
  if grep -qE 'owned-writer-token|private-error-token' "$TEST_TMP/errors" "$TEST_TMP/remote.calls"; then exit 1; fi
done
# Same authenticated custodian can read its own bank. Discovery is cached across subshells.
PROOF_CASE=present; export PROOF_CASE; printf present > "$TEST_TMP/mode"
CACHE_DIR="$TEST_TMP/present"
count="$(wc -l < "$TEST_TMP/discovery.calls")"
cogni_openbao_read_path production operator >/dev/null
[[ "$(wc -l < "$TEST_TMP/discovery.calls")" == "$count" ]]
if cogni_openbao_read_path preview operator > "$TEST_TMP/foreign.out" 2>/dev/null; then exit 1; fi
[[ ! -s "$TEST_TMP/foreign.out" ]]
if cogni_openbao_read_path candidate-a '../operator' >/dev/null 2>&1; then exit 1; fi
# The materializer must reject a bare exit2 before any cache/generation/write step.
awk '/^prefetch_path\(\) \{/ {capture=1} capture {print} capture && /^}$/ {exit}' "$ROOT/scripts/ci/secret-materialize.sh" > "$TEST_TMP/prefetch.sh"
if (
  # shellcheck disable=SC1091 # Function extracted from the actual materializer above.
  source "$TEST_TMP/prefetch.sh"
  # shellcheck disable=SC2329 # Called by the extracted prefetch function.
  cogni_openbao_read_path() { return 2; }
  # shellcheck disable=SC2329 # Called by the extracted prefetch function.
  fail() { echo "$*" >&2; exit 1; }
  # shellcheck disable=SC2329 # Called only if prefetch wrongly retries this error.
  sleep() { echo unexpected-retry >&2; exit 1; }
  prefetch_path never-created
) > "$TEST_TMP/prefetch.out" 2>&1; then exit 1; fi
[[ ! -e "$CACHE_DIR/never-created" ]]
grep -q 'NOT an absent path' "$TEST_TMP/prefetch.out"
if grep -q unexpected-retry "$TEST_TMP/prefetch.out"; then exit 1; fi
echo 'OpenBao GET transport: HTTP classification, authority, privacy, cache, and bare-exit2 controls passed'
