#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# secret-materialize.sh — writer of node-owned source:agent app secrets.
#
# Runs before reconcile-substrate for one catalog node. Per
# docs/spec/secrets-management.md Invariants 15/16 and
# docs/design/node-wizard-secret-setting.md, AS BUILT today:
#   - input is the secrets catalog ONLY; it never reads the VM runtime .env;
#   - read-once → diff → write-missing-mostly: one prefetch of the node + ancestor
#     paths, a single batched write of just the absent keys, O(1) ssh per node.
#     Canonical composed values overwrite only on drift. A re-flight of a born,
#     converged node writes NOTHING (created=0; 0 pod churn);
#   - shared/human values are inherited transitionally (see inherit_shared_value);
#   - it logs key NAMES only, never values.
#   - catalog `syncTo: litellm-virtual-key` entries are registered with LiteLLM
#     only after the OpenBao batch is durable; registration is idempotent and
#     fail-closed.
#   - after the node batch, the OWNER leg (operator) mints the `source: agent` keys of
#     the non-node PLATFORM_SERVICES into their own `cogni/<env>/<service>/*` buckets.
#     Those services exist precisely so a credential is NOT reachable from the operator
#     app's `dataFrom: extract` bucket (story.5016 secret-boundary amendments).
#
# SOLE WRITER: this script composes + writes all per-node DB DSNs (DATABASE_URL,
# DATABASE_SERVICE_URL, DOLTGRES_URL) to cogni/<env>/<node> from OpenBao-owned
# component passwords; reconcile-substrate is read-only (db-reader token, zero
# writes). DATABASE_URL/_SERVICE_URL use per-node app_<node>/service_<node>
# passwords (#1584); DOLTGRES_URL uses DOLTGRES_PASSWORD, the env Doltgres
# superuser derived from POSTGRES_ROOT_PASSWORD and materialized per-node (this PR).
# The falsifying gate (delete VM .env DOLTGRES_PASSWORD → deploy green from OpenBao
# only) holds once provisioners read DOLTGRES_PASSWORD from OpenBao (deploy-infra).
#
# It does NOT apply ExternalSecrets, touch edge/DB inventory, or run provisioners
# — those are reconcile-substrate's responsibilities.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

DEPLOY_ENVIRONMENT="${1:-${DEPLOY_ENVIRONMENT:-}}"
TARGET_NODE="${2:-${TARGET:-}}"
APP_SOURCE_DIR="${APP_SOURCE_DIR:-$REPO_ROOT}"
SSH_BIN="${SECRET_MATERIALIZE_SSH_BIN:-ssh}"
SSH_OPTS_RAW="${SSH_OPTS:--i ~/.ssh/deploy_key -o StrictHostKeyChecking=accept-new -o ConnectTimeout=30 -o ServerAliveInterval=10 -o ServerAliveCountMax=6}"

fail() {
  echo "::error::secret-materialize: $*" >&2
  exit 1
}

log() {
  printf '[secret-materialize] %s\n' "$*"
}

log_info() {
  log "$*"
}

usage() {
  cat >&2 <<'USAGE'
Usage: secret-materialize.sh <candidate-a|preview|production> <node>

Required env:
  VM_HOST

Optional env:
  APP_SOURCE_DIR, SSH_OPTS
USAGE
}

[[ -n "$DEPLOY_ENVIRONMENT" && -n "$TARGET_NODE" ]] || { usage; exit 2; }
[[ "$DEPLOY_ENVIRONMENT" =~ ^(candidate-a|preview|production)$ ]] \
  || fail "unsupported env '$DEPLOY_ENVIRONMENT'"
[[ -n "${VM_HOST:-}" ]] || fail "VM_HOST is required"

