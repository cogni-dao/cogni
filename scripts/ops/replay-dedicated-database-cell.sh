#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
# Purpose: Prove one production prestage cell's isolated diagnostic child for 600 seconds.
# Scope: Existing VM PG15 backup client, read-only Bao reader and private actuator observations.
# Invariants: No allocation or parent LOGIN; eight bounded read-only clients; no caller credentials.
set -euo pipefail
umask 077
: "${ALLOW_ISOLATED_DATABASE_CELL_REPLAY:?must equal 1}"
: "${CELL_BINDING_RECEIPT_FILE:?native sealed ready binding required}"
: "${CELL_DIAGNOSTIC_RECEIPT_FILE:?private actor completed clone receipt required}"
: "${CELL_ACTOR_REFERENCE_FILE:?same allocated actor reference required}"
: "${ACTOR_NAMESPACE:?owning production actor namespace required}"
: "${ACTOR_DEPLOYMENT:?owning production actor deployment required}"
: "${SHARED_CONTROL_DEPLOYMENT:?existing shared reliability actuator required}"
: "${SHARED_NODE_ID:?catalog shared controller UUID required}"
: "${SHARED_NODE_SLUG:?catalog shared controller slug required}"
: "${SHARED_SUBSTRATE_HOST:?measured shared physical machine ID required}"
: "${NEIGHBOR_READYZ_URLS:?existing regional neighbor URLs required}"
: "${INCIDENT_REQUEST_RATE:?measured incident requests/second required}"
: "${REPLAY_SQL_FILE:?reviewed read-only workload artifact required}"
[[ "$ALLOW_ISOLATED_DATABASE_CELL_REPLAY" == 1 ]] || exit 2
[[ "$SHARED_SUBSTRATE_HOST" =~ ^[0-9a-f]{32}$ && "$SHARED_NODE_SLUG" =~ ^[a-z][a-z0-9-]*$ && "$SHARED_NODE_ID" =~ ^[0-9a-f-]{36}$ ]] || exit 2
[[ "$ACTOR_NAMESPACE" =~ ^[a-z][a-z0-9-]*$ && "$ACTOR_DEPLOYMENT" =~ ^[a-z][a-z0-9-]*$ && "$SHARED_CONTROL_DEPLOYMENT" =~ ^[a-z][a-z0-9-]*$ ]] || exit 2
for command in docker kubectl jq curl timeout; do command -v "$command" >/dev/null; done
runtime=${DATABASE_CELL_RUNTIME_DIRECTORY:-/opt/cogni-template-runtime}
duration=${REPLAY_DURATION_SECONDS:-600}
[[ "$INCIDENT_REQUEST_RATE" =~ ^[1-9][0-9]*$ ]] || exit 2
rate=${REPLAY_RATE:-$((INCIDENT_REQUEST_RATE * 2))}
[[ "$INCIDENT_REQUEST_RATE" =~ ^[1-9][0-9]*$ && "$duration" == 600 && "$rate" =~ ^[1-9][0-9]*$ && "$rate" -ge $((INCIDENT_REQUEST_RATE*2)) ]] || exit 2
[[ -r "$REPLAY_SQL_FILE" && -f "$runtime/docker-compose.yml" ]] || exit 2
if grep -Eq '^[[:space:]]*\\' "$REPLAY_SQL_FILE"; then
  echo 'reviewed replay must contain SQL only; client shell/meta commands refused' >&2
  exit 2
fi
binding=$(cat "$CELL_BINDING_RECEIPT_FILE")
diagnostic=$(cat "$CELL_DIAGNOSTIC_RECEIPT_FILE")
reference=$(cat "$CELL_ACTOR_REFERENCE_FILE")
jq -en --argjson b "$binding" --argjson d "$diagnostic" --argjson r "$reference" '
 $b.version==1 and $b.phase=="ready" and $b.environment=="production" and $b.provider=="akash" and
 $b.endpoint.tlsMode=="verify-full" and ($b.endpoint.host|test("^[a-zA-Z][a-zA-Z0-9.-]+$")) and
 $d.version==1 and $d.action=="diagnostic-clone" and $d.environment=="production" and
 $d.allocationReceiptId==$b.receiptId and $d.nodeId==$b.nodeId and $d.nodeSlug==$b.nodeSlug and
 $d.providerAccount==$b.providerAccount and $d.dseq==$b.dseq and $d.failureDomainId==$b.failureDomainId and
 $d.systemIdentifier==$b.systemIdentifier and $d.sourceSha==$b.sourceSha and
 $d.sourceDatabaseName==$b.databaseName and $d.databaseName==($b.databaseName+"_diagnostic") and
 $d.replayRole==("replay_"+($d.databaseName|ltrimstr("cogni_"))) and
 $d.connectionLimit==8 and $d.statementTimeoutMs==2000 and ($d.verification.rows|tonumber)>0 and
 $r.cogniKey==$b.cogniKey and $r.externalName==$b.dseq and $r.identity.nodeId==$b.nodeId and
 $r.environment=="production" and $r.nodeSlug==$b.nodeSlug and $r.budgetProfile==$b.budgetProfile
