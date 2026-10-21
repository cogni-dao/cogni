#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# reconcile-scheduler-worker-routing.sh — on every node flight, propagate the
# catalog-rendered scheduler-worker base manifests to the per-env deploy branch
# (deploy/<env>-scheduler-worker) so a node-add actually reaches the worker.
#
# THE GAP THIS CLOSES (bug.5035 / bug.5021): the worker must poll one Temporal
# task queue per node, driven by COGNI_NODE_ENDPOINTS in its ConfigMap. The roll
# half exists — base/scheduler-worker/deployment.yaml carries the Reloader
# annotation (#1609), so the worker auto-rolls when its ConfigMap changes. But a
# node flight only refreshes deploy/<env>-<node>; the worker's Argo app syncs
# deploy/<env>-scheduler-worker, which a node-add NEVER refreshed — so the new
# ConfigMap never reached the cluster and Reloader had nothing to react to. The
# manual heal was exactly: refresh deploy/<env>-scheduler-worker from main. This
# script makes that refresh an idempotent, env-singleton reconcile on every flight.
#
# Env-singleton (substrate-registry: scheduler-worker-routing): desired state is a
# function of the whole node SET, so it is re-reconciled on EVERY node flight
# (affected-only governs image builds, never substrate routing). The source of
# truth is the PR-head app checkout's base/scheduler-worker plus this env's
# GENERATED node-endpoints.patch.yaml — both already gated against the catalog by
# render-scheduler-worker-endpoints.sh --check. We copy them (never re-render
# here: the deploy branch carries only the flighted node's catalog file, so
# re-rendering would drop sibling nodes).
#
# bug.5094 — the routing map is now rendered TWICE from one catalog: an
# env-invariant placement-DEFAULT (all-k3s) in base/scheduler-worker/configmap.yaml,
# and this env's PROVIDER-RESOLVED map in
# infra/k8s/overlays/<env>/scheduler-worker/node-endpoints.patch.yaml (a node placed
# on akash has no in-cluster Service, and its public host is per-env). Both must
# reach the deploy branch or a node-add would only half-arrive.
#
# The overlay topology comes from the watched repository's environment bootstrap
# branch (deploy/<env>), which owns the lane's substrate hostname. The current
# scheduler image digest is restored after that refresh, so a foreign app-source
# flight cannot replace the shared worker's VM target or roll back its image.
#
# Idempotent: re-running with an unchanged catalog produces no diff → no commit
# (status "noop"). The single per-env CI concurrency group serializes flights so
# concurrent node flights never race on the shared branch.
#
# Usage:
#   reconcile-scheduler-worker-routing.sh <env>
#
# Env:
#   APP_SOURCE_DIR     PR-head app checkout (default "."); source of the
#                      catalog-rendered base/scheduler-worker + the renderer.
#   GH_TOKEN           push auth (required unless DRY_RUN=1 or DEPLOY_BRANCH_DIR set).
#   GITHUB_REPOSITORY  owner/repo to clone (required unless DEPLOY_BRANCH_DIR set).
#   SWR_DEPLOY_REPOSITORY owner/repo actually watched by Argo for this k3s cell.
#                      Defaults to GITHUB_REPOSITORY for non-mirrored fleets.
#   SWR_ROUTE_AUTHORITY_DIR checkout of the watched repository's protected-main
#                      routing authority (tests/local only). Production clones
#                      read origin/main from SWR_DEPLOY_REPOSITORY.
#   SWR_SUBSTRATE_AUTHORITY_DIR checkout containing deploy/<env>'s scheduler
#                      overlay topology (tests/local only). Production reads
#                      the watched repository's deploy/<env> branch.
#   DEPLOY_BRANCH_DIR  reuse an existing deploy-branch checkout instead of cloning
#                      (tests / local). When set, no clone and no push.
#   SWR_RECONCILE_FLIGHT_TARGETS_JSON normal decide-selected slug array; only
#                      renderer-validated active candidate pairs may replace an
#                      older watched destination. No selector means strict merge.
#   DRY_RUN=1          render + diff only; never push (commits locally for the diff).
#   SWR_RECONCILE_SUMMARY_FILE  optional path to receive one structured JSON summary.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLATFORM_SOURCE_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

rc=0 # assigned by the EXIT traps below ($? at fire time); declared for shellcheck.
DEPLOY_ENV=""
for arg in "$@"; do
  case "$arg" in
    -*) echo "[ERROR] reconcile-scheduler-worker-routing: unknown flag: $arg" >&2; exit 1 ;;
    *) DEPLOY_ENV="$arg" ;;
  esac
