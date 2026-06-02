#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# render-node-overlays.sh — emit per-env kustomize overlays for a node from the
# catalog (CATALOG_IS_SSOT). The deploy-footprint sibling of render-caddyfile.sh.
#
# A node's three overlays (candidate-a/preview/production) are a PURE FUNCTION of
# its catalog entry: name, node_port (Service NodePort), and port (container /
# target port). Everything else is either env-invariant boilerplate (the base
# node-app patch shape, the doltgres migrator initContainer, the bug.0295
# ExternalName conversions) or a per-env substitution (namespace, TEMPORAL_*,
# NEXTAUTH_URL host, the VM-DNS externalName). Hand-authoring ~193 lines × 3 envs
# per node is the standing source of the "candidate-a-only trap" (a node declared
# in the catalog but missing a preview/production overlay breaks the promote seed
# for everyone — see docs/guides/create-node.md). This generator makes the full
# matrix a one-command emit, and `--check` makes drift a CI failure.
#
# The image `digest` is the ONE field this script cannot own: it is mutated
# post-commit by candidate-flight / promote (promote-k8s-image.sh). The renderer
# always emits the zero placeholder; `--check` normalizes the digest line on both
# sides before diffing, so a flighted/seeded real digest never reads as drift.
#
# Managed set = every `type: node` catalog entry that is NOT is_primary_host
# (operator serves the bare domain via a hand-authored overlay) and NOT in
# UNMANAGED_NODES. `scheduler-worker` is `type: service` and is excluded
# automatically. A newly-declared catalog node is auto-managed: its overlays must
# exist and match, or `--check` fails — which is exactly what makes the
# candidate-a-only trap structurally impossible.
#
# Usage: render-node-overlays.sh <node> <env>   # one overlay to stdout
#        render-node-overlays.sh --write         # (re)write every managed overlay
#        render-node-overlays.sh --check          # diff committed vs generated (digest-normalized)
#        render-node-overlays.sh --appset-stanza <node> <env>  # the AppSet git-generator block for a node
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/ci/lib/image-tags.sh
source "${SCRIPT_DIR}/lib/image-tags.sh"

REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
OVERLAYS_ROOT="${REPO_ROOT}/infra/k8s/overlays"
ENVS=(candidate-a preview production)

# Nodes whose committed overlays predate the canonical template (canary /
# node-template) and carry deliberate divergence the renderer must not clobber.
# resy: pre-doltgres-migrator overlay shape + a container-port that disagrees
# with its catalog `port` (3300 vs 3000). Reconciling resy is its own change
# (it deploys to production); until then it is hand-owned, not renderer-owned.
UNMANAGED_NODES=(resy)

is_unmanaged() {
  local n="$1" u
  for u in "${UNMANAGED_NODES[@]}"; do [ "$n" = "$u" ] && return 0; done
  return 1
}

# Echo the managed node list: type:node, not primary-host, not unmanaged.
managed_nodes() {
  local n
  for n in "${NODE_TARGETS[@]}"; do
    is_primary_host "$n" && continue
    is_unmanaged "$n" && continue
    printf '%s\n' "$n"
  done
}

# Per-env substitutions ---------------------------------------------------------
# k8s namespace + Temporal namespace are both `cogni-<env>`.
ns_for_env() { printf 'cogni-%s' "$1"; }

# VM-DNS ExternalName host (bug.0295). candidate-a points at the monorepo VM
# alias `cogni-candidate-a.vm…`; preview/production use the bare `<env>.vm…`.
externalname_host_for_env() {
  case "$1" in
    candidate-a) printf 'cogni-candidate-a.vm.cognidao.org' ;;
    *) printf '%s.vm.cognidao.org' "$1" ;;
  esac
}

# Public NEXTAUTH_URL host. candidate-a → <node>-test., preview → <node>-preview.,
# production → <node>. (bare). Mirrors the edge DNS + host_for_node convention.
nextauth_url_for() {
  local node="$1" env="$2"
  case "$env" in
    candidate-a) printf 'https://%s-test.cognidao.org' "$node" ;;
    preview)     printf 'https://%s-preview.cognidao.org' "$node" ;;
    production)  printf 'https://%s.cognidao.org' "$node" ;;
  esac
}

