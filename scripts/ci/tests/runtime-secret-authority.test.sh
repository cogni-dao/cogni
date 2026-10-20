#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
# Hermetic authority checks; only an owned loopback HTTP server, no Docker/external network.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SOURCE="$REPO_ROOT/scripts/ci/deploy-infra.sh"
TMPROOT="$(mktemp -d -t runtime-authority.XXXXXX)"
trap 'if [[ -n "${HTTP_PID:-}" ]]; then kill "$HTTP_PID" 2>/dev/null || true; wait "$HTTP_PID" 2>/dev/null || true; fi; rm -rf "$TMPROOT" "${ENTRY_TMP:-}"' EXIT
mkdir -p "$TMPROOT/bin"
function_source() {
  awk -v start="$1() {" '$0 == start {capture=1} capture {print} capture && /^}$/ {exit}' "$SOURCE"
}
{
  printf 'set -euo pipefail\n'
  printf 'log_fatal() { echo "$1" >&2; exit 1; }\nlog_info() { :; }\nlog_warn() { :; }\n'
  for name in previous_runtime_env_value postgres_bootstrap_identity preserve_postgres_bootstrap_identity source_openbao_runtime_key source_operator_database_service_url; do
    function_source "$name"
  done
} > "$TMPROOT/functions.sh"
cat > "$TMPROOT/bin/timeout" <<'SH'
#!/usr/bin/env bash
shift
exec "$@"
SH
cat > "$TMPROOT/bin/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  ps) [[ "${PROOF_CASE:-}" != multiple ]] && echo abc123 || printf 'abc123\ndef456\n' ;;
  inspect)
    if [[ "$*" == *NetworkSettings* ]]; then echo 10.100.0.2
    elif [[ "${PROOF_CASE:-}" == foreign ]]; then echo 'true|foreign|postgres|postgres_data'
    else echo 'true|cogni-runtime|postgres|postgres_data'; fi ;;
  exec)
    if [[ "$*" == *pg_controldata* ]]; then echo 'Database system identifier: 7654321'; exit; fi
    IFS= read -r supplied
    [[ "${PROOF_CASE:-}" != timeout ]] || exit 124
    if [[ "$supplied" != existing-root && "${PROOF_CASE:-}" != trust ]]; then
      echo 'password authentication failed' >&2; exit 2
    fi
    if [[ "${PROOF_CASE:-}" == stale && "$supplied" == existing-root ]]; then
      echo 'password authentication failed' >&2; exit 2
    fi
    [[ "${PROOF_CASE:-}" != wrong_identity ]] && echo '7654321|postgres|true' || echo '123|postgres|true' ;;
  compose)
    if [[ "${CONFIG_CASE:-}" == invalid ]]; then echo 'interpolation leaked-secret-marker' >&2; exit 1; fi ;;
  *) exit 9 ;;
esac
SH
chmod +x "$TMPROOT/bin/"*
export PATH="$TMPROOT/bin:$PATH"
printf 'POSTGRES_ROOT_USER=postgres\nPOSTGRES_ROOT_PASSWORD=existing-root\nAUTH_SECRET=must-never-be-preserved\n' > "$TMPROOT/installed.env"
export INSTALLED_RUNTIME_ENV="$TMPROOT/installed.env"
initial="$(cat "$INSTALLED_RUNTIME_ENV")"
for proof_case in success multiple foreign trust timeout stale wrong_identity explicit_mismatch; do
  if output="$( (
    source "$TMPROOT/functions.sh"
    export PROOF_CASE="$proof_case"
    unset POSTGRES_ROOT_USER POSTGRES_ROOT_PASSWORD
    [[ "$proof_case" != explicit_mismatch ]] || POSTGRES_ROOT_PASSWORD=unrelated-incoming-root
    preserve_postgres_bootstrap_identity
    [[ "$POSTGRES_ROOT_USER" == postgres && "$POSTGRES_ROOT_PASSWORD" == existing-root ]]
    echo authenticated
  ) 2>&1)"; then
    [[ "$proof_case" == success && "$output" == authenticated ]] || { echo "Unexpected root proof success: $proof_case" >&2; exit 1; }
  else
    [[ "$proof_case" != success ]] || { echo "$output" >&2; exit 1; }
    [[ "$output" == *bootstrap_root_* ]] || { echo "Unclassified root proof failure: $proof_case" >&2; exit 1; }
  fi
  [[ "$output" != *existing-root* && "$output" != *must-never-be-preserved* ]]
  [[ "$(cat "$INSTALLED_RUNTIME_ENV")" == "$initial" ]]