done
if [ -z "$DEPLOY_ENV" ]; then
  echo "Usage: reconcile-scheduler-worker-routing.sh <env>" >&2
  exit 1
fi

APP_SOURCE_DIR="${APP_SOURCE_DIR:-.}"
BRANCH="deploy/${DEPLOY_ENV}-scheduler-worker"
BOOTSTRAP_BRANCH="deploy/${DEPLOY_ENV}"
SUBPATH="infra/k8s/base/scheduler-worker"
SRC_DIR="${APP_SOURCE_DIR}/${SUBPATH}"
# GENERATED routing data comes from the reviewed app source. The sibling
# kustomization topology is reconciled separately from the lane bootstrap ref.
ENDPOINTS_SUBPATH="infra/k8s/overlays/${DEPLOY_ENV}/scheduler-worker/node-endpoints.patch.yaml"
ENDPOINTS_SRC="${APP_SOURCE_DIR}/${ENDPOINTS_SUBPATH}"
OVERLAY_SUBPATH="infra/k8s/overlays/${DEPLOY_ENV}/scheduler-worker/kustomization.yaml"
AUTHORITY_BASE_PATH="$SUBPATH/configmap.yaml"
AUTHORITY_ENDPOINTS_PATH="$ENDPOINTS_SUBPATH"

ENDPOINTS_COUNT=0
NODE_COUNT=0
STATUS="unknown"
SUMMARY_WRITTEN=false

write_summary() {
  [ -n "${SWR_RECONCILE_SUMMARY_FILE:-}" ] || return 0
  local status="$1"
  SWR_STATUS="$status" \
    SWR_DEPLOY_ENV="$DEPLOY_ENV" \
    SWR_BRANCH="$BRANCH" \
    SWR_ENDPOINTS_COUNT="$ENDPOINTS_COUNT" \
    SWR_NODE_COUNT="$NODE_COUNT" \
    SWR_DRY_RUN="${DRY_RUN:-}" \
    SWR_WORKFLOW="${GITHUB_WORKFLOW:-}" \
    SWR_JOB="${GITHUB_JOB:-}" \
    SWR_RUN_ID="${GITHUB_RUN_ID:-}" \
    SWR_ATTEMPT="${GITHUB_RUN_ATTEMPT:-}" \
    SWR_REF="${GITHUB_REF_NAME:-}" \
    SWR_WORKFLOW_SHA="${GITHUB_SHA:-}" \
    SWR_HEAD_SHA="${SWR_RECONCILE_HEAD_SHA:-}" \
    SWR_NODE_SOURCE_SHA="${SWR_RECONCILE_NODE_SOURCE_SHA:-}" \
    SWR_PR_NUMBER="${SWR_RECONCILE_PR_NUMBER:-}" \
    SWR_NODE_SLUG="${SWR_RECONCILE_NODE_SLUG:-}" \
    SWR_STATUS_URL="${SWR_RECONCILE_STATUS_URL:-}" \
    SWR_COMMIT_SHA="${COMMIT_SHA:-}" \
    python3 - <<'PY' >"${SWR_RECONCILE_SUMMARY_FILE}.tmp" || return 0
import datetime
import os

def boolish(name):
    return os.environ.get(name, "") in ("1", "true", "True")

def intish(name):
    try:
        return int(os.environ.get(name, "") or 0)
    except ValueError:
        return 0

payload = {
    "schema_version": 1,
    "type": "scheduler_worker_routing_reconcile",
    "status": os.environ["SWR_STATUS"],
    "deploy_env": os.environ["SWR_DEPLOY_ENV"],
    "branch": os.environ["SWR_BRANCH"],
    "endpoints_count": intish("SWR_ENDPOINTS_COUNT"),
    "node_count": intish("SWR_NODE_COUNT"),
    "dry_run": boolish("SWR_DRY_RUN"),
    "workflow": os.environ.get("SWR_WORKFLOW", ""),
    "job": os.environ.get("SWR_JOB", ""),
    "run_id": os.environ.get("SWR_RUN_ID", ""),
    "attempt": os.environ.get("SWR_ATTEMPT", ""),
    "ref": os.environ.get("SWR_REF", ""),
    "workflow_sha": os.environ.get("SWR_WORKFLOW_SHA", ""),
    "head_sha": os.environ.get("SWR_HEAD_SHA", ""),
    "node_source_sha": os.environ.get("SWR_NODE_SOURCE_SHA", ""),
    "pr_number": os.environ.get("SWR_PR_NUMBER", ""),
    "node_slug": os.environ.get("SWR_NODE_SLUG", ""),
    "status_url": os.environ.get("SWR_STATUS_URL", ""),
    "commit_sha": os.environ.get("SWR_COMMIT_SHA", ""),
    "emitted_at": datetime.datetime.now(datetime.timezone.utc)
        .replace(microsecond=0).isoformat().replace("+00:00", "Z"),
}
import json
print(json.dumps(payload, separators=(",", ":")))
PY
  mv "${SWR_RECONCILE_SUMMARY_FILE}.tmp" "$SWR_RECONCILE_SUMMARY_FILE" 2>/dev/null || return 0
  SUMMARY_WRITTEN=true
}

