#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
#
# scripts/ci/lib/mesh-plane.sh — READ-ONLY derivations for the per-env mesh plane (task.5428).
# Pure functions over committed declarations; no network, no writes. Sourced by deploy-infra.sh and
# render-caddyfile.sh so the VM, the edge and the k8s coordinators can never disagree.
#
# One source per fact (hub node-service-delivery §1-§2):
#   - which env VMs run the relay + gateway   -> infra/catalog/derper.yaml `envs:` + `compose_services:`
#   - an env's control URL (TLS 443 only)     -> server_url of infra/k8s/base/node-deploy-mesh/config/headscale-<env>.yaml
#   - an env's coordinator NodePort           -> port `headscale-<env>` in infra/k8s/base/node-deploy-mesh/service.yaml
#   - which env's edge fronts the coordinators -> the env whose operator overlay lists the node-deploy-mesh component
#
# Intentionally no `set -euo pipefail` — meant to be sourced; callers own shell options. Needs yq.

_mesh_plane_root="${MESH_PLANE_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
_mesh_plane_catalog="${COGNI_CATALOG_ROOT:-${_mesh_plane_root}/infra/catalog}"
_mesh_plane_component="${_mesh_plane_root}/infra/k8s/base/node-deploy-mesh"

# Space-separated Compose services that type:infra catalog rows ship in ENV (their `envs:` contain it).
#   catalog_compose_services_for_env ENV
catalog_compose_services_for_env() {
  local env="$1" f out=""
  for f in "$_mesh_plane_catalog"/*.yaml; do
    [ "$(yq -N '.type' "$f")" = "infra" ] || continue
    yq -N -e ".envs // [] | contains([\"$env\"])" "$f" >/dev/null 2>&1 || continue
    out+=" $(yq -N '.compose_services // [] | join(" ")' "$f")"
  done
  printf '%s' "$(printf '%s' "$out" | xargs)"
}

# True when ENV's VM runs the relay + gateway (the derper row lists it).
mesh_vm_plane_in_env() {
  yq -N -e ".envs // [] | contains([\"$1\"])" "$_mesh_plane_catalog/derper.yaml" >/dev/null 2>&1
}

# The envs with a declared coordinator, sorted (one config file each).
mesh_control_lanes() {
  local f
  for f in "$_mesh_plane_component"/config/headscale-*.yaml; do
    [ -f "$f" ] || continue
    f="${f##*/headscale-}"
    printf '%s\n' "${f%.yaml}"
  done | LC_ALL=C sort
}

# Host of ENV's control URL (https, port 443 implied). Fails on a missing or non-https server_url.
mesh_control_host_for_env() {
  local f="$_mesh_plane_component/config/headscale-$1.yaml" url host
  [ -f "$f" ] || { echo "[ERROR] mesh-plane: no coordinator declared for env '$1' ($f)" >&2; return 1; }
  url="$(yq -N '.server_url' "$f")"
  host="${url#https://}"
  if [ "$host" = "$url" ] || [ -z "$host" ] || [[ "$host" == *[:/]* ]]; then
    echo "[ERROR] mesh-plane: $f server_url must be https://<host> on 443 (got '$url')" >&2
    return 1
  fi
  printf '%s' "$host"
}

# NodePort of ENV's coordinator client port (Service port named headscale-<env>).
mesh_control_nodeport_for_env() {
  local p
  p="$(yq -N ".spec.ports[] | select(.name == \"headscale-$1\") | .nodePort" "$_mesh_plane_component/service.yaml")"
  [[ "$p" =~ ^[0-9]+$ ]] || { echo "[ERROR] mesh-plane: no NodePort named headscale-$1" >&2; return 1; }
  printf '%s' "$p"
}

# Comma-separated coordinator NodePorts (the hardener drops them from the public NIC).
mesh_control_nodeports_csv() {
  local lane out=""
  while read -r lane; do
    out+="${out:+,}$(mesh_control_nodeport_for_env "$lane")" || return 1
  done < <(mesh_control_lanes)
  printf '%s' "$out"
}

# True when ENV's edge fronts the coordinators: its operator overlay lists the node-deploy-mesh component.
mesh_control_edge_in_env() {
  local k="$_mesh_plane_root/infra/k8s/overlays/$1/operator/kustomization.yaml"
  [ -f "$k" ] || return 1
  yq -N -e '.components // [] | map(select(test("(^|/)node-deploy-mesh$"))) | length > 0' "$k" >/dev/null 2>&1
}