done
# Runtime values come only from the requested owner. Absence clears GH shadows;
# a required absence cannot recover from an installed value or a foreign bank.
(
  source "$TMPROOT/functions.sh"
  OPENBAO_RUNTIME_SSOT=true
  openbao_get_field() { [[ "$1" != operator ]] || return 0; echo foreign-node-value; }
  METRICS_TOKEN=github-shadow
  source_openbao_runtime_key optional METRICS_TOKEN operator
  [[ -z "${METRICS_TOKEN:-}" ]]
)
if (
  source "$TMPROOT/functions.sh"
  OPENBAO_RUNTIME_SSOT=true
  DATABASE_URL=github-shadow
  openbao_get_field() { [[ "$1" != operator ]] || return 0; echo foreign-node-value; }
  source_openbao_runtime_key required DATABASE_URL operator
) > "$TMPROOT/failure" 2>&1; then echo 'Missing owner silently fell back' >&2; exit 1; fi
# Even the fresh lane uses the canonical operator ledger service URL.
(
  source "$TMPROOT/functions.sh"
  OPENBAO_RUNTIME_SSOT=false
  openbao_get_field() { [[ "$1/$2" == operator/DATABASE_SERVICE_URL ]] && echo canonical-service-url; }
  source_operator_database_service_url
  [[ "$OPERATOR_DATABASE_SERVICE_URL" == canonical-service-url ]]
)
# A failed ESO lookup must not enter fresh bootstrap. Positive absence can.
lookup="$(awk '/^ESO_TARGET=/ {capture=1} capture && /^source_openbao_runtime_key/ {exit} capture {print}' "$SOURCE")"
for lookup_case in absent existing unavailable; do
  if output="$( (
    source "$TMPROOT/functions.sh"
    DEPLOY_ENVIRONMENT=candidate-a
    kubectl() { case "$lookup_case" in existing) echo secret/operator-env-secrets ;; unavailable) return 124 ;; esac; }
    timeout() { shift; "$@"; }
    export -f kubectl timeout
    OPENBAO_RUNTIME_SSOT=false
    eval "$lookup"
    echo "$OPENBAO_RUNTIME_SSOT"
  ) 2>&1)"; then
    [[ "$lookup_case" != unavailable ]]
    [[ "$lookup_case" != existing || "$output" == true ]]
    [[ "$lookup_case" != absent || "$output" == false ]]
  else [[ "$lookup_case" == unavailable ]]; fi
done
# Fresh bootstrap still requires the original values; this is not a new fallback.
fresh="$(awk '/^if "\$OPENBAO_RUNTIME_SSOT"; then$/ {capture=1} capture {print} capture && /^fi$/ {exit}' "$SOURCE")"
for fresh_case in complete missing; do
  if (
    source "$TMPROOT/functions.sh"
    OPENBAO_RUNTIME_SSOT=false
    for key in DATABASE_URL DATABASE_SERVICE_URL LITELLM_MASTER_KEY OPENROUTER_API_KEY AUTH_SECRET POSTGRES_ROOT_USER POSTGRES_ROOT_PASSWORD APP_DB_USER APP_DB_PASSWORD APP_DB_SERVICE_USER APP_DB_SERVICE_PASSWORD APP_DB_NAME EVM_RPC_URL POLYGON_RPC_URL TEMPORAL_DB_USER INTERNAL_OPS_TOKEN POSTHOG_API_KEY POSTHOG_HOST; do export "$key=fixture-value"; done
    [[ "$fresh_case" != missing ]] || unset POSTGRES_ROOT_PASSWORD
    eval "$fresh"
  ) > "$TMPROOT/fresh" 2>&1; then [[ "$fresh_case" == complete ]]; else [[ "$fresh_case" == missing ]]; fi
done
# Real HTTP exercises the actual reader helpers, with private files and an owned
# ephemeral loopback server. Kubernetes is mocked only at its native JWT/Service seam.
for name in openbao_reader_address openbao_http_request openbao_reader_request mint_db_reader_token openbao_get_field; do
  function_source "$name" >> "$TMPROOT/functions.sh"