trap 'rc=$?; if [ "$rc" -ne 0 ] && [ "$SUMMARY_WRITTEN" != "true" ]; then write_summary "failure"; fi' EXIT

# ── Source validation ─────────────────────────────────────────────────────────
if [ ! -d "$SRC_DIR" ]; then
  echo "[ERROR] source manifests absent: $SRC_DIR (is APP_SOURCE_DIR correct?)" >&2
  exit 1
fi
if [ ! -f "$SRC_DIR/configmap.yaml" ]; then
  echo "[ERROR] $SRC_DIR/configmap.yaml missing — cannot propagate routing" >&2
  exit 1
fi
if [ ! -f "$ENDPOINTS_SRC" ]; then
  echo "[ERROR] reviewed environment provider-routing patch is missing: $ENDPOINTS_SRC" >&2
  exit 1
fi

# Self-validate against the catalog before propagating: never ship a stale routing
# table to the worker. The renderer is the same SSOT the static gate uses; if it is
# absent at this ref (pre-#1609 head) we warn + skip rather than 127, mirroring DNS.
REVIEWED_ROUTES_VALIDATED=false
if [ -f "$APP_SOURCE_DIR/scripts/ci/render-scheduler-worker-endpoints.sh" ]; then
  if ! ( cd "$APP_SOURCE_DIR" && bash scripts/ci/render-scheduler-worker-endpoints.sh --check ); then
    echo "[ERROR] base scheduler-worker configmap is stale vs catalog — refusing to propagate." >&2
    echo "        Run: bash scripts/ci/render-scheduler-worker-endpoints.sh --write" >&2
    exit 1
  fi
  REVIEWED_ROUTES_VALIDATED=true
else
  echo "::warning::render-scheduler-worker-endpoints.sh absent at this ref — propagating committed configmap without re-validation"
fi

command -v yq >/dev/null 2>&1 || {
  echo "[ERROR] yq is required to compose scheduler-worker route authorities" >&2
  exit 1
}
ENDPOINTS_CSV="$(yq -N '.data.COGNI_NODE_ENDPOINTS // ""' "$ENDPOINTS_SRC")"

# ── Resolve the deploy-branch checkout ────────────────────────────────────────
CLONED_DIR=""
if [ -n "${DEPLOY_BRANCH_DIR:-}" ]; then
  WORKDIR="$DEPLOY_BRANCH_DIR"
else
  DEPLOY_REPOSITORY="${SWR_DEPLOY_REPOSITORY:-${GITHUB_REPOSITORY:-}}"
  : "${DEPLOY_REPOSITORY:?SWR_DEPLOY_REPOSITORY or GITHUB_REPOSITORY required to clone (or set DEPLOY_BRANCH_DIR)}"
  : "${GH_TOKEN:?GH_TOKEN required to clone/push (or set DRY_RUN=1 + DEPLOY_BRANCH_DIR)}"
  CLONED_DIR="$(mktemp -d -t swr-deploy-branch.XXXXXX)"
  WORKDIR="$CLONED_DIR/repo"
  git clone --quiet "https://x-access-token:${GH_TOKEN}@github.com/${DEPLOY_REPOSITORY}.git" "$WORKDIR"
  (
    cd "$WORKDIR"
    git fetch --quiet origin main
    git fetch --quiet origin "+refs/heads/deploy/*:refs/remotes/origin/deploy/*"
    if git rev-parse --verify --quiet "refs/remotes/origin/${BRANCH}" >/dev/null; then
      git checkout -B "$BRANCH" "origin/${BRANCH}" >/dev/null 2>&1
    else
      echo "::warning::${BRANCH} missing — bootstrapping from ${BOOTSTRAP_BRANCH}"
      git fetch --quiet origin "$BOOTSTRAP_BRANCH"
      git checkout -B "$BRANCH" "origin/${BOOTSTRAP_BRANCH}" >/dev/null 2>&1
    fi
  )
