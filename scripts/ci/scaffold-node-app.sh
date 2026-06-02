#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# scaffold-node-app.sh — clone node-template into a sovereign nodes/<slug>/ tree.
#
# A node is a SOVEREIGN unit (docs/spec/node-operator-contract.md): its own image,
# its own baked .cogni/repo-spec.yaml identity, its own workspace packages. You
# CANNOT API-emit ~1100 files; this is the git-level materialization the wizard
# (or a human) runs once per node. The deploy footprint (catalog + overlays + AppSet)
# is generated separately + reproducibly by scripts/ci/render-node-overlays.sh.
#
# birth-probe (#1425, closed) proved the failure mode: it cloned only app/ and
# missed packages/ + graphs/, so the workspace packages it depends on
# (@cogni/node-template-{doltgres-schema,graphs}) were absent. This clones the
# FULL node tree (app + packages + graphs + k8s + .cogni) and renames every
# `node-template` token → <slug> (workspace package names, imports, Dockerfile
# COPY paths, drizzle configs, k8s names), then regenerates the identity file.
#
# Idempotent: refuses if nodes/<slug>/ already exists (no clobber). The result is
# a buildable sovereign node; `pnpm --filter @cogni/<slug>-app build` is the gate.
#
# Usage: scaffold-node-app.sh <slug> [--node-id <uuid>]
#        scaffold-node-app.sh --audit <slug>   # report residual node-template refs
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "$REPO_ROOT"

TEMPLATE_DIR="nodes/node-template"
RESERVED="operator resy node-template poly canary"

# Text extensions we rename inside; everything else (png, ico, woff) is copied verbatim.
RENAME_GLOBS=(-name '*.ts' -o -name '*.tsx' -o -name '*.json' -o -name '*.mjs' \
  -o -name '*.cjs' -o -name '*.js' -o -name '*.yaml' -o -name '*.yml' \
  -o -name '*.md' -o -name '*.css' -o -name 'Dockerfile' -o -name '*.sql')

audit() {
  local slug="$1"
  echo "Residual 'node-template' refs under nodes/${slug} (expect: none, or only intentional shared refs):"
  grep -rn "node-template" "nodes/${slug}" 2>/dev/null | grep -vE "/(node_modules|dist|\.next)/" || echo "  (none)"
}

if [ "${1:-}" = "--audit" ]; then
  audit "${2:?slug}"
  exit 0
fi

SLUG="${1:?usage: scaffold-node-app.sh <slug> [--node-id <uuid>]}"
NODE_ID=""
if [ "${2:-}" = "--node-id" ]; then NODE_ID="${3:?--node-id needs a value}"; fi

# ── validate ────────────────────────────────────────────────────────────────
[[ "$SLUG" =~ ^[a-z][a-z0-9-]{1,31}$ ]] \
  || { echo "[ERROR] slug must be 2-32 chars kebab-case (^[a-z][a-z0-9-]{1,31}$)" >&2; exit 1; }
for r in $RESERVED; do
  [ "$SLUG" = "$r" ] && { echo "[ERROR] '$SLUG' is a reserved node slug" >&2; exit 1; }
done
[ -e "nodes/${SLUG}" ] && { echo "[ERROR] nodes/${SLUG} already exists (idempotent: refusing to clobber)" >&2; exit 1; }

# node_id: caller-supplied (wizard passes the nodes-row UUID) or a fresh one.
if [ -z "$NODE_ID" ]; then
  NODE_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
fi

echo "[1/4] clone ${TEMPLATE_DIR} → nodes/${SLUG} (excl node_modules/dist/.next/build caches)"
rsync -a \
  --exclude 'node_modules' --exclude 'dist' --exclude '.next' \
  --exclude '*.tsbuildinfo' --exclude '.turbo' \
  "${TEMPLATE_DIR}/" "nodes/${SLUG}/"

echo "[2/4] rename node-template → ${SLUG} across text files (package names, imports, Dockerfile, configs)"
# shellcheck disable=SC2046
find "nodes/${SLUG}" -type f \( "${RENAME_GLOBS[@]}" \) -print0 \
  | xargs -0 -r sed -i.bak "s/node-template/${SLUG}/g"
find "nodes/${SLUG}" -name '*.bak' -delete

echo "[3/4] regenerate identity nodes/${SLUG}/.cogni/repo-spec.yaml (node_id=${NODE_ID})"
# The template's repo-spec carried node-template's identity + source_refs. Replace
# with this node's identity; the wizard overwrites with the formed DAO addresses.
cat > "nodes/${SLUG}/.cogni/repo-spec.yaml" <<YAML
# Sovereign node identity — scaffolded by scripts/ci/scaffold-node-app.sh.
# node_id is minted once and is immutable (docs/spec/identity-model.md).
schema_version: "0.1.4"

node_id: "${NODE_ID}"
scope_key: "default"

# cogni_dao is filled by node formation (operator wizard) before flight.
cogni_dao:
  chain_id: "8453"

payments:
  status: pending_activation
YAML

echo "[4/4] audit residual refs"
audit "$SLUG"

cat <<DONE

✅ nodes/${SLUG} scaffolded (node_id=${NODE_ID}).
Next:
  1. Add infra/catalog/${SLUG}.yaml (port = node_port-27000, node_id=${NODE_ID}).
  2. pnpm gen:overlays        # renders overlays×3 (render-node-overlays.sh)
  3. render-node-overlays.sh --appset-stanza ${SLUG} <env>  → append to the 3 AppSets
  4. CI build gate: pnpm --filter @cogni/${SLUG}-app build
DONE
