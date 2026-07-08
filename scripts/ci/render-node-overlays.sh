#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# render-node-overlays.sh — regenerate each wizard-born node's per-env kustomize
# overlay from the node-template overlay (CATALOG_IS_SSOT + NODE_AT_ROOT_MIGRATE_PATH).
#
# Why a CI renderer + drift gate (bug.5008):
#   A wizard-born node's overlay is generated once at mint time (operator gens/overlay.ts
#   or scaffold-node.sh) and committed verbatim. check-gitops-manifests.sh only
#   kustomize-builds it, so a wrong-but-valid migrate path (/app/nodes/<slug>/app on a
#   node-at-root image) passes the build yet crash-loops the migrate initContainer at
#   runtime (MODULE_NOT_FOUND). This renderer is the overlay twin of render-node-appset.sh:
#   regenerate from the committed node-template overlay + catalog, diff vs committed, fail
#   on drift BEFORE flight.
#
# The node-template template overlay is itself node-at-root (/app/app migrate paths) and
#   carries the ESO `<slug>-env-secrets` target directly — so rendering a child is a pure
#   slug + port rename, with no path or secret rewrite. node-template thus deploys with the
#   exact shape it hands to every spawn (no split-brain template-vs-deployable).
#
# Byte-exact twins: gens/overlay.ts `renderOverlay` (operator mint path) and
#   scaffold-node.sh step 5 (manual CLI) MUST emit identical output — all three consume the
#   same node-template overlay and apply only the slug rename + the two well-known port
#   literals (30200→node_port, 3200→port). Drift between the twins fails CI, not a pod.
#
# Node set: catalog rows that declare a `source_repo` (externally built, node-at-root
#   image layout) EXCEPT node-template itself (the template). Monorepo nodes
#   (operator/resy/canary) have hand-authored overlays and no source_repo.
#
# Declarative decommission (story.5020 W3): --write also PRUNES the overlay dir of
#   any node that has left the catalog (or dropped source_repo), and --check fails on
#   such an orphan — so a decommissioned node leaves no dead overlay config behind.
#   Twin of render-node-appset.sh's per-env prune. Only renderer-owned overlays are
#   touched; the hand-authored operator/node-template/scheduler-worker overlays are
#   protected (derived from the catalog, never hardcoded).
#
# Usage: render-node-overlays.sh <env> <node>   # emit one overlay to stdout
#        render-node-overlays.sh --write         # (re)write wizard-born overlays + prune orphans
#        render-node-overlays.sh --check          # fail if any committed overlay is stale or orphaned
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

CATALOG_DIR="$REPO_ROOT/infra/catalog"
OVERLAYS_DIR="$REPO_ROOT/infra/k8s/overlays"
TEMPLATE_SLUG="node-template"
ENVS=(candidate-a preview production)