fi
trap 'rc=$?; [ -n "$CLONED_DIR" ] && rm -rf "$CLONED_DIR"; if [ "$rc" -ne 0 ] && [ "$SUMMARY_WRITTEN" != "true" ]; then write_summary "failure"; fi' EXIT

OVERLAY_DST="${WORKDIR}/${OVERLAY_SUBPATH}"
[ -f "$OVERLAY_DST" ] || {
  echo "[ERROR] deployed scheduler-worker overlay missing: $OVERLAY_DST" >&2
  exit 1
}
CURRENT_IMAGE_NAME="$(yq -N '.images[0].newName // .images[0].name // ""' "$OVERLAY_DST")"
CURRENT_IMAGE_DIGEST="$(yq -N '.images[0].digest // ""' "$OVERLAY_DST")"
CURRENT_SOURCE_SHA="$(python3 - "$WORKDIR/.promote-state/source-sha-by-app.json" <<'PY'
import json, sys
try:
    with open(sys.argv[1], encoding="utf-8") as handle:
        print(json.load(handle).get("scheduler-worker", ""))
except (FileNotFoundError, json.JSONDecodeError):
    print("")
PY
)"
[[ "$CURRENT_IMAGE_NAME" == ghcr.io/* && "$CURRENT_IMAGE_DIGEST" =~ ^sha256:[0-9a-fA-F]{64}$ ]] || {
  echo "[ERROR] deployed scheduler-worker overlay has no immutable image identity" >&2
  exit 1
}
[[ "$CURRENT_SOURCE_SHA" =~ ^[0-9a-fA-F]{40}$ ]] || {
  echo "[ERROR] deployed scheduler-worker source identity missing from source-sha map" >&2
  exit 1
}

substrate_overlay_yaml() {
  if [ -n "${SWR_SUBSTRATE_AUTHORITY_DIR:-}" ]; then
    [ -f "${SWR_SUBSTRATE_AUTHORITY_DIR}/${OVERLAY_SUBPATH}" ] || {
      echo "[ERROR] substrate overlay authority missing: ${SWR_SUBSTRATE_AUTHORITY_DIR}/${OVERLAY_SUBPATH}" >&2
      return 1
    }
    cat "${SWR_SUBSTRATE_AUTHORITY_DIR}/${OVERLAY_SUBPATH}"
  else
    git -C "$WORKDIR" show "origin/${BOOTSTRAP_BRANCH}:${OVERLAY_SUBPATH}" || {
      echo "[ERROR] substrate overlay authority missing at origin/${BOOTSTRAP_BRANCH}:${OVERLAY_SUBPATH}" >&2
      return 1
    }
  fi
}

# Lane topology follows the watched deployment repository, never whichever app
# repository happened to flight last. Restore the already-deployed immutable
# image identity before the optional same-transaction promotion replaces it.
substrate_overlay_yaml > "${OVERLAY_DST}.tmp"
mv "${OVERLAY_DST}.tmp" "$OVERLAY_DST"
(
  cd "$WORKDIR"
  bash "$SCRIPT_DIR/promote-k8s-image.sh" --no-commit \
    --env "$DEPLOY_ENV" --app scheduler-worker \
    --digest "${CURRENT_IMAGE_NAME}@${CURRENT_IMAGE_DIGEST}" \
    --source-sha "$CURRENT_SOURCE_SHA"
)
git -C "$WORKDIR" add -A "$OVERLAY_SUBPATH"

# The watched repository owns an independent active candidate roster. Compose
# that protected-main authority with the reviewed app-source authority; never
# replace one fleet's pollers with another fleet's configmap. Equal duplicate
# aliases are harmless (operator/node-template); a different destination for the
# same alias is ambiguous authority and fails closed.
authority_yaml() {
  local rel="$1"
  if [ -n "${SWR_ROUTE_AUTHORITY_DIR:-}" ]; then
    [ -f "${SWR_ROUTE_AUTHORITY_DIR}/${rel}" ] || {
      echo "[ERROR] watched-repository route authority missing: ${SWR_ROUTE_AUTHORITY_DIR}/${rel}" >&2
      return 1
    }
    cat "${SWR_ROUTE_AUTHORITY_DIR}/${rel}"
  else
    git -C "$WORKDIR" show "origin/main:${rel}" || {
      echo "[ERROR] watched-repository route authority missing at origin/main:${rel}" >&2
      return 1
    }
  fi
}

route_authority_catalog() {
  local authority="$1" path row node_id prefix spec metadata='[]'
  local paths=()
  if [ "$authority" = reviewed ]; then
    for path in "$APP_SOURCE_DIR"/infra/catalog/*.yaml; do
      paths+=("infra/catalog/${path##*/}")
    done
  elif [ -n "${SWR_ROUTE_AUTHORITY_DIR:-}" ]; then
    for path in "$SWR_ROUTE_AUTHORITY_DIR"/infra/catalog/*.yaml; do
      paths+=("infra/catalog/${path##*/}")
    done
  else
    mapfile -t paths < <(git -C "$WORKDIR" ls-tree --name-only origin/main:infra/catalog)
    paths=("${paths[@]/#/infra/catalog/}")
  fi
  for path in "${paths[@]}"; do
    [[ "$path" == *.yaml ]] || continue
    if [ "$authority" = reviewed ]; then
      row="$(cat "$APP_SOURCE_DIR/$path")" || return 1
    else
      row="$(authority_yaml "$path")" || return 1
    fi
    row="$(yq -o=json -I=0 'select(.type == "node")' <<< "$row")" || return 1
    [ -n "$row" ] || continue
    node_id="$(jq -r '.node_id // ""' <<< "$row")"
    if [ -z "$node_id" ]; then
      prefix="$(jq -r '.path_prefix // ""' <<< "$row")"
      [[ "$prefix" =~ ^[a-zA-Z0-9_-]+(/[a-zA-Z0-9_-]+)*/$ ]] || {
        echo "[ERROR] route authority has no catalog or repo-spec identity" >&2; return 1;
      }
      if [ "$authority" = reviewed ]; then
        spec="$(cat "$APP_SOURCE_DIR/${prefix}.cogni/repo-spec.yaml")" || return 1
      else
        spec="$(authority_yaml "${prefix}.cogni/repo-spec.yaml")" || return 1
      fi
      node_id="$(yq -N '.node_id // ""' <<< "$spec")" || return 1
    fi
    metadata="$(jq -c --argjson row "$row" --arg node_id "$node_id" \
      '. + [{name: $row.name, node_id: $node_id, envs: $row.envs}]' <<< "$metadata")" || return 1
  done
  printf '%s' "$metadata"
}