done
late_reader="$(awk '/^DB_READER_TOKEN=""$/ {capture=1} capture && /^# The runner forwards/ {exit} capture {print}' "$SOURCE")"
[[ -n "$late_reader" ]]
cat > "$TMPROOT/server.py" <<'PY_HTTP'
import http.server,json,pathlib,sys
root=pathlib.Path(sys.argv[1])
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args): pass
 def handle_request(self):
  state=json.loads((root/'http-state').read_text()); directory=pathlib.Path(state['directory']); mode=state['case']
  body=self.rfile.read(int(self.headers.get('Content-Length',0)))
  record={'method':self.command,'path':self.path,'token':self.headers.get('X-Vault-Token'),'body':body.decode()}
  with (directory/'http.calls').open('a') as f: f.write(json.dumps(record)+'\n')
  calls=[json.loads(line) for line in (directory/'http.calls').read_text().splitlines()]
  status=200; response={}
  if mode.startswith('writer_'):
   desired={'OPENFGA_STORE_ID':'desired-store','OPENFGA_AUTHORIZATION_MODEL_ID':'desired-model','OPENFGA_AUTHORIZATION_MODEL_HASH':'desired-hash'}
   bucket=directory/'bucket.json'; values=json.loads(bucket.read_text())
   if self.path=='/v1/auth/kubernetes/login' and self.command=='POST':
    assert json.loads(body)=={'role':'production-writer','jwt':'owned-writer-jwt'}
    logins=[c for c in calls if c['path']==self.path]
    if mode=='writer_forbidden': status=403; response={'errors':['PRIVATE_WRITER_SECRET']}
    elif mode=='writer_login_transient' and len(logins)==1: status=503; response={'errors':['PRIVATE_WRITER_SECRET']}
    else: response={'auth':{'client_token':'owned-writer-secret','lease_duration':3600}}
   elif self.path=='/v1/cogni/data/production/operator':
    if self.command=='GET':
     assert self.headers.get('X-Vault-Token')=='owned-reader-secret'
     if mode=='writer_read_denied': status=403; response={'errors':['PRIVATE_WRITER_SECRET']}
     elif mode=='writer_read_malformed': response=None
     elif values is None: status=404; response={'errors':[]}
     else: response={'data':{'data':values}}
    else:
     assert self.headers.get('X-Vault-Token')=='owned-writer-secret'
     data=json.loads(body); assert data['data']==desired
     if self.command=='PATCH':
      assert self.headers.get('Content-Type')=='application/merge-patch+json'
      assert set(data)=={'data'}
      if values is None: status=404; response={'errors':[]}
      elif mode=='writer_patch_absent': bucket.write_text('null');status=404;response={'errors':[]}
      elif mode=='writer_patch_unknown404': status=404;response={'errors':['PRIVATE_WRITER_SECRET']}
      elif mode=='writer_write_denied': status=403; response={'errors':['PRIVATE_WRITER_SECRET']}
      elif mode=='writer_unconfirmed': self.close_connection=True; self.connection.close(); return
      else:
       values.update(data['data']);bucket.write_text(json.dumps(values)); response={'data':{'version':2}}
       if mode=='writer_lost_ack': self.close_connection=True; self.connection.close(); return
     elif self.command=='POST':
      assert data['options']=={'cas':0} and set(data)=={'data','options'}
      if mode=='writer_cas_race':
       values={'AUTH_SECRET':'concurrent-sibling'};bucket.write_text(json.dumps(values))
      if values is not None: status=400; response={'errors':['check-and-set parameter did not match current version']}
      else: bucket.write_text(json.dumps(data['data']));response={'data':{'version':1}}
     else: raise AssertionError('unexpected writer method')
   else: raise AssertionError('writer route escaped exact operator path')
   payload=b'{' if response is None else json.dumps(response).encode()
   self.send_response(status);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(payload);return
  if self.command=='POST' and self.path=='/v1/auth/kubernetes/login':
   login=[c for c in calls if c['method']=='POST']
   assert json.loads(body)=={'role':'production-db-reader','jwt':'owned-jwt-secret'}
   if mode=='login_transient' and len(login)==1: status=503; response={'errors':['owned-private-error']}
   elif mode=='forbidden': status=403; response={'errors':['owned-reader-secret']}
   elif mode=='permanent': status=400; response={'errors':['owned-jwt-secret']}
   elif mode=='empty': response={'auth':{}}
   elif mode=='missing_ttl': response={'auth':{'client_token':'owned-reader-secret'}}
   elif mode=='zero_ttl': response={'auth':{'client_token':'owned-reader-secret','lease_duration':0}}
   elif mode=='malformed_ttl': response={'auth':{'client_token':'owned-reader-secret','lease_duration':'900'}}
   else: response={'auth':{'client_token':'owned-reader-secret','lease_duration':900}}
  elif self.command=='GET' and self.path.startswith('/v1/cogni/data/production/'):
   assert self.headers.get('X-Vault-Token')=='owned-reader-secret'
   service=self.path.rsplit('/',1)[1]
   if service=='missing': status=404; response={'errors':[]}
   elif service=='ambiguous404': status=404; response={'errors':['owned-private-error']}
   elif service=='forbidden': status=403; response={'errors':['owned-reader-secret']}
   elif service=='malformed': response=None
   elif service=='missingkey': response={'data':{'data':{}}}
   elif service in ('transient','latetransient') and len([c for c in calls if c['path']==self.path])==1: status=503; response={'errors':['owned-private-error']}
   else: response={'data':{'data':{key:'owned-password' for key in ['APP_DB_PASSWORD','APP_DB_SERVICE_PASSWORD','APP_DB_MIGRATION_PASSWORD']}}}
  else: status=400; response={'errors':['unexpected owned HTTP route']}
  payload=b'{' if response is None else json.dumps(response).encode()
  self.send_response(status); self.send_header('Content-Type','application/json'); self.end_headers(); self.wfile.write(payload)
 do_POST=handle_request
 do_GET=handle_request
 do_PATCH=handle_request