# Wizard-born node slugs, sorted. A catalog row with a `source_repo` is an
# externally built node-at-root node; node-template carries a source_repo too but
# is the template, so it is excluded. yq (not grep) so the operator's YAML-parsed
# mint path can't skew against this gate.
wizard_nodes() {
  local f name src
  for f in "$CATALOG_DIR"/*.yaml; do
    [ -e "$f" ] || continue
    src="$(yq -r '.source_repo // ""' "$f")"
    [ -n "$src" ] || continue
    name="$(yq -r '.name' "$f")"
    [ "$name" != "$TEMPLATE_SLUG" ] || continue
    printf '%s\n' "$name"
  done | LC_ALL=C sort
}

# Wizard-born node slugs whose per-env node-set (`envs:`) includes $1, sorted.
# ATOMIC_PER_ENV (story.5020 W4): a node only carries an overlay in the envs it
# claims. Mirrors render-node-appset.sh's deployable_nodes_for_env — the earlier
# `wizard_nodes` × ENVS cartesian assumed every node lived in every env
# (CANDIDATE_A_ALWAYS), so the env-membership verb removing a node from one env
# left check()/write() still demanding the (correctly-deleted) overlay.
# A wizard-born row that omits `envs` (schema-required) is a hard error, not a
# silent all-env fallback.
wizard_nodes_for_env() {
  local env="$1" f name src envs
  for f in "$CATALOG_DIR"/*.yaml; do
    [ -e "$f" ] || continue
    src="$(yq -r '.source_repo // ""' "$f")"
    [ -n "$src" ] || continue
    name="$(yq -r '.name' "$f")"
    [ "$name" != "$TEMPLATE_SLUG" ] || continue
    if [ "$(yq -r 'has("envs")' "$f")" != "true" ]; then
      echo "[ERROR] $f is wizard-born but has no 'envs' node-set (CATALOG_IS_SSOT)." >&2
      exit 1
    fi
    # here-string first: `yq | grep -q` SIGPIPEs yq → pipefail 141 would silently
    # skip the very nodes that DO claim the env (twin of render-node-appset.sh).
    envs="$(yq -r '.envs[]' "$f")"
    grep -qxF "$env" <<<"$envs" || continue
    printf '%s\n' "$name"
  done | LC_ALL=C sort
}

# Overlay dirs under overlays/<env>/ the renderer must NEVER prune: the
# node-template template itself, plus the hand-authored monorepo overlays
# (operator, scheduler-worker, …) — deployable catalog rows that carry a
# `candidate_a_branch` but NO `source_repo`. Derived from the catalog (not a
# hardcoded list) so a new monorepo node can't be mistaken for a stale orphan
# and pruned. Anything under overlays/<env>/ outside this set AND outside the
# current wizard-born set is a renderer-owned orphan (its catalog row left), so
# it is safe to prune — mirroring render-node-appset.sh's per-env prune loop.
protected_overlay_dirs() {
  local f name src cab
  printf '%s\n' "$TEMPLATE_SLUG"
  for f in "$CATALOG_DIR"/*.yaml; do
    [ -e "$f" ] || continue
    src="$(yq -r '.source_repo // ""' "$f")"
    [ -z "$src" ] || continue            # source_repo ⇒ wizard-born, not protected
    cab="$(yq -r '.candidate_a_branch // ""' "$f")"
    [ -n "$cab" ] || continue            # no candidate_a_branch ⇒ not a deployable overlay
    name="$(yq -r '.name' "$f")"
    printf '%s\n' "$name"
  done | LC_ALL=C sort -u
}

node_field() { yq -r ".$2 // \"\"" "$CATALOG_DIR/$1.yaml"; }

template_path() { printf '%s/%s/%s/kustomization.yaml\n' "$OVERLAYS_DIR" "$1" "$TEMPLATE_SLUG"; }
overlay_path() { printf '%s/%s/%s/kustomization.yaml\n' "$OVERLAYS_DIR" "$1" "$2"; }

# Emit one node's overlay for one env: clone the env's node-template overlay and
# apply the byte-exact renderOverlay transforms. perl (PCRE) so `\b…\b` and `\Q…\E`
# match the TS twin's JS semantics on every platform. Fails closed if the migrate
# override didn't inject — a node-at-root node whose Postgres migrate still runs the
# monorepo path crash-loops silently (the exact bug.5008 failure).
render_one() {
  local env="$1" node="$2" tpl np port tmp
  tpl="$(template_path "$env")"
  [ -f "$tpl" ] || { echo "[ERROR] missing template overlay $tpl" >&2; return 1; }
  np="$(node_field "$node" node_port)"
  port="$(node_field "$node" port)"
  [ -n "$np" ] && [ -n "$port" ] \
    || { echo "[ERROR] $node: catalog has no node_port/port" >&2; return 1; }
  tmp="$(mktemp)"
  SLUG="$node" NODEPORT="$np" PORT="$port" perl -0777 -pe '
    s/node-template/$ENV{SLUG}/g;
    s/\b30200\b/$ENV{NODEPORT}/g;
    s/\b3200\b/$ENV{PORT}/g;
  ' "$tpl" > "$tmp"
  if ! grep -q 'exec node /app/app/migrate.mjs /app/app/migrations' "$tmp"; then
    rm -f "$tmp"
    echo "[ERROR] $env/$node: node-at-root migrate path missing (NODE_AT_ROOT_MIGRATE_PATH); the node-template template overlay must carry /app/app migrate commands." >&2
    return 1
  fi
  cat "$tmp"
  rm -f "$tmp"
}

write() {
  local env node count=0 pruned=0 tmp expected protected envdir d base
  protected="$(protected_overlay_dirs)"
  for env in "${ENVS[@]}"; do
    expected=""
    for node in $(wizard_nodes_for_env "$env"); do
      tmp="$(mktemp)"
      render_one "$env" "$node" > "$tmp"
      mkdir -p "$(dirname "$(overlay_path "$env" "$node")")"
      mv "$tmp" "$(overlay_path "$env" "$node")"
      expected="$expected$node"$'\n'
      count=$((count + 1))
    done
    # Prune renderer-owned overlay dirs a node no longer claims (its catalog row
    # left, or dropped source_repo) so `pnpm gen:node-overlays` is self-healing
    # and a decommissioned node leaves no orphan overlay config behind. Only
    # touch dirs OUTSIDE the protected (hand-authored / template) set — never the
    # operator/node-template/scheduler-worker overlays. Twin of the appset
    # renderer's per-env prune loop.
    envdir="$OVERLAYS_DIR/$env"
    [ -d "$envdir" ] || continue
    for d in "$envdir"/*/; do
      [ -d "$d" ] || continue
      base="$(basename "$d")"
      grep -qxF "$base" <<<"$protected" && continue
      grep -qxF "$base" <<<"$expected" && continue
      rm -rf "$d"
      pruned=$((pruned + 1))
    done
  done
  echo "Wrote $count wizard-born node overlays (pruned $pruned stale)."
}