scope_authority_endpoints() {
  ROUTE_ENDPOINTS="$1" ROUTE_CATALOG="$2" ROUTE_ENV="$DEPLOY_ENV" python3 - <<'PY'
import json, os, re

catalog = json.loads(os.environ["ROUTE_CATALOG"])
aliases, members = {}, set()
for row in catalog:
    name, node_id, envs = row.get("name"), row.get("node_id"), row.get("envs")
    if not isinstance(name, str) or not re.fullmatch(r"[a-z][a-z0-9-]*", name):
        raise SystemExit("invalid route authority node name")
    if not isinstance(node_id, str) or not re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", node_id):
        raise SystemExit("missing route authority node identity")
    if not isinstance(envs, list) or not all(isinstance(env, str) for env in envs):
        raise SystemExit("missing route authority environment membership")
    for alias in (name, node_id):
        if alias in aliases:
            raise SystemExit("ambiguous route authority identity")
        aliases[alias] = name
        if os.environ["ROUTE_ENV"] in envs:
            members.add(alias)
routes = {}
for entry in filter(None, os.environ["ROUTE_ENDPOINTS"].split(",")):
    alias, sep, endpoint = entry.partition("=")
    if not sep or not endpoint or alias not in aliases or alias in routes:
        raise SystemExit("scheduler route lacks unique catalog ownership")
    routes[alias] = endpoint
if not members <= routes.keys():
    raise SystemExit("scheduler route authority omits an active member")
for row in catalog:
    if row["name"] in members and routes[row["name"]] != routes[row["node_id"]]:
        raise SystemExit("scheduler slug and UUID routes disagree")
print(",".join(f"{alias}={endpoint}" for alias, endpoint in routes.items() if alias in members))
PY
}

yaml_endpoints() {
  yq -N '.data.COGNI_NODE_ENDPOINTS // ""' 2>/dev/null
}

