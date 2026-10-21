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
import http.server,json,pathlib,sys,time
root=pathlib.Path(sys.argv[1])
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_POST(self):
  assert self.path=='/v1/auth/kubernetes/login'
  assert self.headers.get('X-Vault-Token') is None
  body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
  assert body['role']=='production-writer'
  assert body['jwt'].startswith('owned.jwt.')
  with (root/'login.calls').open('a') as f:f.write(body['jwt']+'\n')
  mode=(root/'mode').read_text().strip()
  status=200;body={'auth':{'client_token':'owned-login-token'}}
  if mode=='login_denied':status=403;body={'errors':['private-error-token']}
  elif mode=='login_transient':status=503;body={'errors':['private-error-token']}
  elif mode=='login_mixed':status=503 if len((root/'login.calls').read_text().splitlines())<3 else 403;body={'errors':['private-error-token']}
  elif mode=='login_401':status=401;body={'errors':['private-error-token']}
  elif mode=='login_missing':status=404;body={'errors':[]}
  elif mode=='login_empty':body={'auth':{'client_token':''}}
  elif mode=='login_error_success':body['errors']=['private-error-token']
  elif mode=='login_bad_token':body={'auth':{'client_token':'bad token'}}
  elif mode=='login_null_errors':body['errors']=None
  elif mode=='login_first_denied' and body:
   status=403;body={'errors':[]};(root/'mode').write_text('login_transient')
  elif mode=='login_recheck_success':
   status=403;body={'errors':[]};(root/'mode').write_text('login_present')
  elif mode=='login_timeout':time.sleep(.3)
  self.send_response(status);self.end_headers()
  raw=json.dumps(body).encode()
  if mode=='login_invalid_json':raw=b'private-error-token invalid-json'
  elif mode=='login_multiple_json':raw+=raw
  try:self.wfile.write(raw)
  except BrokenPipeError:pass
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
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
(root/'port').write_text(str(server.server_port));server.serve_forever()
PY
python3 "$TEST_TMP/server.py" "$TEST_TMP" & HTTP_PID=$!
for _ in {1..100}; do [[ ! -s "$TEST_TMP/port" ]] || break; sleep 0.02; done
[[ -s "$TEST_TMP/port" ]]
cat > "$TEST_TMP/bin/kubectl" <<'SH_KUBE'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == 'create token openbao-operator -n default' ]]; then
  printf '.\n' >> "$TEST_TMP/token.calls"
  case "$PROOF_CASE" in
    login_token_timeout) echo private-error-token >&2; exit 124 ;;
    login_token_absent) echo 'serviceaccounts "openbao-operator" not found private-error-token' >&2; exit 1 ;;
    login_invalid_jwt) printf 'private-error-token\n'; exit 0 ;;
  esac
  printf 'owned.jwt.%s\n' "$(wc -l < "$TEST_TMP/token.calls" | tr -d ' ')"
  exit 0
fi
[[ "$*" == '-n openbao get service openbao -o json' ]] || exit 9
printf '.\n' >> "$TEST_TMP/discovery.calls"
selector=server; [[ "$PROOF_CASE" != foreign_service ]] || selector=foreign
printf '{"metadata":{"name":"openbao","namespace":"openbao"},"spec":{"type":"ClusterIP","clusterIP":"127.0.0.1","selector":{"app.kubernetes.io/name":"openbao","app.kubernetes.io/instance":"openbao","component":"%s"},"ports":[{"port":8200,"targetPort":8200}]}}' "$selector"
SH_KUBE
cat > "$TEST_TMP/bin/curl" <<'PY_CURL'
#!/usr/bin/env python3
import os,pathlib,subprocess,sys
args=sys.argv[1:];root=pathlib.Path(os.environ['TEST_TMP'])
assert not any('owned-writer-token' in a or 'owned.jwt.' in a or 'owned-login-token' in a for a in args)
config=pathlib.Path(args[args.index('--config')+1]);assert config.stat().st_mode&0o777==0o600
assert config.parent.stat().st_mode&0o777==0o700
(root/'native-dir').write_text(str(config.parent))
method=args[args.index('--request')+1]
assert 0<int(args[args.index('--max-time')+1])<=30
assert args[args.index('--max-time')+1]==args[args.index('--connect-timeout')+1]
if method=='GET':
 assert config.read_text().strip()=='header = "X-Vault-Token: owned-writer-token"'
 assert args[-1].startswith('http://127.0.0.1:8200/v1/cogni/data/')