server=http.server.HTTPServer(('127.0.0.1',0),Handler)
(root/'http-port').write_text(str(server.server_port))
server.serve_forever()
PY_HTTP
python3 "$TMPROOT/server.py" "$TMPROOT" >"$TMPROOT/http-server.log" 2>&1 &
HTTP_PID=$!
for attempt in {1..100}; do [[ ! -s "$TMPROOT/http-port" ]] || break; sleep .02; done
[[ -s "$TMPROOT/http-port" ]]
HTTP_ORIGIN="http://127.0.0.1:$(cat "$TMPROOT/http-port")"
for reader_case in reuse token_transient login_transient permanent forbidden empty zero_ttl malformed_ttl missing_ttl; do
  (
    source "$TMPROOT/functions.sh"
    umask 077 # The actual deploy cache initialization sets this before these helpers.
    BAO_CACHE_DIR="$TMPROOT/reader-$reader_case"
    mkdir -p "$BAO_CACHE_DIR"
    BAO_TOKEN_FILE="$BAO_CACHE_DIR/token"
    printf '%s' "$HTTP_ORIGIN" > "$BAO_CACHE_DIR/service-address"
    printf '{"case":"%s","directory":"%s"}' "$reader_case" "$BAO_CACHE_DIR" > "$TMPROOT/http-state"
    DEPLOY_ENVIRONMENT=production
    sleep() { :; }
    timeout() { shift; "$@"; }
    curl() {
      [[ "$1" == --disable ]] || return 97
      local previous="" arg
      for arg in "$@"; do [[ "$previous" != --max-time ]] || printf '%s\n' "$arg" >> "$BAO_CACHE_DIR/curl.limits"; previous="$arg"; done
      [[ "$*" != *owned-jwt-secret* && "$*" != *owned-reader-secret* && "$*" != *owned-password* ]] || return 98
      command curl "$@"
    }
    kubectl() {
      [[ "$*" == 'create token db-provisioner -n default' ]] || { echo 'forbidden kubectl exec/discovery in cached path' >&2; return 99; }
      printf 'call\n' >> "$BAO_CACHE_DIR/jwt.calls"
      if [[ "$reader_case" == token_transient && "$(wc -l < "$BAO_CACHE_DIR/jwt.calls" | tr -d ' ')" == 1 ]]; then
        echo 'context deadline exceeded owned-jwt-secret' >&2; return 124
      fi
      printf '%s' owned-jwt-secret
    }
    if reader="$(mint_db_reader_token 2>"$BAO_CACHE_DIR/diagnostics")"; then
      [[ "$reader_case" == reuse || "$reader_case" == token_transient || "$reader_case" == login_transient ]]
      [[ "$reader" == owned-reader-secret ]]
      [[ "$(openbao_get_field operator APP_DB_PASSWORD 2>>"$BAO_CACHE_DIR/diagnostics")" == owned-password ]]
      eval "$late_reader" 2>>"$BAO_CACHE_DIR/diagnostics"
      [[ "$DB_READER_TOKEN" == "$reader" ]]
      for field in APP_DB_PASSWORD APP_DB_SERVICE_PASSWORD APP_DB_MIGRATION_PASSWORD; do
        [[ "$(read_node_db_secret operator "$field" 2>>"$BAO_CACHE_DIR/diagnostics")" == owned-password ]]
      done
      expected_jwt=1 expected_login=1
      [[ "$reader_case" != token_transient ]] || expected_jwt=2
      [[ "$reader_case" != login_transient ]] || { expected_jwt=2; expected_login=2; }
      [[ "$(wc -l < "$BAO_CACHE_DIR/jwt.calls" | tr -d ' ')" == "$expected_jwt" ]]
      python3 - "$BAO_CACHE_DIR/http.calls" "$expected_login" <<'PY_COUNTS'
import json,sys
rows=[json.loads(line) for line in open(sys.argv[1])]
assert len([r for r in rows if r['method']=='POST'])==int(sys.argv[2])
assert len([r for r in rows if r['method']=='GET'])==1
assert rows[-1]['path']=='/v1/cogni/data/production/operator'
PY_COUNTS
      grep -q 'phase=cache native_rc=0 reason=reused' "$BAO_CACHE_DIR/diagnostics"
      [[ "$reader_case" == reuse ]] || grep -q 'reason=server_transient attempt=1/3' "$BAO_CACHE_DIR/diagnostics"
      if [[ "$reader_case" == reuse ]]; then
        [[ "$(read_node_db_secret lateoperator APP_DB_PASSWORD 2>>"$BAO_CACHE_DIR/diagnostics")" == owned-password ]]
        late_limit="$(tail -1 "$BAO_CACHE_DIR/curl.limits")"
        [[ "$late_limit" -gt 0 && "$late_limit" -le 10 ]]
        if value="$(read_node_db_secret latetransient APP_DB_PASSWORD 2>>"$BAO_CACHE_DIR/diagnostics")"; then echo 'Late transient widened the original single attempt' >&2; exit 1; fi
        [[ -z "$value" ]]
        grep -q 'http_status=503 attempt=1/1' "$BAO_CACHE_DIR/diagnostics"
        if openbao_get_field operator APP_DB_PASSWORD 31 >>"$BAO_CACHE_DIR/diagnostics" 2>&1; then echo 'Unbounded reader limit accepted' >&2; exit 1; fi
        for service in missing missingkey; do [[ -z "$(openbao_get_field "$service" ABSENT 2>>"$BAO_CACHE_DIR/diagnostics")" ]]; done
        for service in ambiguous404 forbidden malformed; do
          if value="$(openbao_get_field "$service" ABSENT 2>>"$BAO_CACHE_DIR/diagnostics")"; then echo "Unknown path became absence: $service" >&2; exit 1; fi
          [[ -z "$value" ]]
        done
        [[ "$(openbao_get_field transient APP_DB_PASSWORD 2>>"$BAO_CACHE_DIR/diagnostics")" == owned-password ]]
        python3 - "$BAO_CACHE_DIR/http.calls" <<'PY_READS'
import json,sys
rows=[json.loads(line) for line in open(sys.argv[1])]
for service in ['missing','missingkey','ambiguous404','forbidden','malformed']:
 assert sum(r['path']=='/v1/cogni/data/production/'+service for r in rows)==1
assert sum(r['path']=='/v1/cogni/data/production/transient' for r in rows)==2
assert sum(r['path']=='/v1/cogni/data/production/latetransient' for r in rows)==1
PY_READS
        # Simulate six seconds of cold discovery without a real wait. DEBUG
        # changes only the clock immediately before the actual budget calculation.
        (
          openbao_reader_address() { [[ "$1" == 10 ]] || return 99; printf '%s' "$HTTP_ORIGIN"; }
          set -T
          trap 'if [[ "$BASH_COMMAND" == remaining=* ]]; then SECONDS=$((SECONDS + 6)); fi' DEBUG
          [[ "$(openbao_reader_request GET cogni/data/production/budget '' owned-reader-secret "$BAO_CACHE_DIR/budget.json" 10)" == 200 ]]
          trap - DEBUG
          budget_limit="$(tail -1 "$BAO_CACHE_DIR/curl.limits")"
          [[ "$budget_limit" -gt 0 && "$budget_limit" -le 4 ]]
        )
        for expiry_case in expired unknown malformed; do
          # An unproven cached value must never become an HTTP request header.
          printf '%s' expired-reader-secret > "$BAO_TOKEN_FILE"
          case "$expiry_case" in
            expired) printf '1' > "${BAO_TOKEN_FILE}.expires-at" ;;
            unknown) rm -f "${BAO_TOKEN_FILE}.expires-at" ;;
            malformed) printf 'untrusted-expiry' > "${BAO_TOKEN_FILE}.expires-at" ;;
          esac
          [[ "$(read_node_db_secret "expiry-$expiry_case" APP_DB_PASSWORD 2>>"$BAO_CACHE_DIR/diagnostics")" == owned-password ]]
          python3 - "$BAO_CACHE_DIR/http.calls" "$expiry_case" <<'PY_EXPIRY'
