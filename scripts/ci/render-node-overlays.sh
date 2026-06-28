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
# Usage: render-node-overlays.sh <env> <node>   # emit one overlay to stdout
#        render-node-overlays.sh --write         # (re)write all wizard-born overlays
#        render-node-overlays.sh --check          # fail if any committed overlay is stale
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
  local env node count=0 tmp
  for env in "${ENVS[@]}"; do
    for node in $(wizard_nodes); do
      tmp="$(mktemp)"
      render_one "$env" "$node" > "$tmp"
      mkdir -p "$(dirname "$(overlay_path "$env" "$node")")"
      mv "$tmp" "$(overlay_path "$env" "$node")"
      count=$((count + 1))
    done
  done
  echo "Wrote $count wizard-born node overlays."
}

check() {
  local env node path stale=0
  for env in "${ENVS[@]}"; do
    for node in $(wizard_nodes); do
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
  done
  if [ "$stale" -ne 0 ]; then
    echo "        A wizard-born overlay was hand-edited or minted by a stale operator" >&2
    echo "        without regenerating it (pnpm gen:node-overlays)." >&2
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
