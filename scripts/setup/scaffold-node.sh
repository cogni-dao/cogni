#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# scaffold-node.sh — clone node-template into a new monorepo node, wired for the
# full deploy matrix (candidate-a/preview/production). Reproducible precursor to
# the wizard-invoked TS generator (task.5092). One node = catalog entry +
# overlays x3 + AppSet x3 + app tree, ALL_THREE_ENVS_OR_NONE by construction.
#
# Usage: scaffold-node.sh <slug> <port> <nodeport> [node_id]
#   slug      lowercase node name, e.g. canary
#   port      container port (next free after 3300), e.g. 3400
#   nodeport  k8s NodePort (next free after 30300), e.g. 30400
#   node_id   optional UUID to preserve an existing node identity
#
# See docs/guides/create-node.md (Steps 1,3,4,5 are pure functions of the catalog entry).
set -euo pipefail

SLUG="${1:?slug required}"
PORT="${2:?port required}"
NODEPORT="${3:?nodeport required}"
NODE_ID="${4:-}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TPL=node-template
ENVS=(candidate-a preview production)

cd "$ROOT"
[ -d "nodes/$SLUG" ] && { echo "nodes/$SLUG already exists"; exit 1; }

echo "==> 1. clone nodes/$TPL -> nodes/$SLUG (excluding build artifacts + secrets)"
# bug.5086 Part D — NEVER clone the per-node secrets catalog or ExternalSecrets.
# node-template's .cogni/secrets-catalog.yaml is the TEMPLATE (loader excludes it,
# secrets-catalog-loader.ts `d !== "node-template"`). A real node that copies it
# re-declares the ~57 shared baseline names -> NO_NAME_COLLISIONS throw -> kills
# setup:secrets for EVERY env. A new node inherits shared/baseline secrets via the
# substrate (per-node OpenBao path); it gets a per-node secrets-catalog ONLY when
# it declares its OWN unique secrets — which a fresh clone never does.
rsync -a \
  --exclude node_modules --exclude .next --exclude dist --exclude .turbo \
  --exclude coverage --exclude '*.tsbuildinfo' \
  --exclude '.cogni/secrets-catalog.yaml' --exclude 'k8s/external-secrets' \
  "nodes/$TPL/" "nodes/$SLUG/"

echo "==> 2. rename node-template -> $SLUG across the node tree (text files)"
# @cogni/node-template-app -> @cogni/canary-app falls out of this rewrite too.
grep -rIl --exclude-dir=node_modules --exclude-dir=.next "$TPL" "nodes/$SLUG" \
  | while IFS= read -r f; do sed -i '' "s/$TPL/$SLUG/g" "$f"; done

echo "==> 3. container port 3200 -> $PORT (Dockerfile + next config + package scripts)"
for f in "nodes/$SLUG/app/Dockerfile" "nodes/$SLUG/app/next.config.ts" "nodes/$SLUG/app/package.json"; do
  [ -f "$f" ] && perl -pi -e "s/\\b3200\\b/$PORT/g" "$f"
done

if [ -n "$NODE_ID" ]; then
  echo "==> 3b. preserve node identity node_id=$NODE_ID"
  sed -i '' -E "s/^node_id: .*/node_id: \"$NODE_ID\"/" "nodes/$SLUG/.cogni/repo-spec.yaml"
fi

echo "==> 4. catalog/$SLUG.yaml"
sed -E \
  -e "s/^name: .*/name: $SLUG/" \
  -e "s#^dockerfile: .*#dockerfile: nodes/$SLUG/app/Dockerfile#" \
  -e "s/^port: .*/port: $PORT/" \
  -e "s/^image_tag_suffix: .*/image_tag_suffix: \"-$SLUG\"/" \
  -e "s/^migrator_tag_suffix: .*/migrator_tag_suffix: \"-$SLUG-migrate\"/" \
  -e "s#deploy/candidate-a-$TPL#deploy/candidate-a-$SLUG#" \
  -e "s#deploy/preview-$TPL#deploy/preview-$SLUG#" \
  -e "s#deploy/production-$TPL#deploy/production-$SLUG#" \
  -e "s#^path_prefix: .*#path_prefix: nodes/$SLUG/#" \
  "infra/catalog/$TPL.yaml" > "infra/catalog/$SLUG.yaml"
if [ -n "$NODE_ID" ]; then
  sed -i '' -E "s/^node_id: .*/node_id: \"$NODE_ID\"/" "infra/catalog/$SLUG.yaml"
fi

echo "==> 5. overlays x3 (ALL_THREE_ENVS_OR_NONE)"
for env in "${ENVS[@]}"; do
  src="infra/k8s/overlays/$env/$TPL"
  dst="infra/k8s/overlays/$env/$SLUG"
  [ -d "$src" ] || { echo "missing template overlay $src"; exit 1; }
  cp -R "$src" "$dst"
  f="$dst/kustomization.yaml"
  sed -i '' "s/$TPL/$SLUG/g" "$f"
  perl -pi -e "s/\\b30200\\b/$NODEPORT/g; s/\\b3200\\b/$PORT/g" "$f"
done

echo "==> 6. AppSet x3 — insert git generator block before template:"
for env in "${ENVS[@]}"; do
  appset="infra/k8s/argocd/$env-applicationset.yaml"
  grep -q "infra/catalog/$SLUG.yaml" "$appset" && { echo "  $env already has $SLUG"; continue; }
  SLUG="$SLUG" ENV="$env" perl -0pi -e '
    my $b = "    - git:\n        repoURL: https://github.com/cogni-dao/cogni.git\n        revision: deploy/$ENV{ENV}-$ENV{SLUG}\n        files:\n          - path: \"infra/catalog/$ENV{SLUG}.yaml\"\n";
    s/^  template:/$b  template:/m;
  ' "$appset"
done

echo "==> 7. ci.yaml single-node-scope filters (enforced by single-node-scope-meta.spec)"
SLUG="$SLUG" perl -0pi -e '
  my $s=$ENV{SLUG};
  s/(          filters: \|\n)/$1            $s:\n              - '"'"'nodes\/$s\/**'"'"'\n/;
  s/(            operator:\n              - '"'"'\*\*'"'"'\n)/$1              - '"'"'!nodes\/$s\/**'"'"'\n/;
' .github/workflows/ci.yaml

echo "DONE. Scaffolded node '$SLUG' (port $PORT, nodePort $NODEPORT) across ${ENVS[*]}."
echo "Next: verify kustomize build for all 3 envs; add the build-and-push case; flight."