' >/dev/null || { echo 'diagnostic allocation/native receipt mismatch' >&2; exit 1; }
node=$(jq -er '.nodeSlug' <<< "$binding")
source_db=$(jq -er '.databaseName' <<< "$binding")
[[ "$node" =~ ^[a-z][a-z0-9-]*$ && "$source_db" =~ ^cogni_[a-z0-9_]+$ ]] || exit 2
kit=$(mktemp -d /run/cogni-cell-replay.XXXXXXXX)
evidence=${REPLAY_EVIDENCE_FILE:-dedicated-database-cell-replay.jsonl}
load_pid=""
load_container="cogni-cell-replay-$(date +%s)-$$"
cleanup() {
  [[ -z "$load_pid" ]] || { docker stop -t 5 "$load_container" >/dev/null 2>&1 || true; wait "$load_pid" 2>/dev/null || true; }
  rm -rf "$kit"
}
trap cleanup EXIT INT TERM
# Exactly the established production-db-reader consumer seam. Read-only: no kv write/patch.
jwt=$(timeout 10 kubectl create token db-provisioner -n default)
reader=$(timeout 10 kubectl exec -n openbao openbao-0 -- env BAO_ADDR=http://127.0.0.1:8200 bao write -field=token auth/kubernetes/login role=production-db-reader "jwt=$jwt")
unset jwt
read_component() {
  timeout 10 kubectl exec -n openbao openbao-0 -- env BAO_ADDR=http://127.0.0.1:8200 "BAO_TOKEN=$reader" bao kv get "-field=$2" "cogni/production/$1" 2>/dev/null
}
password=$(read_component "${node}-database-replay-${source_db}" DATABASE_CELL_REPLAY_PASSWORD)
[[ "$password" =~ ^[0-9a-f]{48}$ ]] || exit 1
read_component "${node}-database-cell" DATABASE_CELL_TLS_CA_CERTIFICATE > "$kit/ca.crt"
[[ -s "$kit/ca.crt" ]] || exit 1
printf '[replay]\nhost=%s\nport=%s\ndbname=%s\nuser=%s\npassword=%s\nsslmode=verify-full\nconnect_timeout=5\n' \
  "$(jq -er '.endpoint.host' <<< "$binding")" "$(jq -er '.endpoint.port' <<< "$binding")" \
  "$(jq -er '.databaseName' <<< "$diagnostic")" "$(jq -er '.replayRole' <<< "$diagnostic")" "$password" > "$kit/pg_service.conf"
unset password reader
chmod 0600 "$kit/pg_service.conf" "$kit/ca.crt"
cp "$REPLAY_SQL_FILE" "$kit/replay.sql"
compose=(docker compose --project-name cogni-runtime --env-file "$runtime/.env" -f "$runtime/docker-compose.yml" --profile backup)
client=(run --rm --no-deps -e POSTGRES_ROOT_PASSWORD= -e TEMPORAL_DB_PASSWORD= -e PGSERVICEFILE=/replay-kit/pg_service.conf -e PGSSLROOTCERT=/replay-kit/ca.crt -e PGCONNECT_TIMEOUT=5 -v "$kit:/replay-kit:ro")
identity=$("${compose[@]}" "${client[@]}" --entrypoint psql db-backup service=replay -XAtv ON_ERROR_STOP=1 -c 'SELECT public.database_replay_identity()')
jq -en --argjson i "$identity" --argjson b "$binding" --argjson d "$diagnostic" '
 $i.databaseName==$d.databaseName and $i.role==$d.replayRole and $i.systemIdentifier==$b.systemIdentifier and $i.sourceSha==$b.sourceSha
' >/dev/null || { echo 'actual replay connection is not the sealed cell child' >&2; exit 1; }
budget=$("${compose[@]}" "${client[@]}" --entrypoint psql db-backup service=replay -XAtv ON_ERROR_STOP=1 -c "SELECT rolconnlimit=8 AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolinherit AND current_setting('statement_timeout')::interval=interval '2 seconds' AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=role.oid) FROM pg_roles role WHERE rolname=current_user")
[[ "$budget" == t ]] || exit 1
actor_observe() {
 timeout 20 kubectl -n "$ACTOR_NAMESPACE" exec deployment/"$ACTOR_DEPLOYMENT" -c actuator -- node --input-type=module -e '
  import {readFile} from "node:fs/promises";
  const token=(await readFile("/var/run/secrets/akash-tx/AKASH_TX_ACTUATOR_TOKEN","utf8")).trim();
  const response=await fetch("http://127.0.0.1:8080/v1/akash/observe-database-cell-diagnostic",{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:process.argv[1],signal:AbortSignal.timeout(15000)});
  if(!response.ok) process.exit(21);process.stdout.write(await response.text());
 ' "$reference"
}
shared_observe() {
 timeout 25 kubectl -n "$ACTOR_NAMESPACE" exec deployment/"$SHARED_CONTROL_DEPLOYMENT" -c actuator -- node --input-type=module -e '
  import {readFile} from "node:fs/promises";
  import {lookup} from "node:dns/promises";
  const [node,slug,host,cellHost]=process.argv.slice(1);const credential=async name=>(await readFile(`/var/run/secrets/database-reliability/${name}`,"utf8")).trim();
  const bindings=JSON.parse(await credential("DATABASE_RECOVERY_PROBE_URLS_JSON")).filter(b=>b.nodeId===node&&b.nodeSlug===slug&&b.environment==="production");if(bindings.length!==1)process.exit(22);
  const sharedHost=new URL(bindings[0].dsn).hostname;
  const [sharedAddresses,cellAddresses]=await Promise.all([lookup(sharedHost,{all:true}),lookup(cellHost,{all:true})]);
  if(sharedAddresses.some(a=>cellAddresses.some(b=>a.address===b.address)))process.exit(22);
  const token=await credential("DATABASE_RELIABILITY_STATUS_TOKEN");
  const native=await fetch(`http://127.0.0.1:8080/v1/internal/substrate?environment=production&node_slug=${slug}&node_id=${node}`,{headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(5000)}).then(async r=>{if(!r.ok)throw Error();return r.json()});
  if(native.substrateHost!==host||native.latencyMs>=5000)process.exit(23);
  const grafana=new URL(await credential("GRAFANA_URL"));if(grafana.protocol!=="https:"||grafana.username||grafana.password)process.exit(24);const auth={authorization:`Bearer ${await credential("GRAFANA_SERVICE_ACCOUNT_TOKEN")}`};
  const query=async expression=>{const url=new URL("/api/datasources/proxy/uid/grafanacloud-prom/api/v1/query",grafana);url.searchParams.set("query",expression);const r=await fetch(url,{headers:auth,signal:AbortSignal.timeout(5000)});if(!r.ok)throw Error();const body=await r.json();if(body.status!=="success"||body.data.result.length!==1)throw Error();const row=body.data.result[0];if(row.metric.substrate_host!==host||row.metric.node_slug!==slug)throw Error();const value=Number(row.value[1]);if(!Number.isFinite(value))throw Error();return value};
  const labels=`environment="production",node_slug="${slug}",database_tier="shared",budget_profile="shared-default-v1",policy_version="reliability-status-v1",substrate_host="${host}"`;
  const metrics=["io_pressure","connections"].map(signal=>`cogni_reliability_v1_${signal}_percent{${labels}}`);
  const [io,connections,ioAt,connectionsAt]=await Promise.all([query(metrics[0]),query(metrics[1]),query(`timestamp(${metrics[0]})`),query(`timestamp(${metrics[1]})`)]);
  const now=Date.now()/1000;if([ioAt,connectionsAt].some(at=>at>now||now-at>120)||io<0||io>=10||connections<0||connections>=60)process.exit(24);
  process.stdout.write(JSON.stringify({...native,sharedConfiguredHost:sharedHost,sharedAddresses:sharedAddresses.map(a=>a.address),cellAddresses:cellAddresses.map(a=>a.address),ioPressurePct:io,connectionPct:connections,sourceRecordedAt:[ioAt,connectionsAt]}));
 ' "$SHARED_NODE_ID" "$SHARED_NODE_SLUG" "$SHARED_SUBSTRATE_HOST" "$(jq -er '.endpoint.host' <<< "$binding")"
}
scheduler_observe() {
 timeout 20 kubectl -n "$ACTOR_NAMESPACE" exec deployment/scheduler-worker -c scheduler-worker -- node --input-type=module -e '
  import {Connection} from "@temporalio/client";
  const started=performance.now();
  const ready=await fetch("http://127.0.0.1:9000/readyz",{signal:AbortSignal.timeout(5000)});if(!ready.ok)process.exit(34);
  const version=await fetch("http://127.0.0.1:9000/version",{signal:AbortSignal.timeout(5000)}).then(r=>r.json());if(!/^[0-9a-f]{40}$/.test(version.sha))process.exit(35);
  const connection=await Connection.connect({address:process.env.TEMPORAL_ADDRESS,connectTimeout:"5s"});
  try {
   const namespace=process.env.TEMPORAL_NAMESPACE,taskQueue=`${process.env.TEMPORAL_TASK_QUEUE}-${process.argv[1]}`;
   const result=await connection.withDeadline(Date.now()+5000,async()=>{await connection.workflowService.describeNamespace({namespace});return connection.workflowService.describeTaskQueue({namespace,taskQueue:{name:taskQueue},taskQueueType:1})});
   const recent=(result.pollers??[]).filter(p=>{const age=Date.now()-Number(p.lastAccessTime?.seconds??0)*1000;return age>=-15000&&age<=120000});
   if(!recent.length||performance.now()-started>=5000)process.exit(36);
   process.stdout.write(JSON.stringify({buildSha:version.sha,namespace,taskQueue,recentPollers:recent.length,latencyMs:performance.now()-started}));
  }finally{await connection.close()}
 ' "$SHARED_NODE_ID"
}
IFS=',' read -r -a neighbors <<< "$NEIGHBOR_READYZ_URLS"
sample() {
 local cell shared scheduler url code
 cell=$(actor_observe);shared=$(shared_observe);scheduler=$(scheduler_observe)
 jq -en --argjson c "$cell" --argjson s "$shared" --argjson b "$binding" '
  $c.systemIdentifier==$b.systemIdentifier and $c.sourceSha==$b.sourceSha and $c.failureDomainId==$b.failureDomainId and
  $c.parentRolesContained==true and $c.parentRuntimeSessions==0 and $c.connectionLimit==8 and $c.replayConnections<=8 and
  $s.databaseSystemIdentifier!=$b.systemIdentifier and ($s.substrateHost|test("^[0-9a-f]{32}$"))
 ' >/dev/null || { echo 'physical separation or parent fence failed' >&2; exit 1; }
 for url in "${neighbors[@]}"; do
  [[ "$url" == https://* ]] || exit 2
  code=$(curl -4 -sS -o /dev/null --max-time 5 -w '%{http_code}' "$url" || true)
  [[ "$code" == 200 ]] || { echo 'neighbor readiness SLO failed' >&2; exit 1; }
 done
 jq -cn --arg event sample --arg at "$(date -u +%FT%TZ)" --argjson cell "$cell" --argjson shared "$shared" --argjson scheduler "$scheduler" '{event:$event,at:$at,cell:$cell,shared:$shared,schedulerTemporal:$scheduler}' >> "$evidence"
}
: > "$evidence"
sample # All identity/physical-host/control interlocks precede load.
"${compose[@]}" "${client[@]}" --name "$load_container" --entrypoint pgbench db-backup service=replay -n -f /replay-kit/replay.sql -c 8 -j 8 -R "$rate" -T 600 > "${evidence%.jsonl}.pgbench.txt" 2>&1 &
load_pid=$!
started=$(date +%s)
while kill -0 "$load_pid" 2>/dev/null; do sample; sleep 5; done
wait "$load_pid";load_pid=""
[[ $(( $(date +%s)-started )) -ge 600 ]] || { echo 'replay ended before sustained600s' >&2; exit 1; }
sample
jq -cn --arg event complete --arg sourceSha "$(jq -r '.sourceSha' <<< "$binding")" --arg workloadSha256 "$(sha256sum "$REPLAY_SQL_FILE" | awk '{print $1}')" --argjson rate "$rate" '{event:$event,result:"pass",proofClass:"isolated-diagnostic",sourceSha:$sourceSha,clients:8,durationSeconds:600,rate:$rate,workloadSha256:$workloadSha256,parentRolesRemainContained:true}' >> "$evidence"
printf '%s\n' "$evidence"