merge_endpoint_authorities() {
  local watched_csv="$1" reviewed_csv="$2" provider_map="${3:-false}"
  WATCHED_ENDPOINTS="$watched_csv" REVIEWED_ENDPOINTS="$reviewed_csv" \
    WATCHED_CATALOG="$WATCHED_CATALOG" REVIEWED_CATALOG="$REVIEWED_CATALOG" \
    SELECTED_TARGETS="${SWR_RECONCILE_FLIGHT_TARGETS_JSON:-[]}" \
    PROVIDER_MAP="$provider_map" ROUTE_ENV="$DEPLOY_ENV" \
    REVIEWED_ROUTES_VALIDATED="$REVIEWED_ROUTES_VALIDATED" python3 - <<'PY'
import json, os, re

selected = json.loads(os.environ["SELECTED_TARGETS"])
if (not isinstance(selected, list)
    or not all(isinstance(name, str) and re.fullmatch(r"[a-z][a-z0-9-]*", name) for name in selected)
    or len(selected) != len(set(selected))):
    raise SystemExit("invalid normal scheduler flight target selection")
watched_catalog = json.loads(os.environ["WATCHED_CATALOG"])
reviewed_catalog = json.loads(os.environ["REVIEWED_CATALOG"])
node_ids, node_names = {}, {}
for catalog in (watched_catalog, reviewed_catalog):
    for row in catalog:
        name, node_id = row["name"], row["node_id"]
        if name in node_ids and node_ids[name] != node_id:
            raise SystemExit("scheduler authorities disagree on a slug's node identity")
        if node_id in node_names and node_names[node_id] != name:
            raise SystemExit("scheduler authorities disagree on a node identity's slug")
        node_ids[name], node_names[node_id] = node_id, name

# Only the reviewed active candidate's exact slug + UUID pair may supersede
# the same identity's watched destination. Active non-target candidate pairs
# preserve watched destinations; base defaults retain collision refusal. Scope validation proved complete,
# equal pairs; renderer validation proved their catalog-derived destination.
replace_aliases = set()
preserve_aliases = set()
if os.environ["PROVIDER_MAP"] == "true" and os.environ["ROUTE_ENV"] == "candidate-a":
    for row in reviewed_catalog:
        if "candidate-a" in row["envs"] and row["name"] not in selected:
            preserve_aliases.update((row["name"], row["node_id"]))
        if row["name"] in selected:
            if "candidate-a" not in row["envs"]:
                raise SystemExit("selected scheduler node is not an active candidate member")
            replace_aliases.update((row["name"], row["node_id"]))
routes = {}
origins = {}
for origin, raw in (
    ("watched protected main", os.environ["WATCHED_ENDPOINTS"]),
    ("reviewed application source", os.environ["REVIEWED_ENDPOINTS"]),
):
    for entry in filter(None, raw.split(",")):
        alias, sep, endpoint = entry.partition("=")
        if not sep or not alias or not endpoint:
            raise SystemExit(f"invalid scheduler endpoint entry from {origin}: {entry!r}")
        if alias in routes and routes[alias] != endpoint:
            if alias in preserve_aliases and origin == "reviewed application source":
                if os.environ["REVIEWED_ROUTES_VALIDATED"] != "true":
                    raise SystemExit("candidate route preservation requires the reviewed renderer")
                continue
            if alias in replace_aliases and origin == "reviewed application source":
                if os.environ["REVIEWED_ROUTES_VALIDATED"] != "true":
                    raise SystemExit("selected scheduler route replacement requires the reviewed renderer")
            else:
                raise SystemExit(
                    f"scheduler endpoint collision for {alias!r}: "
                    f"{origins[alias]}={routes[alias]!r}, {origin}={endpoint!r}"
                )
        routes[alias] = endpoint
        origins.setdefault(alias, origin)

if not routes:
    raise SystemExit("scheduler endpoint authorities composed to an empty map")
print(",".join(f"{alias}={routes[alias]}" for alias in sorted(routes)))
PY
}

WATCHED_BASE_CSV="$(authority_yaml "$AUTHORITY_BASE_PATH" | yaml_endpoints)"
WATCHED_ENV_CSV="$(authority_yaml "$AUTHORITY_ENDPOINTS_PATH" | yaml_endpoints)"
REVIEWED_BASE_CSV="$(yaml_endpoints < "$SRC_DIR/configmap.yaml")"
REVIEWED_ENV_CSV="$ENDPOINTS_CSV"
WATCHED_CATALOG="$(route_authority_catalog watched)"
REVIEWED_CATALOG="$(route_authority_catalog reviewed)"
WATCHED_ENV_CSV="$(scope_authority_endpoints "$WATCHED_ENV_CSV" "$WATCHED_CATALOG")"
REVIEWED_ENV_CSV="$(scope_authority_endpoints "$REVIEWED_ENV_CSV" "$REVIEWED_CATALOG")"

COMPOSITE_BASE_CSV="$(merge_endpoint_authorities "$WATCHED_BASE_CSV" "$REVIEWED_BASE_CSV")"
COMPOSITE_ENV_CSV="$(merge_endpoint_authorities "$WATCHED_ENV_CSV" "$REVIEWED_ENV_CSV" true)"
ENDPOINTS_COUNT="$(awk -F',' '{print NF}' <<<"$COMPOSITE_ENV_CSV")"
NODE_COUNT="$(tr ',' '\n' <<<"$COMPOSITE_ENV_CSV" | grep -cvE '^[0-9a-f]{8}-' || true)"