# Emit one overlay kustomization.yaml to stdout. $1=node $2=env
render_overlay() {
  local node="$1" env="$2" ns en nextauth port nodeport
  ns="$(ns_for_env "$env")"
  en="$(externalname_host_for_env "$env")"
  nextauth="$(nextauth_url_for "$node" "$env")"
  nodeport="$(node_port_for_target "$node")"
  port="$(yq -N '.port' "${_image_tags_catalog_root}/${node}.yaml")"

  cat <<EOF
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

namespace: ${ns}

resources:
  - ../../../base/node-app

namePrefix: ${node}-

images:
  - name: ghcr.io/cogni-dao/cogni-template
    newName: ghcr.io/cogni-dao/cogni-template
    digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000"

patches:
  - target:
      kind: ConfigMap
      name: node-app-config
    patch: |
      - op: replace
        path: /data/NODE_NAME
        value: "${node}"
      - op: replace
        path: /data/TEMPORAL_NAMESPACE
        value: "${ns}"
      - op: replace
        path: /data/LITELLM_BASE_URL
        value: "http://${node}-litellm-external:4000"
      - op: replace
        path: /data/TEMPORAL_ADDRESS
        value: "${node}-temporal-external:7233"
      - op: replace
        path: /data/REDIS_URL
        value: "redis://${node}-redis-external:6379"
      - op: add
        path: /data/NEXTAUTH_URL
        value: "${nextauth}"
  - target:
      kind: Service
      name: node-app
    patch: |
      - op: add
        path: /spec/ports/0/nodePort
        value: ${nodeport}
      - op: replace
        path: /spec/ports/0/targetPort
        value: ${port}
      - op: add
        path: /spec/selector/app.kubernetes.io~1instance
        value: "${node}"
  - target:
      kind: Deployment
      name: node-app
    patch: |
      - op: replace
        path: /spec/template/spec/containers/0/envFrom/1/secretRef/name
        value: "${node}-node-app-secrets"
      - op: replace
        path: /spec/template/spec/initContainers/0/envFrom/1/secretRef/name
        value: "${node}-node-app-secrets"
      - op: replace
        path: /spec/template/spec/containers/0/ports/0/containerPort
        value: ${port}
      - op: add
        path: /spec/selector/matchLabels/app.kubernetes.io~1instance
        value: "${node}"
      - op: add
        path: /spec/template/metadata/labels/app.kubernetes.io~1instance
        value: "${node}"

  # task.5077: Doltgres knowledge-plane migrator runs as a second initContainer
  # on the ${node} Deployment. DATABASE_URL maps to DOLTGRES_URL (separate
  # from the Postgres DATABASE_URL the main container + first initContainer use).
  # Mirrors operator's pattern verbatim.
  - target:
      kind: Deployment
      name: node-app
    patch: |
      - op: add
        path: /spec/template/spec/initContainers/-
        value:
          name: migrate-doltgres
          image: ghcr.io/cogni-dao/cogni-template:placeholder
          command:
            - /bin/sh
            - -c
            - exec node /app/nodes/\$(NODE_NAME)/app/migrate-doltgres.mjs /app/nodes/\$(NODE_NAME)/app/doltgres-migrations
          envFrom:
            - configMapRef:
                name: ${node}-node-app-config
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: ${node}-node-app-secrets
                  key: DOLTGRES_URL
          resources:
            requests:
              memory: "384Mi"
              cpu: "200m"
            limits:
              memory: "1Gi"
              cpu: "1000m"
  # bug.0295: VM discovery via DNS (${en}).
  # Convert base headless Services → ExternalName; delete EndpointSlices.
  - target: { kind: Service, name: postgres-external }
    patch: |
      apiVersion: v1
      kind: Service
      metadata:
        name: postgres-external
      spec:
        type: ExternalName
        externalName: ${en}
        clusterIP: null
  - target: { kind: Service, name: temporal-external }
    patch: |
      apiVersion: v1
      kind: Service
      metadata:
        name: temporal-external
      spec:
        type: ExternalName
        externalName: ${en}
        clusterIP: null
  - target: { kind: Service, name: litellm-external }
    patch: |
      apiVersion: v1
      kind: Service
      metadata:
        name: litellm-external
      spec:
        type: ExternalName
        externalName: ${en}
        clusterIP: null
  - target: { kind: Service, name: redis-external }
    patch: |
      apiVersion: v1
      kind: Service
      metadata:
        name: redis-external
      spec:
        type: ExternalName
        externalName: ${en}
        clusterIP: null
  - target: { kind: Service, name: doltgres-external }
    patch: |
      apiVersion: v1
      kind: Service
      metadata:
        name: doltgres-external
      spec:
        type: ExternalName
        externalName: ${en}
        clusterIP: null
  - target: { kind: EndpointSlice, name: postgres-external-1 }
    patch: |
      \$patch: delete
      apiVersion: discovery.k8s.io/v1
      kind: EndpointSlice
      metadata:
        name: postgres-external-1
  - target: { kind: EndpointSlice, name: temporal-external-1 }
    patch: |
      \$patch: delete
      apiVersion: discovery.k8s.io/v1
      kind: EndpointSlice
      metadata:
        name: temporal-external-1
  - target: { kind: EndpointSlice, name: litellm-external-1 }
    patch: |
      \$patch: delete
      apiVersion: discovery.k8s.io/v1
      kind: EndpointSlice
      metadata:
        name: litellm-external-1
  - target: { kind: EndpointSlice, name: redis-external-1 }
    patch: |
      \$patch: delete
      apiVersion: discovery.k8s.io/v1
      kind: EndpointSlice
      metadata:
        name: redis-external-1
  - target: { kind: EndpointSlice, name: doltgres-external-1 }
    patch: |
      \$patch: delete
      apiVersion: discovery.k8s.io/v1
      kind: EndpointSlice
      metadata:
        name: doltgres-external-1
EOF
}