import json,sys
rows=[json.loads(line) for line in open(sys.argv[1])]
assert rows[-2]['method']=='POST' and rows[-2]['path']=='/v1/auth/kubernetes/login'
assert rows[-1]['method']=='GET' and rows[-1]['path']=='/v1/cogni/data/production/expiry-'+sys.argv[2]
assert rows[-1]['token']=='owned-reader-secret'
assert all(row['token']!='expired-reader-secret' for row in rows)
PY_EXPIRY
          [[ "$(cat "$BAO_TOKEN_FILE")" == owned-reader-secret ]]
          expiry="$(cat "${BAO_TOKEN_FILE}.expires-at")"
          [[ "$expiry" =~ ^[0-9]+$ && "$expiry" -gt "$(date +%s)" ]]
        done
        for scope in 'POST auth/other 20' 'GET cogni/data/preview/operator 30'; do
          read -r method route limit <<< "$scope"
          if openbao_reader_request "$method" "$route" '' '' "$BAO_CACHE_DIR/rejected" "$limit" >>"$BAO_CACHE_DIR/diagnostics" 2>&1; then echo 'Unowned HTTP scope accepted' >&2; exit 1; fi
        done
      fi
    else
      [[ "$reader_case" == permanent || "$reader_case" == forbidden || "$reader_case" == empty || "$reader_case" == zero_ttl || "$reader_case" == malformed_ttl || "$reader_case" == missing_ttl ]]
      [[ -z "$reader" && ! -s "$BAO_TOKEN_FILE" ]]
      [[ "$(wc -l < "$BAO_CACHE_DIR/jwt.calls" | tr -d ' ')" == 1 ]]
      [[ "$(wc -l < "$BAO_CACHE_DIR/http.calls" | tr -d ' ')" == 1 ]]
      case "$reader_case" in
        permanent) grep -q 'native_rc=22 http_status=400 reason=permanent' "$BAO_CACHE_DIR/diagnostics" ;;
        forbidden) grep -q 'http_status=403 reason=permission_denied' "$BAO_CACHE_DIR/diagnostics" ;;
        empty) grep -q 'native_rc=0 http_status=200 reason=empty_output' "$BAO_CACHE_DIR/diagnostics" ;;
      esac
    fi
    ! grep -qE 'owned-jwt-secret|owned-reader-secret|owned-password|owned-private-error|expired-reader-secret|untrusted-expiry' "$BAO_CACHE_DIR/diagnostics"
    [[ ! -e "$BAO_CACHE_DIR/http-request.conf" && ! -e "$BAO_CACHE_DIR/reader-login.json" ]]
  )