check() {
  local env node path stale=0 expected protected envdir d base
  protected="$(protected_overlay_dirs)"
  for env in "${ENVS[@]}"; do
    expected=""
    for node in $(wizard_nodes_for_env "$env"); do
      expected="$expected$node"$'\n'
      path="$(overlay_path "$env" "$node")"
      if [ ! -f "$path" ]; then
        echo "[ERROR] missing $path — run: pnpm gen:node-overlays" >&2
        stale=1
        continue
      fi
      if ! diff -u "$path" <(render_one "$env" "$node") >/dev/null; then
        echo "[ERROR] $path is out of sync with the node-template overlay + catalog:" >&2
        diff -u "$path" <(render_one "$env" "$node") >&2 || true
        stale=1
      fi
    done
    # A renderer-owned overlay dir for a node no longer in the catalog (its row
    # left, or dropped source_repo) is a stale orphan — fail so the drift gate
    # catches un-regenerated state. Protected (hand-authored / template) dirs are
    # exempt: they are not renderer-owned.
    envdir="$OVERLAYS_DIR/$env"
    [ -d "$envdir" ] || continue
    for d in "$envdir"/*/; do
      [ -d "$d" ] || continue
      base="$(basename "$d")"
      grep -qxF "$base" <<<"$protected" && continue
      grep -qxF "$base" <<<"$expected" && continue
      echo "[ERROR] $d has no catalog row — stale node overlay; run: pnpm gen:node-overlays" >&2
      stale=1
    done
  done
  if [ "$stale" -ne 0 ]; then
    echo "        A wizard-born overlay was hand-edited, minted by a stale operator, or" >&2
    echo "        left orphaned after decommission without regenerating (pnpm gen:node-overlays)." >&2
    exit 1
  fi
  echo "wizard-born node overlays are in sync with the node-template overlay + catalog."
}

case "${1:-}" in
  --check) check ;;
  --write) write ;;
  "")
    echo "Usage: $0 [--check|--write] | $0 <env> <node>" >&2
    exit 2
    ;;
  *)
    [ -n "${2:-}" ] || { echo "Usage: $0 <env> <node>" >&2; exit 2; }
    render_one "$1" "$2"
    ;;
esac