# Emit the ApplicationSet git-generator stanza for one node+env. The wizard
# appends this to infra/k8s/argocd/<env>-applicationset.yaml so the node's
# deploy branch is discovered. Inert until the deploy branch exists.
render_appset_stanza() {
  local node="$1" env="$2"
  cat <<EOF
    - git:
        repoURL: https://github.com/cogni-dao/cogni.git
        revision: deploy/${env}-${node}
        files:
          - path: "infra/catalog/${node}.yaml"
EOF
}

# Normalize the flight-mutated image digest so a real seeded/flighted digest
# never reads as drift against the renderer's placeholder.
normalize_digest() { sed -E 's/digest: "sha256:[0-9a-f]{64}"/digest: "sha256:NORMALIZED"/'; }

overlay_path() { printf '%s/%s/%s/kustomization.yaml' "$OVERLAYS_ROOT" "$2" "$1"; }

# The digest is flight/promote-owned (candidate-a is patched on acquisition,
# preview is auto-seeded, production is human-gated). The renderer must never
# clobber a real seeded digest with the placeholder. Preserve the committed
# digest line when rewriting an existing overlay.
preserve_digest() {
  local path="$1" existing
  if [ -f "$path" ]; then
    existing="$(grep -oE 'digest: "sha256:[0-9a-f]{64}"' "$path" | head -1 || true)"
    if [ -n "$existing" ]; then
      sed -E "s|digest: \"sha256:[0-9a-f]{64}\"|${existing}|"
      return
    fi
  fi
  cat
}

do_write() {
  local node env path
  while read -r node; do
    for env in "${ENVS[@]}"; do
      path="$(overlay_path "$node" "$env")"
      mkdir -p "$(dirname "$path")"
      render_overlay "$node" "$env" | preserve_digest "$path" >"${path}.tmp"
      mv "${path}.tmp" "$path"
      echo "wrote ${path#"${REPO_ROOT}/"}"
    done
  done < <(managed_nodes)
}

do_check() {
  local node env path rc=0 difftmp
  difftmp="$(mktemp)"
  trap 'rm -f "$difftmp"' RETURN
  while read -r node; do
    for env in "${ENVS[@]}"; do
      path="$(overlay_path "$node" "$env")"
      if [ ! -f "$path" ]; then
        echo "[ERROR] missing overlay: ${path#"${REPO_ROOT}/"} (run: pnpm gen:overlays)" >&2
        rc=1
        continue
      fi
      if ! diff -u <(normalize_digest <"$path") <(render_overlay "$node" "$env" | normalize_digest) >"$difftmp" 2>&1; then
        echo "[ERROR] ${path#"${REPO_ROOT}/"} is out of sync with the catalog." >&2
        cat "$difftmp" >&2
        rc=1
      fi
    done
  done < <(managed_nodes)
  if [ "$rc" -eq 0 ]; then
    echo "node overlays are in sync with the catalog ($(managed_nodes | tr '\n' ' ')× ${ENVS[*]})."
  else
    echo "        Run: pnpm gen:overlays" >&2
  fi
  return "$rc"
}

case "${1:-}" in
  --write) do_write ;;
  --check) do_check ;;
  --list-managed) managed_nodes ;;
  --appset-stanza) render_appset_stanza "${2:?node}" "${3:?env}" ;;
  "" | -h | --help)
    grep '^# ' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    ;;
  *) render_overlay "${1:?node}" "${2:?env}" ;;
esac