echo "Reconciling scheduler-worker routing for env '${DEPLOY_ENV}' → ${BRANCH}"
echo "  composed ${NODE_COUNT} node(s), ${ENDPOINTS_COUNT} endpoint alias(es) from watched + reviewed authorities"

DST_DIR="${WORKDIR}/${SUBPATH}"
mkdir -p "$DST_DIR"

# Propagate the env-invariant base/scheduler-worker (configmap + the Reloader-
# annotated deployment + services). --delete keeps it byte-identical to main so a
# pre-#1609 deploy branch also gains the Reloader annotation.
rsync -a --delete "$SRC_DIR/" "$DST_DIR/"
COMPOSITE_ENDPOINTS="$COMPOSITE_BASE_CSV" yq -i \
  '.data.COGNI_NODE_ENDPOINTS = strenv(COMPOSITE_ENDPOINTS)' \
  "$DST_DIR/configmap.yaml"

# Propagate only the reviewed environment's provider-resolved patch. A base map
# cannot substitute for missing placement evidence.
mkdir -p "$(dirname "${WORKDIR}/${ENDPOINTS_SUBPATH}")"
cp "$ENDPOINTS_SRC" "${WORKDIR}/${ENDPOINTS_SUBPATH}"
COMPOSITE_ENDPOINTS="$COMPOSITE_ENV_CSV" yq -i \
  '.data.COGNI_NODE_ENDPOINTS = strenv(COMPOSITE_ENDPOINTS)' \
  "${WORKDIR}/${ENDPOINTS_SUBPATH}"
# Bootstrap topology may predate provider routing. Apply the owned map last,
# including after any stale inline COGNI_NODE_ENDPOINTS patch.
yq -i '.patches = ((.patches // []) | map(select(.path != "node-endpoints.patch.yaml"))) + [{"path": "node-endpoints.patch.yaml"}]' "$OVERLAY_DST"
git -C "$WORKDIR" add -A "$ENDPOINTS_SUBPATH"

if [ "$DEPLOY_ENV" = candidate-a ]; then
  SERIAL_PATCH="infra/k8s/overlays/candidate-a/scheduler-worker/serial-rollout.patch.yaml"
  [ -f "$PLATFORM_SOURCE_DIR/$SERIAL_PATCH" ] || {
    echo "[ERROR] platform candidate serial-rollout patch is missing" >&2; exit 1;
  }
  cp "$PLATFORM_SOURCE_DIR/$SERIAL_PATCH" "$WORKDIR/$SERIAL_PATCH"
  yq -i '.patches = ((.patches // []) | map(select(.path != "serial-rollout.patch.yaml"))) + [{"path": "serial-rollout.patch.yaml"}]' "$OVERLAY_DST"
  git -C "$WORKDIR" add -A "$SERIAL_PATCH"

  REPLICAS_PATCH="infra/k8s/overlays/candidate-a/scheduler-worker/replicas.patch.yaml"
  yq -i '.patches = ((.patches // []) | map(select(.path != "replicas.patch.yaml")))' "$OVERLAY_DST"
  if [ -f "$PLATFORM_SOURCE_DIR/$REPLICAS_PATCH" ]; then
    cp "$PLATFORM_SOURCE_DIR/$REPLICAS_PATCH" "$WORKDIR/$REPLICAS_PATCH"
    yq -i '.patches += [{"path": "replicas.patch.yaml"}]' "$OVERLAY_DST"
    git -C "$WORKDIR" add -A "$REPLICAS_PATCH"
  else
    rm -f "$WORKDIR/$REPLICAS_PATCH"
    git -C "$WORKDIR" rm --ignore-unmatch -- "$REPLICAS_PATCH"
  fi

  # shellcheck source=scripts/ci/lib/shared-platform-manifests.sh
  . "$SCRIPT_DIR/lib/shared-platform-manifests.sh"
  reconcile_shared_platform_manifests "$PLATFORM_SOURCE_DIR" "$WORKDIR" "$DEPLOY_ENV" scheduler-worker

  # Hash the ACTUAL consumed ConfigMap after all authority/bootstrap patches,
  # not the source routing fragment. Promotion updates only GIT_SHA/IMAGE_DIGEST
  # later in this transaction; image identity already changes the Pod template.
  CHECKSUM_PATCH="infra/k8s/overlays/candidate-a/scheduler-worker/config-checksum.patch.yaml"
  yq -i '.patches = ((.patches // []) | map(select(.path != "config-checksum.patch.yaml")))' "$OVERLAY_DST"
  RENDERED_CONFIG="$(kubectl kustomize "$(dirname "$OVERLAY_DST")" | yq -o=json -I=0 '.')"
  CONFIG_SHA="$(SWR_RENDERED_CONFIG="$RENDERED_CONFIG" python3 - <<'PY'