else:
 assert method=='POST' and args[-1]=='http://127.0.0.1:8200/v1/auth/kubernetes/login'
 assert args[args.index('--max-time')+1]=='10'
 assert config.read_text().strip()=='header = "Content-Type: application/json"'
 body=pathlib.Path(args[args.index('--data-binary')+1][1:])
 assert body.stat().st_mode&0o777==0o600
 assert (config.parent/'jwt').stat().st_mode&0o777==0o600
 if os.environ['PROOF_CASE']=='login_timeout':args[args.index('--max-time')+1]='0.1'
if os.environ['PROOF_CASE']=='timeout':sys.stderr.write('private-error-token');sys.exit(28)
port=(root/'port').read_text();args[-1]=args[-1].replace('127.0.0.1:8200','127.0.0.1:'+port)
sys.exit(subprocess.call([os.environ['REAL_CURL'],*args]))
PY_CURL
cat > "$TEST_TMP/bin/timeout" <<'SH_TIMEOUT'
#!/usr/bin/env bash
limit="$1"
shift
# Original production bound must be finite for both native calls. Capture only
# the public command identity, never a payload or private path.
case "$*" in kubectl\ create\ token*) [[ "$limit" == 10 ]] || exit 9; printf '%s token_request\n' "$limit" >> "$TEST_TMP/bounds" ;; esac
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
# The same actual HTTP server exercises login; no mocked success classifier.
# Retry backoff is skipped locally, while production bounds remain asserted.
sleep() { :; }
for PROOF_CASE in login_present login_denied login_transient login_mixed login_401 login_missing login_empty login_error_success login_bad_token login_null_errors login_invalid_json login_multiple_json login_timeout login_token_timeout login_token_absent login_invalid_jwt login_first_denied login_recheck_success; do
  export PROOF_CASE
  CACHE_DIR="$TEST_TMP/$PROOF_CASE"; mkdir -m 700 "$CACHE_DIR"
  printf '%s' "$PROOF_CASE" > "$TEST_TMP/mode"
  : > "$TEST_TMP/token.calls"; : > "$TEST_TMP/login.calls"
  rc=0
  if output="$(cogni_openbao_materializer_login 2>"$TEST_TMP/login.errors")"; then :; else rc=$?; fi
  attempts="$(wc -l < "$TEST_TMP/token.calls" | tr -d ' ')"
  case "$PROOF_CASE" in
    login_present) [[ "$rc" == 0 && "$output" == owned-login-token && "$attempts" == 1 ]] ;;
    login_recheck_success) [[ "$rc" == 0 && "$output" == owned-login-token && "$attempts" == 2 ]] ;;
    login_denied) [[ "$rc" == 77 && -z "$output" && "$attempts" == 2 ]] ;;
    login_first_denied) [[ "$rc" == 75 && -z "$output" && "$attempts" == 2 ]] ;;
    login_mixed) [[ "$rc" == 77 && -z "$output" && "$attempts" == 3 ]]; grep -q 'http_status=403' "$TEST_TMP/login.errors" ;;
    login_transient|login_timeout|login_token_timeout) [[ "$rc" == 75 && -z "$output" && "$attempts" == 3 ]] ;;
    *) [[ "$rc" == 65 && -z "$output" && "$attempts" == 1 ]] ;;
  esac
  [[ "$(sort -u "$TEST_TMP/login.calls" | wc -l | tr -d ' ')" == "$(wc -l < "$TEST_TMP/login.calls" | tr -d ' ')" ]]
  if [[ "$PROOF_CASE" == login_token_* || "$PROOF_CASE" == login_invalid_jwt ]]; then [[ ! -s "$TEST_TMP/login.calls" ]]; fi
  if grep -qE 'owned.jwt.|owned-login-token|private-error-token' "$TEST_TMP/login.errors" "$TEST_TMP/remote.calls"; then exit 1; fi
  [[ ! -e "$(cat "$TEST_TMP/native-dir")" ]]
done
grep -q '10 token_request' "$TEST_TMP/bounds"
if (SECRETS_CONTROL_ENV=foreign; cogni_openbao_materializer_login) > "$TEST_TMP/foreign-login.out" 2>/dev/null; then exit 1; fi
[[ ! -s "$TEST_TMP/foreign-login.out" ]]
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
echo 'OpenBao HTTP transport: strict GET/login, finite fresh-JWT policy, authority, privacy and cache controls passed'