done
# The writer reuses private HTTP transport, never the reader's authority token.
# Every case starts with a stale path cache to prove the gate fetches canonical KV.
for name in openbao_writer_request classify_kubectl_resource_lookup_failure read_operator_openfga_current operator_openfga_current_matches patch_operator_openfga_config; do
  function_source "$name" >> "$TMPROOT/functions.sh"
done
for writer_case in writer_noop writer_patch writer_patch_absent writer_patch_unknown404 writer_create writer_cas_race writer_lost_ack writer_unconfirmed writer_write_denied writer_read_denied writer_read_malformed writer_native_absent writer_native_timeout writer_forbidden writer_login_transient; do
  (
    source "$TMPROOT/functions.sh"
    umask 077
    BAO_CACHE_DIR="$TMPROOT/$writer_case"; mkdir -p "$BAO_CACHE_DIR"
    BAO_TOKEN_FILE="$BAO_CACHE_DIR/token"
    printf '%s' owned-reader-secret > "$BAO_TOKEN_FILE"
    printf '%s' "$(( $(date +%s) + 900 ))" > "${BAO_TOKEN_FILE}.expires-at"
    printf '%s' "$HTTP_ORIGIN" > "$BAO_CACHE_DIR/service-address"
    printf '{"case":"%s","directory":"%s"}' "$writer_case" "$BAO_CACHE_DIR" > "$TMPROOT/http-state"
    export DEPLOY_ENVIRONMENT=production OPENFGA_STORE_ID=desired-store OPENFGA_AUTHORIZATION_MODEL_ID=desired-model OPENFGA_AUTHORIZATION_MODEL_HASH=desired-hash
    python3 - "$BAO_CACHE_DIR" "$writer_case" <<'PY_BUCKET'
import json,pathlib,sys
root=pathlib.Path(sys.argv[1]);mode=sys.argv[2]
desired={'OPENFGA_STORE_ID':'desired-store','OPENFGA_AUTHORIZATION_MODEL_ID':'desired-model','OPENFGA_AUTHORIZATION_MODEL_HASH':'desired-hash'}
value={**desired,'AUTH_SECRET':'PRIVATE_BUCKET_SIBLING'}
if mode!='writer_noop':value['OPENFGA_STORE_ID']='old-store'
if mode in ('writer_create','writer_cas_race'):value=None
(root/'bucket.json').write_text(json.dumps(value))
# A stale apparent success must never suppress a fresh read of the changed bucket.
(root/'path-operator.json').write_text(json.dumps({'data':{'data':desired}}))
PY_BUCKET
    sleep() { :; }
    timeout() { shift; "$@"; }
    kubectl() {
      [[ "$*" == 'create token openbao-operator -n default' ]] || { echo 'forbidden writer kubectl lookup/exec' >&2; return 99; }
      printf 'mint\n' >> "$BAO_CACHE_DIR/writer-jwt.calls"
      if [[ "$writer_case" == writer_native_timeout ]]; then echo 'context deadline exceeded PRIVATE_WRITER_SECRET' >&2; return 124; fi
      if [[ "$writer_case" == writer_native_absent ]]; then echo 'Error from server (NotFound): serviceaccounts "openbao-operator" not found PRIVATE_WRITER_SECRET' >&2; return 1; fi
      printf '%s' owned-writer-jwt
    }
    curl() {
      [[ "$1" == --disable && "$*" != *owned-reader-secret* && "$*" != *owned-writer-secret* && "$*" != *owned-writer-jwt* ]] || return 98
      command curl "$@"
    }
    if patch_operator_openfga_config >"$BAO_CACHE_DIR/stdout" 2>"$BAO_CACHE_DIR/diagnostics"; then
      [[ "$writer_case" == writer_noop || "$writer_case" == writer_patch || "$writer_case" == writer_patch_absent || "$writer_case" == writer_create || "$writer_case" == writer_lost_ack || "$writer_case" == writer_login_transient ]]
    else
      [[ "$writer_case" != writer_noop && "$writer_case" != writer_patch && "$writer_case" != writer_patch_absent && "$writer_case" != writer_create && "$writer_case" != writer_lost_ack && "$writer_case" != writer_login_transient ]]
    fi
    python3 - "$BAO_CACHE_DIR" "$writer_case" <<'PY_WRITER_PROOF'
import json,pathlib,sys
root=pathlib.Path(sys.argv[1]);mode=sys.argv[2]
rows=[json.loads(line) for line in (root/'http.calls').read_text().splitlines()]
logins=[r for r in rows if r['path']=='/v1/auth/kubernetes/login']
reads=[r for r in rows if r['method']=='GET']
writes=[r for r in rows if r['path']!='/v1/auth/kubernetes/login' and r['method']!='GET']
mints=(root/'writer-jwt.calls').read_text().splitlines() if (root/'writer-jwt.calls').exists() else []
assert rows[0]['method']=='GET' and all(r['path'] in ('/v1/auth/kubernetes/login','/v1/cogni/data/production/operator') for r in rows)
value=json.loads((root/'bucket.json').read_text())
if mode in ('writer_noop','writer_read_denied','writer_read_malformed'):
 assert len(reads)==1 and not logins and not mints and not writes
elif mode in ('writer_native_absent','writer_native_timeout'):
 assert len(reads)==1 and len(mints)==(3 if mode=='writer_native_timeout' else 1) and not logins and not writes
elif mode=='writer_forbidden':
 assert len(logins)==2 and len(mints)==2 and not writes and len(reads)==1
else:
 assert len(logins)==len(mints)==(2 if mode=='writer_login_transient' else 1)
 assert len(writes)==(2 if mode=='writer_patch_absent' else 1) and len(reads)==2
 if mode=='writer_patch_absent': assert [r['method'] for r in writes]==['PATCH','POST']
 assert writes[0]['method']==('POST' if mode in ('writer_create','writer_cas_race') else 'PATCH')
 if mode=='writer_cas_race': assert value=={'AUTH_SECRET':'concurrent-sibling'}
 if mode in ('writer_patch','writer_lost_ack','writer_login_transient'):
  assert value['AUTH_SECRET']=='PRIVATE_BUCKET_SIBLING' and value['OPENFGA_STORE_ID']=='desired-store'
 if mode in ('writer_unconfirmed','writer_write_denied','writer_patch_unknown404'): assert value['OPENFGA_STORE_ID']=='old-store'
PY_WRITER_PROOF
    if [[ "$writer_case" == writer_noop ]]; then
      printf '%s' '{"data":{"AUTH_SECRET":"forbidden-field"}}' > "$BAO_CACHE_DIR/invalid-writer.json"
      request_count="$(wc -l < "$BAO_CACHE_DIR/http.calls")"
      for bad_route in cogni/data/production/red cogni/data/preview/operator; do
        if openbao_writer_request PATCH "$bad_route" "$BAO_CACHE_DIR/invalid-writer.json" owned-writer-secret "$BAO_CACHE_DIR/rejected" 20 >>"$BAO_CACHE_DIR/diagnostics" 2>&1; then echo 'Writer scope widened' >&2; exit 1; fi
      done
      for bad_method in PATCH POST DELETE; do
        if openbao_writer_request "$bad_method" cogni/data/production/operator "$BAO_CACHE_DIR/invalid-writer.json" owned-writer-secret "$BAO_CACHE_DIR/rejected" 20 >>"$BAO_CACHE_DIR/diagnostics" 2>&1; then echo 'Unreviewed writer body/method accepted' >&2; exit 1; fi
      done
      [[ "$(wc -l < "$BAO_CACHE_DIR/http.calls")" == "$request_count" ]]
    fi
    ! grep -qE 'PRIVATE_|owned-reader-secret|owned-writer-secret|owned-writer-jwt' "$BAO_CACHE_DIR/diagnostics" "$BAO_CACHE_DIR/stdout"
    [[ ! -e "$BAO_CACHE_DIR/http-request.conf" ]]
  )
