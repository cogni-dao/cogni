#!/usr/bin/env bash
# Candidate-only direct DB replay. Emits JSONL evidence and fails on any neighbor miss.
set -euo pipefail

: "${ALLOW_CANDIDATE_DATABASE_REPLAY:?must equal 1}"
: "${POLY_CELL_DSN:?candidate dedicated-cell read-role DSN required}"
: "${SHARED_DB_DSN:?candidate shared Postgres DSN required}"
: "${NEIGHBOR_READYZ_URLS:?comma-separated regional readyz URLs required}"
: "${SHARED_IO_PSI_QUERY_URL:?Prometheus instant-query URL required}"
: "${INCIDENT_REQUEST_RATE:?measured incident requests/second required}"

[[ "$ALLOW_CANDIDATE_DATABASE_REPLAY" == 1 ]] || { echo "candidate replay not authorized" >&2; exit 2; }
[[ "${DEPLOY_ENVIRONMENT:-}" == candidate-a ]] || { echo "candidate-a only" >&2; exit 2; }
command -v pgbench >/dev/null && command -v psql >/dev/null && command -v jq >/dev/null

root_dir=$(git rev-parse --show-toplevel)
replay_sql=${REPLAY_SQL_FILE:-$root_dir/scripts/ops/poly-dedicated-cell-replay.sql}
duration=${REPLAY_DURATION_SECONDS:-1800}
clients=${REPLAY_CLIENTS:-8}
rate=${REPLAY_RATE:-$((INCIDENT_REQUEST_RATE * 2))}
evidence=${REPLAY_EVIDENCE_FILE:-poly-dedicated-cell-replay.jsonl}
[[ "$clients" -ge 8 && "$duration" -ge 1800 && "$rate" -ge $((INCIDENT_REQUEST_RATE * 2)) ]] || {
  echo "requires >=8 clients, >=1800s, and >=2x incident rate" >&2; exit 2;
}

cell_addr=$(psql "$POLY_CELL_DSN" -XAtqc "select inet_server_addr()::text")
shared_addr=$(psql "$SHARED_DB_DSN" -XAtqc "select inet_server_addr()::text")
[[ -n "$cell_addr" && -n "$shared_addr" && "$cell_addr" != "$shared_addr" ]] || {
  echo "dedicated and shared databases are not separate hosts" >&2; exit 2;
}

sha=$(git rev-parse HEAD)
replay_id="poly-cell-${sha:0:12}-$(date -u +%Y%m%dT%H%M%SZ)"
jq -cn --arg event start --arg replayId "$replay_id" --arg sha "$sha" \
  --arg cell "$cell_addr" --arg shared "$shared_addr" --argjson clients "$clients" \
  --argjson rate "$rate" '{event:$event,replayId:$replayId,sha:$sha,cell:$cell,shared:$shared,clients:$clients,rate:$rate}' >"$evidence"

cleanup() { [[ -n "${load_pid:-}" ]] && kill "$load_pid" 2>/dev/null || true; }
trap cleanup EXIT INT TERM
pgbench "$POLY_CELL_DSN" -n -f "$replay_sql" -c "$clients" -j "$clients" -R "$rate" -T "$duration" \
  >"${evidence%.jsonl}.pgbench.txt" 2>&1 &
load_pid=$!

IFS=',' read -r -a urls <<<"$NEIGHBOR_READYZ_URLS"
while kill -0 "$load_pid" 2>/dev/null; do
  sampled_at=$(date -u +%FT%TZ)
  connections=$(psql "$SHARED_DB_DSN" -XAtqc \
    "select count(*)::float / current_setting('max_connections')::int from pg_stat_activity")
  psi=$(curl -fsS --max-time 5 ${METRICS_AUTH_HEADER:+-H "$METRICS_AUTH_HEADER"} \
    "$SHARED_IO_PSI_QUERY_URL" | jq -er '.data.result[0].value[1] | tonumber')
  awk "BEGIN { exit !($connections < 0.60) }" || { echo "shared connections >=60%" >&2; exit 1; }
  awk "BEGIN { exit !($psi < 0.10) }" || { echo "shared I/O PSI >=10%" >&2; exit 1; }
  for url in "${urls[@]}"; do
    code=$(curl -sS -o /dev/null --max-time 5 -w '%{http_code}' "$url" || true)
    jq -cn --arg event sample --arg replayId "$replay_id" --arg at "$sampled_at" \
      --arg url "$url" --arg code "$code" --argjson sharedConnections "$connections" \
      --argjson sharedIoPsi "$psi" \
      '{event:$event,replayId:$replayId,at:$at,url:$url,httpCode:$code,sharedConnections:$sharedConnections,sharedIoPsi:$sharedIoPsi}' >>"$evidence"
    [[ "$code" == 200 ]] || { echo "neighbor SLO miss: $url HTTP $code" >&2; exit 1; }
  done
  sleep 5
done
wait "$load_pid"
load_pid=
jq -cn --arg event complete --arg replayId "$replay_id" --arg at "$(date -u +%FT%TZ)" \
  '{event:$event,replayId:$replayId,at:$at,result:"pass"}' >>"$evidence"
echo "$evidence"