import hashlib, json, os

resources = [json.loads(line) for line in os.environ["SWR_RENDERED_CONFIG"].splitlines() if line.strip()]
workers = [r for r in resources if r.get("kind") == "Deployment" and r.get("metadata", {}).get("name") == "scheduler-worker"]
if len(workers) != 1:
    raise SystemExit("expected exactly one scheduler-worker Deployment")
containers = [c for c in workers[0].get("spec", {}).get("template", {}).get("spec", {}).get("containers", []) if c.get("name") == "scheduler-worker"]
if len(containers) != 1 or not containers[0].get("resources", {}).get("limits", {}).get("memory"):
    raise SystemExit("worker startup budget requires an explicit main memory limit")
references = [e["configMapRef"].get("name") for e in containers[0].get("envFrom", []) if "configMapRef" in e]
if references != ["scheduler-worker-config"]:
    raise SystemExit("unexpected worker ConfigMap consumer")
maps = [r for r in resources if r.get("kind") == "ConfigMap" and r.get("metadata", {}).get("name") == references[0]]
if len(maps) != 1:
    raise SystemExit("expected exactly one consumed worker ConfigMap")
config = maps[0]
if config.get("metadata", {}).get("annotations", {}).get("reloader.stakater.com/ignore") != "true":
    raise SystemExit("worker ConfigMap must ignore Reloader atomically with its data")
data, binary = config.get("data", {}), config.get("binaryData", {})
if not isinstance(data, dict) or not isinstance(binary, dict) or not all(isinstance(v, str) for v in [*data.values(), *binary.values()]):
    raise SystemExit("invalid worker ConfigMap payload")
effective = {"data": {k: v for k, v in data.items() if k not in {"GIT_SHA", "IMAGE_DIGEST"}}, "binaryData": binary}
print(hashlib.sha256(json.dumps(effective, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest())
PY
  )"
  cat > "$WORKDIR/$CHECKSUM_PATCH" <<YAML
# Generated from the final consumed non-secret ConfigMap; promotion identity excluded.
apiVersion: apps/v1
kind: Deployment
metadata:
  name: scheduler-worker
spec:
  template:
    metadata:
      annotations:
        cogni.dev/scheduler-config-sha256: "$CONFIG_SHA"
YAML
  yq -i '.patches += [{"path": "config-checksum.patch.yaml"}]' "$OVERLAY_DST"
  git -C "$WORKDIR" add -A "$CHECKSUM_PATCH"
fi

git -C "$WORKDIR" config user.name "github-actions[bot]"
git -C "$WORKDIR" config user.email "github-actions[bot]@users.noreply.github.com"
git -C "$WORKDIR" add -A "$SUBPATH"
git -C "$WORKDIR" add -A "$OVERLAY_SUBPATH"
if git -C "$WORKDIR" diff --cached --quiet; then
  STATUS="noop"
  write_summary "$STATUS"
  echo "scheduler-worker routing already current — ${BRANCH} unchanged (no-op)."
  exit 0
fi

COMMIT_MSG="candidate-flight: scheduler-worker routing (${NODE_COUNT} nodes)"
[ -n "${SWR_RECONCILE_NODE_SOURCE_SHA:-}" ] && COMMIT_MSG="${COMMIT_MSG} node-ref ${SWR_RECONCILE_NODE_SOURCE_SHA}"
git -C "$WORKDIR" commit --quiet -m "$COMMIT_MSG"
COMMIT_SHA="$(git -C "$WORKDIR" rev-parse HEAD)"

if [ "${DRY_RUN:-}" = "1" ] || [ -n "${DEPLOY_BRANCH_DIR:-}" ]; then
  STATUS="updated-local"
  write_summary "$STATUS"
  echo "scheduler-worker routing updated locally (${COMMIT_SHA:0:8}); push skipped (DRY_RUN / DEPLOY_BRANCH_DIR)."
  exit 0
fi

git -C "$WORKDIR" push --quiet origin "HEAD:${BRANCH}"
STATUS="updated"
write_summary "$STATUS"
echo "scheduler-worker routing propagated to ${BRANCH} (${COMMIT_SHA:0:8}) — Argo sync converges the worker rollout."