done
# Exercise the actual fixed Service discovery separately: the real HTTP test
# overrides only its private cache origin, never broadening production discovery.
for service_case in valid namespace selector port external invalid_ip; do
  (
    source "$TMPROOT/functions.sh"
    BAO_CACHE_DIR="$TMPROOT/service-$service_case"; mkdir -p "$BAO_CACHE_DIR"
    timeout() { shift; "$@"; }
    kubectl() {
      [[ "$*" == '-n openbao get service openbao -o json' ]] || return 99
      python3 - "$service_case" <<'PY_SERVICE'
import json,sys
case=sys.argv[1]
s={'metadata':{'name':'openbao','namespace':'openbao'},'spec':{'type':'ClusterIP','clusterIP':'10.43.0.9','selector':{'app.kubernetes.io/name':'openbao','app.kubernetes.io/instance':'openbao','component':'server'},'ports':[{'port':8200,'targetPort':8200,'protocol':'TCP'}]}}
if case=='namespace': s['metadata']['namespace']='foreign'
if case=='selector': s['spec']['selector']['component']='foreign'
if case=='port': s['spec']['ports'][0]['port']=8201
if case=='external': s['spec']['type']='ExternalName'
if case=='invalid_ip': s['spec']['clusterIP']='owned.invalid/path?secret=value'
print(json.dumps(s))
PY_SERVICE
    }
    if address="$(openbao_reader_address 2>"$BAO_CACHE_DIR/diagnostics")"; then [[ "$service_case" == valid && "$address" == http://10.43.0.9:8200 ]]; else [[ "$service_case" != valid && -z "$address" ]]; fi
    ! grep -qE 'secret=value|owned.invalid' "$BAO_CACHE_DIR/diagnostics"
  )
done
# Execute the actual staged validation/publish block. Invalid final consumer
# interpolation must retain the installed generation, despite a complete stage.
publish="$(awk '/^docker compose --project-name cogni-runtime --env-file/ {capture=1} capture {print} capture && /^RUNTIME_ENV="\$INSTALLED_RUNTIME_ENV"$/ {exit}' "$SOURCE")"
[[ -n "$publish" ]]
for config_case in invalid valid; do
  printf '%s' "$initial" > "$INSTALLED_RUNTIME_ENV"
  printf 'complete-staged-generation\n' > "$TMPROOT/next.env"
  if (
    source "$TMPROOT/functions.sh"
    export CONFIG_CASE="$config_case"
    RUNTIME_ENV="$TMPROOT/next.env" RUNTIME_COMPOSE_FILE="$TMPROOT/compose.yml"
    eval "$publish"
  ) > "$TMPROOT/publish" 2>&1; then
    [[ "$config_case" == valid ]]
    [[ "$(cat "$INSTALLED_RUNTIME_ENV")" == complete-staged-generation ]]
  else
    [[ "$config_case" == invalid ]]
    [[ "$(cat "$INSTALLED_RUNTIME_ENV")" == "$initial" ]]
  fi
  [[ "$(cat "$TMPROOT/publish")" != *leaked-secret-marker* ]]
done
# Prove the original failure at the real entry point, not only extracted helpers.
# No runtime GitHub keys or live credentials enter this child. Fake git stops
# before creating a worktree; all transport commands are owned no-network shims.
ENTRY_TMP="$(mktemp -d /tmp/cogni-auth.XXXXXX)"
mkdir -p "$ENTRY_TMP/bin"
cat > "$ENTRY_TMP/bin/git" <<'SH'
#!/usr/bin/env bash
case "$*" in
  *' fetch '*) echo 'owned-source-resolution-sentinel' >&2; exit 41 ;;
  *) exit 42 ;;