case "$APP_SOURCE_DIR" in
  /*) ;;
  *) APP_SOURCE_DIR="$(cd "$APP_SOURCE_DIR" 2>/dev/null && pwd)" || fail "missing app source dir: $APP_SOURCE_DIR" ;;
esac

# shellcheck source=lib/image-tags.sh
source "$SCRIPT_DIR/lib/image-tags.sh"

node_known=false
for node in "${NODE_TARGETS[@]}"; do
  if [[ "$node" == "$TARGET_NODE" ]]; then
    node_known=true
    break
  fi
done
"$node_known" || fail "target '$TARGET_NODE' is not a type=node catalog target"

read -r -a SSH_OPTS_ARR <<< "$SSH_OPTS_RAW"
# bug.5159 — multiplex every remote call over ONE ssh connection. Each remote() used to
# open a fresh handshake (~20-40 per run); sshd/edge admission control drops bursts of
# new connections at kex (MaxStartups-class), which killed 8 promotes. One master
# connection removes the burst entirely; ControlPersist outlives the run harmlessly on
# an ephemeral runner.
SSH_OPTS_ARR+=(-o ControlMaster=auto -o "ControlPath=${TMPDIR:-/tmp}/cogni-ssh-%r@%h-%p" -o ControlPersist=180)
# shellcheck source=lib/ssh-retry.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/ssh-retry.sh"
remote() {
  cogni_ssh_transport_retry "$SSH_BIN" "${SSH_OPTS_ARR[@]}" "root@${VM_HOST}" "$@"
}

# WRITER IDENTITY IS THE CLUSTER'S; THE PATH IS THE LANE'S (bug.5206).
#
# `DEPLOY_ENVIRONMENT` named two different things here: WHO writes (the role minted just
# below) and WHERE (`cogni/<env>/<svc>`, further down). They are the same string for a k3s
# row and for any lane whose own cluster reconciles it — and different the moment the PAYING
# cluster reconciles another lane, which is the whole of task.5132.
#
# This is the third instance of one conflation. #2305 split the AppSet DIRECTORY from its
# filename with `control_env_for`; #2300 split the ACTUATOR ADDRESS from the XR namespace
# with `actuatorNamespace`; this splits the WRITER from the PATH. Same rule each time: the
# artifact belongs to the cluster that reconciles it, the name belongs to the lane.
#
# ONE WRITER IDENTITY PER ACCOUNT (NS3). We mint the CONTROL env's existing role — never a
# per-lane role in this vault, which would be a second writer identity on one Console
# account. `production-writer` writing `cogni/candidate-a/poly` is one custodian holding a
# lane it already reconciles and pays for (#2290); a `candidate-a-writer` role living in
# production's vault would be two.
#
# Defaults to the lane, so every existing caller is byte-identical: for k3s rows and for
# production the control env IS the env, and this resolves to exactly the old role.
SECRETS_CONTROL_ENV="${SECRETS_CONTROL_ENV:-$DEPLOY_ENVIRONMENT}"
[[ "$SECRETS_CONTROL_ENV" =~ ^(candidate-a|preview|production)$ ]] \
  || fail "unsupported SECRETS_CONTROL_ENV '$SECRETS_CONTROL_ENV'"

# Mint the <control-env>-writer token via the sanctioned k8s-auth seam. Target: this is
# the only phase permitted to hold it (Invariant 16 token boundary). Transitional:
# reconcile-substrate also mints it to seed DSNs until the env-repair lane lands.
BAO_TOKEN="$(
  cogni_openbao_kubernetes_login_retry remote "set -euo pipefail
    jwt=\$(kubectl create token openbao-operator -n default)
    kubectl exec -n openbao openbao-0 -- env BAO_ADDR=http://127.0.0.1:8200 \
      bao write -field=token auth/kubernetes/login role='${SECRETS_CONTROL_ENV}-writer' jwt=\"\$jwt\""
)"
[[ -n "$BAO_TOKEN" ]] || fail "could not mint ${SECRETS_CONTROL_ENV}-writer token (writing the '${DEPLOY_ENVIRONMENT}' lane)"
if [[ "$SECRETS_CONTROL_ENV" != "$DEPLOY_ENVIRONMENT" ]]; then
  echo "[secret-materialize] writing the '${DEPLOY_ENVIRONMENT}' lane into ${SECRETS_CONTROL_ENV}'s vault as ${SECRETS_CONTROL_ENV}-writer (bug.5206)"
fi

export REPO_ROOT APP_SOURCE_DIR
export DEPLOY_ENV="$DEPLOY_ENVIRONMENT"
export VM_IP="${VM_IP:-$(remote "hostname -I | awk '{print \$1}'" | tr -d '[:space:]')}"
export CATALOG_FILE="${APP_SOURCE_DIR}/infra/secrets-catalog.yaml"
export PAYMENT_NODES="${PAYMENT_NODES:-poly}"
# DOMAIN is required: derive-env keys (APP_BASE_URL, NEXTAUTH_URL) build the
# node FQDN from it. Empty DOMAIN would silently materialize broken https://<host>
# values, so fail loud (mirrors reconcile-node-substrate.sh).
[[ -n "${DOMAIN:-}" ]] || fail "DOMAIN is required (derive-env keys build the node FQDN)"
export DOMAIN

# bug.5240 — CI-derived bootstrap for the lease-log pump's Loki push credential.
# The lease-log pump (operator control plane) needs LOKI_LEASE_PUSH_{URL,USER,TOKEN} at
# cogni/<env>/operator or its projected mount fails (bug.5142 ordering). Until a human
# mints the DEDICATED logs:write token the catalog asks for, fall back to the CI Loki
# credential the workflows already hold — same trust plane (the token never leaves the
# operator control plane; the app-push lane that shipped it into leases is superseded).
# Passthrough seeding below is create-if-absent, so a later `pnpm secrets:set` with a
# dedicated token is never clobbered. Empty CI env ⇒ the keys are simply skipped.
export LOKI_LEASE_PUSH_URL="${LOKI_LEASE_PUSH_URL:-${GRAFANA_CLOUD_LOKI_URL:-}}"
export LOKI_LEASE_PUSH_USER="${LOKI_LEASE_PUSH_USER:-${GRAFANA_CLOUD_LOKI_USER:-}}"
export LOKI_LEASE_PUSH_TOKEN="${LOKI_LEASE_PUSH_TOKEN:-${GRAFANA_CLOUD_LOKI_API_KEY:-}}"

# shellcheck source=../setup/lib/reconcile-secrets.sh
# Provides NODE_BASELINE_KEYS, derive_secret, and _resolve_node_value
# (preserve-existing + per-node generate; no blind ancestor scan). External
# mirrors are discovered separately from catalog syncTo declarations below;
# they do not extend the legacy NODE_BASELINE_KEYS list.
# Sourced FIRST so the token-bound bao_get_field/seed_kv below override the lib's
# ROOT_TOKEN/ssh variants.
source "$REPO_ROOT/scripts/setup/lib/reconcile-secrets.sh"

TARGET_CATALOG_FILE="${APP_SOURCE_DIR}/nodes/${TARGET_NODE}/.cogni/secrets-catalog.yaml"
CATALOG_FILES=("$CATALOG_FILE")
[[ -f "$TARGET_CATALOG_FILE" ]] && CATALOG_FILES+=("$TARGET_CATALOG_FILE")

# Read a field from the operator catalog or this target node's sovereign catalog.
# The typed loader rejects cross-file name collisions in CI; this shell reader
# intentionally consumes the same two declaration surfaces during the flight.
_cat_field() {
  local name="$1" field="$2" file value
  for file in "${CATALOG_FILES[@]}"; do
    value="$(yq -N "(.secrets[] | select(.name == \"${name}\") | ${field}) // \"\"" "$file" 2>/dev/null | head -1)"
    if [[ -n "$value" ]]; then
      printf '%s' "$value"
      return 0
    fi
  done
}

# Batched, idempotent OpenBao I/O (read-once → diff → write-missing-only).
#
# OpenBao is ClusterIP with no Ingress (infra/k8s/argocd/openbao/values.yaml), so
# the only access from a CI runner is ssh→kubectl exec. The previous shape did
# ~6 of those round-trips PER KEY (ancestor scan + existing-read + metadata +
# write) and re-wrote every key every run. This collapses it to O(1) ssh per
# node: one prefetch of the node + ancestor paths into an on-disk cache, then a
# single batched write of ONLY the keys that are missing. A re-flight of a
# born node reads the cache, finds every key present, writes nothing, and exits.
# (North star: move this into an in-cluster Job that talks to OpenBao over
# ClusterIP and drop ssh entirely — docs/design/node-wizard-secret-setting.md.)
CACHE_DIR="$(mktemp -d -t materialize-cache.XXXXXX)"
# One batch dir PER OpenBao service path. The node path is the common case; a platform
# service (see PLATFORM_SERVICES below) accumulates into its own dir so one flush can
# never patch another service's bucket.
BATCH_ROOT="${CACHE_DIR}/.batch"
mkdir -p "${BATCH_ROOT}/${TARGET_NODE}"
trap 'rm -rf "$CACHE_DIR"' EXIT

bao_exec() {
  remote "kubectl exec ${1} -n openbao openbao-0 -- env BAO_TOKEN='${BAO_TOKEN}' BAO_ADDR=http://127.0.0.1:8200 bao ${2}"
}

# Prefetch one path's full key/value map into the cache (one ssh). Runner-side jq
# extracts; the remote only runs the proven `bao kv get -format=json` shape.
#
# bug.5159 — a TRANSPORT failure (ssh drop, exec hiccup, OpenBao down) must never read
# as an EMPTY BUCKET: that lie cascades into "key absent" errors downstream, and worse,
# a false-empty cache would let materialize re-mint values that already exist. Only the
# explicit "No value found" answer (a genuinely unborn path) maps to {}; anything else
# is retried and then fatal, naming the transport.
prefetch_path() {
  local svc="$1" env="${2:-$DEPLOY_ENVIRONMENT}" ns="${3:-$1}" json raw attempt
  raw=""
  for attempt in 1 2 3; do
    if raw="$(bao_exec "" "kv get -format=json 'cogni/${env}/${svc}'" 2>&1)"; then
      break
    fi
    case "$raw" in
      *"No value found"*) raw='{}'; break ;;
    esac
    echo "[secret-materialize] OpenBao read cogni/${env}/${svc} attempt ${attempt}/3 failed: $(printf '%s' "$raw" | tail -1)" >&2
    [[ "$attempt" == 3 ]] && { echo "::error::secret-materialize: transport failure reading cogni/${env}/${svc} after 3 attempts — NOT an absent path (bug.5159)" >&2; exit 1; }
    sleep $((attempt * 5))
  done
  json="$(printf '%s' "$raw" | jq -c '.data.data // {}' 2>/dev/null || true)"
  [[ -z "$json" ]] && json='{}'
  mkdir -p "${CACHE_DIR}/${ns}"
  while IFS=$'\t' read -r key val; do
    [[ -z "$key" ]] && continue
    printf '%s' "$val" > "${CACHE_DIR}/${ns}/${key}"
  done < <(printf '%s' "$json" | jq -r 'to_entries[] | [.key, .value] | @tsv')
}

# Reads serve from the cache the single prefetch populated — no per-key ssh.
# Overrides the lib's ssh/ROOT_TOKEN variants (sourced above).
bao_get_field() {
  local f="${CACHE_DIR}/$1/$2"
  [[ -f "$f" ]] && { cat "$f"; return 0; }
  # SHARED-SUBSTRATE OWNERS LIVE WHERE THE SUBSTRATE DOES (bug.5206). A foreign-custodied
  # lane runs on the CONTROL env's substrate, so its LiteLLM master key, Doltgres superuser
  # and _shared values are that cluster's, not the lane's — `cogni/candidate-a/operator`
  # does not exist in production's vault and never should. This dir is populated ONLY when
  # the control env differs from the lane, so for every row today the lookup ends above.
  f="${CACHE_DIR}/__owner__/$1/$2"
  [[ -f "$f" ]] && cat "$f" || true
}

# Writes accumulate into BATCH_ROOT/<service>; an already-present key is a no-op
# (idempotent — preserve existing, 0 pod churn). flush_batch writes once.
seed_kv() {
  local svc="$1" k="$2" v="$3"
  [[ -z "$v" ]] && return 0
  [[ -f "${CACHE_DIR}/${svc}/${k}" ]] && return 0
  mkdir -p "${BATCH_ROOT}/${svc}"
  printf '%s' "$v" > "${BATCH_ROOT}/${svc}/${k}"
  # Reflect the just-written value in the cache so intra-run compositions resolve
  # within the same pass — e.g. DATABASE_URL (composed later in the loop) reads the
  # APP_DB_PASSWORD generated a few keys earlier via bao_get_field. flush_batch still
  # does the single OpenBao write; this only affects in-run reads.
  mkdir -p "${CACHE_DIR}/${svc}"
  printf '%s' "$v" > "${CACHE_DIR}/${svc}/${k}"
}

# One write for all missing keys. JSON is built locally via jq --rawfile so no
# secret value ever lands on a command line.
#
# bug.5068: `cogni/<env>/<node>` is a SHARED bucket (baseline keys + any self-serve
# secrets a node-owner set via the operator API). `bao kv put` REPLACES the whole
# bucket. The old shape chose put/patch off NODE_PATH_EXISTS, which is set from a
# `kv metadata get` precheck — a TRANSIENT failure of that precheck against a
# populated bucket flipped it to `put` and clobbered every key not in this batch.
# Fix: `patch` FIRST (merges — never clobbers siblings) regardless of the precheck,
# and only fall back to a destructive `put` on a POSITIVE "does not exist" signal in
# patch's OWN output. Any other failure returns non-zero without clobbering.
flush_batch() {
  local svc="${1:-$TARGET_NODE}"
  local batch_dir="${BATCH_ROOT}/${svc}"
  [[ -d "$batch_dir" ]] || return 0
  local files=( "$batch_dir"/* )
  [[ -e "${files[0]}" ]] || return 0
  local json='{}' f k out rc
  for f in "${files[@]}"; do
    k="$(basename "$f")"
    json="$(jq --arg k "$k" --rawfile v "$f" '.[$k]=$v' <<<"$json")"
  done
  set +e
  out="$(printf '%s' "$json" | bao_exec "-i" "kv patch 'cogni/${DEPLOY_ENVIRONMENT}/${svc}' -" 2>&1)"
  rc=$?
  set -e
  if [[ $rc -eq 0 ]]; then
    return 0
  fi
  # A kv patch on a never-written KV v2 path returns `Code: 404` with an EMPTY raw
  # message (no "not found" text) — unambiguous absence on a FRESH node/env, so put
  # cannot clobber siblings (mirrors provision seed_kv fix a54f24809b).
  if printf '%s' "$out" | grep -qiE 'no value found|does not exist|not found|code: 404'; then
    # Genuinely absent — safe to create; no siblings to clobber.
    printf '%s' "$json" | bao_exec "-i" "kv put 'cogni/${DEPLOY_ENVIRONMENT}/${svc}' -" >/dev/null
    return $?
  fi
  # Transient/unknown failure — NEVER put (would wipe sibling keys at this shared
  # node path). Fail loud so materialize is retried against an intact bucket.
  printf '%s\n' "$out" >&2
  fail "bao kv patch on cogni/${DEPLOY_ENVIRONMENT}/${svc} failed (rc=${rc}) without a positive 'absent' signal; refusing to put (would clobber sibling keys)"
}

# Is this key minted fresh per-node (source:agent random)? Such keys are NEVER
# inherited — skip the ancestor scan for them (the wasted round-trips the old
# shape paid). Mirrors _resolve_node_value's agent branch.
key_is_agent_generated() {
  local k="$1"
  [[ "$(_cat_field "$k" '.source')" == "agent" \
    && "$(_cat_field "$k" '.service')" != "_shared" \
    && "$(_cat_field "$k" '.shared')" != "true" \
    && "$(_cat_field "$k" '.generate.kind')" =~ ^(base64|hex|sk-cogni)$ ]]
}

# Node-owned secrets only (node-baas-architecture.md: each node owns its own DB
# + secrets). All three DSNs are now composed + written here — the bug.5002
# sole-source cutover, complete for both planes:
#   DATABASE_URL / DATABASE_SERVICE_URL  from per-node app_<node>/service_<node>
#     passwords (source:agent at cogni/<env>/<node>);
#   DOLTGRES_URL                         from DOLTGRES_PASSWORD — the env Doltgres
#     superuser, derived from POSTGRES_ROOT_PASSWORD and materialized per-node just
#     above it in NODE_BASELINE_KEYS (the pod connects as that superuser because
#     Doltgres 0.56.3 RBAC is table-DML-only — databases.md §5.2).
# Nothing is deferred: materialize is the SOLE OpenBao writer of all per-node DSNs,
# reconcile is read-only. The DSN_DEFER mechanism is retained (empty) so a future
# transitional key can be parked without re-introducing the loop guard.
DSN_DEFER_KEYS=" "

# The per-node Postgres DSNs are COMPOSED from the per-node app_<node>/service_<node>
# role (#1584). DOLTGRES_URL is composed from the operator-canonical Doltgres
# superuser (cogni/<env>/operator/DOLTGRES_PASSWORD), which is shared env-wide and
# immutable post-init (Doltgres 0.56.3 can't ALTER it; databases.md §5.2).
#
# All three DSNs are recomposed authoritatively every run and overwritten ONLY on
# drift. Compare-then-write keeps a correct DSN byte-stable, so healthy nodes see
# zero churn while a half-migrated node self-heals. This includes stale per-node
# DOLTGRES_URL copies: node-substrate provisions with the operator SSOT, so the pod
# must receive a URL derived from that same SSOT or the migrator 28P01s.
COMPOSED_DSN_KEYS=" DATABASE_URL DATABASE_SERVICE_URL DOLTGRES_URL "

# Transitional shared/human inheritance — the blind ancestor scan the north star
# replaces with explicit catalog `inheritFrom` (catalog-custody lane). Now serves
# from the prefetched cache, and only runs for non-agent keys.
inherit_shared_value() {
  local k="$1" v="" from=""
  [[ -n "${!k:-}" ]] && return 0
  # Explicit catalog `inheritFrom: <service>` — the canonical-custody lane that
  # replaces the blind ancestor scan for keys whose value must byte-match ONE
  # owner (e.g. SCHEDULER_API_TOKEN must equal the token the worker SENDS, which
  # deploy-infra writes into scheduler-worker-secrets from cogni/<env>/operator). bug.5021.
  from="$(_cat_field "$k" '.inheritFrom')"
  if [[ -n "$from" && "$from" != "null" ]]; then
    v="$(bao_get_field "$from" "$k")"
    [[ -n "$v" ]] && export "${k}=${v}"
    return 0
  fi
  for svc in node-template operator _shared; do
    v="$(bao_get_field "$svc" "$k")"
    if [[ -n "$v" ]]; then export "${k}=${v}"; return 0; fi
  done
  return 0
}

# One prefetch: node/ancestor key maps (O(1) ssh). operator is the inheritFrom
# source for SCHEDULER_API_TOKEN (bug.5021) and is already in the prefetch set
# below, so bao_get_field (cache-only) resolves it.
# (bug.5068: the old `kv metadata get` node-path-existence precheck was removed —
# flush_batch now derives create-vs-merge from patch's own output, so a transient
# precheck failure can no longer flip a merge into a bucket-clobbering put.)
for svc in "$TARGET_NODE" node-template operator _shared; do
  prefetch_path "$svc"
done
# Ancestors, re-read from the cluster that HOSTS this lane's substrate. Additive: the
# lane's own buckets are still prefetched above and still win; this only supplies what a
# foreign lane structurally cannot have locally. No-op when control env == lane.
if [[ "${SECRETS_CONTROL_ENV}" != "$DEPLOY_ENVIRONMENT" ]]; then
  for svc in node-template operator _shared; do
    prefetch_path "$svc" "$SECRETS_CONTROL_ENV" "__owner__/$svc"
  done
fi

log "materializing node-owned OpenBao values for ${DEPLOY_ENVIRONMENT}/${TARGET_NODE} (key names only)"
created=0
unchanged=0
for k in "${NODE_BASELINE_KEYS[@]}"; do
  case "$DSN_DEFER_KEYS" in *" $k "*) continue ;; esac
  _node_gets_key "$TARGET_NODE" "$k" || continue
  # Composed DSN: recompose authoritatively (bypass _resolve's preserve-existing)
  # and overwrite ONLY when the stored value drifted from the canonical
  # composition. Healthy nodes match → no write → no pod churn.
  if [[ " $COMPOSED_DSN_KEYS " == *" $k "* ]]; then
    v="$(_compose_node_value "$TARGET_NODE" "$k")"
    [[ -z "$v" ]] && continue
    if [[ "$(bao_get_field "$TARGET_NODE" "$k")" == "$v" ]]; then
      unchanged=$((unchanged + 1))
      continue
    fi
    rm -f "${CACHE_DIR}/${TARGET_NODE}/${k}"   # clear stale cache so seed_kv writes
    seed_kv "$TARGET_NODE" "$k" "$v"
    log "  recomposed ${k} (drift corrected)"
    created=$((created + 1))
    continue
  fi
  # inheritFrom keys: a single canonical owner holds the authoritative value
  # (SCHEDULER_API_TOKEN ← operator, the exact token the worker SENDS).
  # The node MUST byte-match it, so — like composed DSNs — we overwrite-on-drift
  # instead of preserve-existing. A freshly-formed node that inherited a
  # divergent ancestor self-heals on the next materialize, killing the
  # worker→node 401 (bug.5021). No-op when already equal (no pod churn).
  inherit_from="$(_cat_field "$k" '.inheritFrom')"
  if [[ -n "$inherit_from" && "$inherit_from" != "null" ]]; then
    v="$(bao_get_field "$inherit_from" "$k")"
    [[ -z "$v" ]] && continue
    if [[ "$(bao_get_field "$TARGET_NODE" "$k")" == "$v" ]]; then
      unchanged=$((unchanged + 1))
      continue
    fi
    rm -f "${CACHE_DIR}/${TARGET_NODE}/${k}"
    seed_kv "$TARGET_NODE" "$k" "$v"
    log "  inherited ${k} from ${inherit_from} (drift corrected)"
    created=$((created + 1))
    continue
  fi
  if [[ -f "${CACHE_DIR}/${TARGET_NODE}/${k}" ]]; then
    unchanged=$((unchanged + 1))
    continue
  fi
  key_is_agent_generated "$k" || inherit_shared_value "$k"
  v="$(_resolve_node_value "$TARGET_NODE" "$k")"
  [[ -z "$v" ]] && continue
  seed_kv "$TARGET_NODE" "$k" "$v"
  log "  created ${k}"
  created=$((created + 1))
done

# External mirror keys are declared by catalog syncTo, not a second baseline
# array. Materialize their OpenBao value before the batch is flushed so the
# registration phase below always reads the exact durable value.
mapfile -t LITELLM_SYNC_KEYS < <(
  yq -N '.secrets[] | select(.syncTo == "litellm-virtual-key") | .name' \
    "${CATALOG_FILES[@]}" | LC_ALL=C sort -u
)
for k in "${LITELLM_SYNC_KEYS[@]}"; do
  _node_gets_key "$TARGET_NODE" "$k" || continue
  if [[ -f "${CACHE_DIR}/${TARGET_NODE}/${k}" ]]; then
    unchanged=$((unchanged + 1))
    continue
  fi
  key_is_agent_generated "$k" \
    || fail "catalog sync target ${k} must be a per-node source:agent random key"
  v="$(_resolve_node_value "$TARGET_NODE" "$k")"
  [[ -n "$v" ]] || fail "catalog sync target ${k} produced an empty value"
  seed_kv "$TARGET_NODE" "$k" "$v"
  log "  created ${k}"
  created=$((created + 1))
done
flush_batch

# ── Platform-service agent secrets (non-node OpenBao buckets) ─────────────────
# PLATFORM_SERVICES (reconcile-secrets.sh) own `cogni/<env>/<service>/*` instead of
# borrowing a node's bucket, because the operator app consumes the WHOLE operator bucket
# via `dataFrom: extract` — parking a wallet credential there hands it to the public app.
# Their `source: agent` keys still have to be MINTED, and the killer rule (cicd-secrets-expert)
# forbids a human typing a generated value, so this lane mints them exactly like node keys:
# catalog-declared generator, idempotent read-once → diff → write-missing, key NAMES only.
# `source: human` keys here are untouched — a vendor-minted value is seeded through the
# sanctioned write path (`pnpm secrets:set <env> <service> <KEY>`), never generated.
#
# SINGLE WRITER, NOT PER-MATRIX-NODE. node-substrate is a PARALLEL matrix over nodes; if
# every leg wrote these paths, two legs could each mint a fresh token on a cold bucket and
# the loser's value would already be projected somewhere. The owner node runs the pass once.
# `infra/k8s/base/akash-tx-actuator/*` maps to the operator target in detect-affected.sh, so
# any change to a platform service's manifests already brings its owner leg along.
PLATFORM_SERVICE_OWNER_NODE="${PLATFORM_SERVICE_OWNER_NODE:-operator}"
if [[ "$TARGET_NODE" == "$PLATFORM_SERVICE_OWNER_NODE" ]]; then
  for svc in "${PLATFORM_SERVICES[@]}"; do
    prefetch_path "$svc"
    mapfile -t svc_keys < <(
      yq -N ".secrets[] | select(.service == \"${svc}\" and .source == \"agent\") | .name" \
        "${CATALOG_FILES[@]}" | LC_ALL=C sort -u
    )
    for k in "${svc_keys[@]}"; do
      [[ -n "$k" ]] || continue
      if [[ -f "${CACHE_DIR}/${svc}/${k}" ]]; then
        unchanged=$((unchanged + 1))
        continue
      fi
      key_is_agent_generated "$k" \
        || fail "platform-service key ${svc}/${k} declares source: agent but no random generator; a generated secret must never need a human"
      v="$(_compose_node_value "$svc" "$k")"
      [[ -n "$v" ]] || fail "platform-service key ${svc}/${k} produced an empty value"
      seed_kv "$svc" "$k" "$v"
      log "  created ${k} → cogni/${DEPLOY_ENVIRONMENT}/${svc}"
      created=$((created + 1))
    done
    flush_batch "$svc"
  done
fi

# A LiteLLM virtual key is a dual-plane generated secret: OpenBao owns its
# bytes, while LiteLLM must store the same explicit key for authentication.
# Key lookups use POST /v2/key/info with the token SHA-256 in a 0600 body file;
# the plaintext key never appears in a URL, argv, log, or error. The pinned
# LiteLLM build ignores key_aliases on that endpoint, so alias uniqueness uses
# its exact-filter /key/list contract (the non-secret alias is URL-encoded from
# a file, and only the matching page is returned). A missing key is created only
# when the desired alias is also unused. Any transport, auth, collision, or
# response mismatch aborts the substrate lane.
LITELLM_REGISTER_REMOTE="$(cat <<'REMOTE_SCRIPT'
set -euo pipefail
umask 077
work_dir=$(mktemp -d -t cogni-litellm-key.XXXXXX)
trap 'rm -rf "$work_dir"' EXIT

IFS= read -r master_key
IFS= read -r virtual_key
IFS= read -r key_alias
printf '%s' "$master_key" > "$work_dir/master"
printf '%s' "$virtual_key" > "$work_dir/key"
printf '%s' "$key_alias" > "$work_dir/alias"
unset master_key virtual_key key_alias

key_hash=$(sha256sum "$work_dir/key" | awk '{print $1}')
printf '%s' "$key_hash" > "$work_dir/hash"
unset key_hash

cat > "$work_dir/request.conf" <<EOF
url = "http://127.0.0.1:4000/v2/key/info"
request = "POST"
header = "Authorization: Bearer $(cat "$work_dir/master")"
header = "Content-Type: application/json"
connect-timeout = 10
max-time = 30
silent
show-error
EOF

post_json() {
  local body_file="$1" response_file="$2" code
  if ! code=$(curl --config "$work_dir/request.conf" --data-binary "@$body_file" \
      --output "$response_file" --write-out '%{http_code}'); then
    echo transport-error
    return 1
  fi
  if [[ "$code" != "200" ]]; then
    echo "lookup-http-${code}"
    return 1
  fi
}

jq -n --rawfile hash "$work_dir/hash" '{keys: [$hash]}' > "$work_dir/by-hash.json"
post_json "$work_dir/by-hash.json" "$work_dir/by-hash-response.json" || exit 1
hash_count=$(jq -er '.info | arrays | length' "$work_dir/by-hash-response.json") || { echo lookup-invalid-json; exit 1; }
if [[ "$hash_count" -gt 1 ]]; then echo key-hash-collision; exit 1; fi
if [[ "$hash_count" -eq 1 ]] && ! jq -e --rawfile alias "$work_dir/alias" \
    '.info[0].key_alias == $alias' "$work_dir/by-hash-response.json" >/dev/null; then
  echo key-alias-mismatch
  exit 1
fi

cat > "$work_dir/alias-list.conf" <<EOF
url = "http://127.0.0.1:4000/key/list"
header = "Authorization: Bearer $(cat "$work_dir/master")"
connect-timeout = 10
max-time = 30
silent
show-error
EOF
if ! alias_code=$(curl --config "$work_dir/alias-list.conf" --get \
    --data-urlencode "key_alias@$work_dir/alias" --data-urlencode "size=2" \
    --data-urlencode "return_full_object=true" \
    --output "$work_dir/by-alias-response.json" --write-out '%{http_code}'); then
  echo transport-error
  exit 1
fi
if [[ "$alias_code" != "200" ]]; then
  echo "lookup-http-${alias_code}"
  exit 1
fi
alias_count=$(jq -er '
  select((.keys | type) == "array") |
  .total_count |
  select(type == "number" and . >= 0 and floor == .)
' "$work_dir/by-alias-response.json") || { echo lookup-invalid-json; exit 1; }
if [[ "$alias_count" -gt 1 ]]; then echo alias-collision; exit 1; fi
if [[ "$alias_count" -eq 1 ]] && ! jq -e --rawfile alias "$work_dir/alias" '
      (.keys | length) == 1 and
      .keys[0].key_alias == $alias and
      (.keys[0].token | type == "string" and test("^[0-9a-f]{64}$"))
    ' "$work_dir/by-alias-response.json" >/dev/null; then
  echo alias-lookup-mismatch
  exit 1
fi

if [[ "$hash_count" -eq 1 ]]; then
  [[ "$alias_count" -eq 1 ]] || { echo alias-index-missing; exit 1; }
  jq -e --rawfile hash "$work_dir/hash" '.keys[0].token == $hash' \
    "$work_dir/by-alias-response.json" >/dev/null \
    || { echo alias-key-mismatch; exit 1; }
  echo unchanged
  exit 0
fi
# OpenBao is custody SSOT (secrets-management Invariant 5); the LiteLLM registration is
# a PROJECTION of it. An alias owned by a different key means the projection is stale
# (e.g. a transport-flaky run re-minted the OpenBao value after registering) — reconcile
# it like ESO would: delete the stale alias and fall through to re-register the SSOT
# value. Failing here instead turned one stale projection into a permanent red that only
# a hand-op could clear (story.5016 levelup, 3 occurrences).
if [[ "$alias_count" -eq 1 ]]; then
  jq -n --rawfile alias "$work_dir/alias" '{key_aliases: [$alias]}' \
    > "$work_dir/alias-delete.json"
  cat > "$work_dir/alias-delete.conf" <<EOF
url = "http://127.0.0.1:4000/key/delete"
request = "POST"
header = "Authorization: Bearer $(cat "$work_dir/master")"
header = "Content-Type: application/json"
connect-timeout = 10
max-time = 30
silent
show-error
EOF
  if ! delete_code=$(curl --config "$work_dir/alias-delete.conf" \
      --data-binary "@$work_dir/alias-delete.json" --output "$work_dir/alias-delete-response.json" \
      --write-out '%{http_code}'); then
    echo transport-error
    exit 1
  fi
  if [[ "$delete_code" != "200" ]]; then
    echo "stale-alias-delete-http-${delete_code}"
    exit 1
  fi
  echo "reconciled stale alias (owned by a different key) — re-registering" >&2
fi

jq -n --rawfile key "$work_dir/key" --rawfile alias "$work_dir/alias" \
  '{key: $key, key_alias: $alias}' > "$work_dir/generate.json"
cat > "$work_dir/generate.conf" <<EOF
url = "http://127.0.0.1:4000/key/generate"
request = "POST"
header = "Authorization: Bearer $(cat "$work_dir/master")"
header = "Content-Type: application/json"
connect-timeout = 10
max-time = 30
silent
show-error
EOF
if ! generate_code=$(curl --config "$work_dir/generate.conf" \
    --data-binary "@$work_dir/generate.json" --output "$work_dir/generate-response.json" \
    --write-out '%{http_code}'); then
  echo transport-error
  exit 1
fi
if [[ "$generate_code" != "200" && "$generate_code" != "201" ]]; then
  echo "generate-http-${generate_code}"
  exit 1
fi
if ! jq -e --rawfile key "$work_dir/key" --rawfile alias "$work_dir/alias" \
    '.key == $key and .key_alias == $alias' "$work_dir/generate-response.json" >/dev/null; then
  echo generate-response-mismatch
  exit 1
fi
echo registered
REMOTE_SCRIPT
)"

register_litellm_virtual_key() {
  local key_name="$1" value master node_id alias result rc
  value="$(bao_get_field "$TARGET_NODE" "$key_name")"
  [[ -n "$value" ]] || fail "catalog sync target ${key_name} was not materialized for ${TARGET_NODE}"
  [[ "$value" =~ ^sk-cogni-[0-9a-f]{48}$ ]] \
    || fail "catalog sync target ${key_name} has invalid format (expected sk-cogni-<48 lowercase hex>)"
  master="$(bao_get_field operator LITELLM_MASTER_KEY)"
  [[ -n "$master" ]] \
    || fail "cannot register ${key_name}: operator LITELLM_MASTER_KEY is absent"
  node_id="$(node_id_for_target "$TARGET_NODE")" \
    || fail "cannot register ${key_name}: node_id is unresolved for ${TARGET_NODE}"
  alias="cogni:${DEPLOY_ENVIRONMENT}:${node_id}:app:v1"

  set +e
  result="$(printf '%s\n%s\n%s\n' "$master" "$value" "$alias" | remote "$LITELLM_REGISTER_REMOTE")"
  rc=$?
  set -e
  unset value master
  [[ $rc -eq 0 ]] \
    || fail "LiteLLM registration failed for ${key_name} (${result:-redacted-error}); alias=${alias}"
  case "$result" in
    registered) log "  registered ${key_name} with LiteLLM (alias ${alias})" ;;
    unchanged) log "  ${key_name} already registered with LiteLLM (alias ${alias})" ;;
    *) fail "LiteLLM registration returned an invalid redacted result for ${key_name}; alias=${alias}" ;;
  esac
}

for k in "${LITELLM_SYNC_KEYS[@]}"; do
  _node_gets_key "$TARGET_NODE" "$k" || continue
  register_litellm_virtual_key "$k"
done

log "materialize complete for ${TARGET_NODE} (${DEPLOY_ENVIRONMENT}): created=${created} unchanged=${unchanged}"