esac
SH
cat > "$ENTRY_TMP/bin/ssh" <<'SH'
#!/usr/bin/env bash
[[ "$*" == *' -O exit '* ]] || { echo 'forbidden-transport' >&2; exit 99; }
SH
cat > "$ENTRY_TMP/bin/curl" <<'SH'
#!/usr/bin/env bash
echo 'forbidden-network' >&2
exit 99
SH
chmod +x "$ENTRY_TMP/bin/"*
if entry_output="$(env -i HOME="$ENTRY_TMP" TMPDIR="$ENTRY_TMP" RUNNER_TEMP="$ENTRY_TMP" \
  PATH="$ENTRY_TMP/bin:$PATH" DEPLOY_ENVIRONMENT=preview DOMAIN=owned.invalid VM_HOST=owned.invalid \
  APP_ENV=production COGNI_REPO_URL=https://owned.invalid/repo.git COGNI_REPO_REF=main \
  bash "$SOURCE" --dry-run 2>&1)"; then
  echo 'Entrypoint unexpectedly passed the owned source stop' >&2; exit 1
fi
[[ "$entry_output" == *owned-source-resolution-sentinel* ]] \
  || { echo 'Runtime keys incorrectly blocked the runner before custody/source resolution' >&2; exit 1; }
[[ "$entry_output" != *forbidden-transport* && "$entry_output" != *forbidden-network* ]]
printf 'runtime-secret-authority: root, ownership, real HTTP reader/cache, outage, strict bootstrap and publish checks passed\n'
