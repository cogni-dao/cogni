#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
#
# scripts/ci/lib/mesh-plane.sh — the ONE declaration of the mesh tailnets (task.5428; hub
# node-service-delivery §1-§2, test-fleet parity) and READ-ONLY derivations over it. Pure functions;
# no network, no writes. Sourced by render-caddyfile.sh (edge sites) and, in later slices, by the DNS
# writer; the k8s coordinator and env-plane manifests (later slices) are pinned equal to this table by
# their CI invariants (node-deploy-mesh-coordinators.spec.ts, mesh-env-plane.spec.ts).
#
# One tailnet per environment, plus the test fleet's own tailnet (test-fleet parity):
#   tailnet           the tailnet name; its Headscale owner is cogni-mesh-<tailnet>
#   vm_env            the env VM that runs this tailnet's relay + substrate-gw ("" = not yet)
#   coordinator_env   the env whose operator sequencer runs this tailnet's Headscale, i.e. whose edge
#                     fronts mesh-<tailnet>.<zone> (production = canonical lanes; candidate-a = the
#                     test operator's own lanes)
#   control_label     <label>.<zone> = the control URL host (https, 443 only)
#   relay_label       <label>.<zone> = this tailnet's own relay host (DERP map hostname)
#   coordinator_np    k3s NodePort of the Headscale client port on coordinator_env's VM
#   relay_np          k3s NodePort of derper's plain-HTTP DERP port on vm_env's VM
#   publish_np        k3s NodePort of the enrollment publisher on vm_env's VM
#   wireguard_port    substrate-gw's pod-local tailscaled UDP port (TS_PORT). Never exposed: relay-only
#   derp_region       this tailnet's relay region id (its relay map has only this region)
#   zone              the DNS zone of this tailnet's control and relay hosts. Canonical tailnets live in
#                     the production zone; the test operator's tailnet lives in the isolated test-fleet
#                     zone (its NODE_DEPLOY_WORKLOAD_ZONE, hub test-fleet-parity-boundary), whose
#                     Cloudflare token is scoped to that zone only.
# NodePorts sit off the catalog node_port 100-stride (scripts/ci/next-free-node-port.sh).
#
# Intentionally no `set -euo pipefail` — meant to be sourced; callers own shell options.

MESH_TAILNETS_TABLE='
candidate-a|candidate-a|production|mesh-candidate-a|derp-candidate-a|32441|32340|32341|41641|901|cognidao.org
preview|preview|production|mesh-preview|derp-preview|32442|32346|32347|41641|902|cognidao.org
production|production|production|mesh-production|derp-production|32443|32344|32345|41641|903|cognidao.org
test-candidate-a|candidate-a|candidate-a|mesh-test-candidate-a|derp-test-candidate-a|32444|32342|32343|41642|904|cogni-testing.org
'

_mesh_plane_fields=(tailnet vm_env coordinator_env control_label relay_label coordinator_np relay_np publish_np wireguard_port derp_region zone)

# Every tailnet name, in table order.
mesh_tailnets() {
  printf '%s\n' "$MESH_TAILNETS_TABLE" | awk -F'|' 'NF > 1 { print $1 }'
}

# One field of one tailnet:  mesh_tailnet_field <tailnet> <field>
mesh_tailnet_field() {
  local tailnet="$1" field="$2" i col=0
  for i in "${!_mesh_plane_fields[@]}"; do
    [ "${_mesh_plane_fields[$i]}" = "$field" ] && col=$((i + 1))
  done
  [ "$col" -gt 0 ] || { echo "[ERROR] mesh-plane: unknown field '$field'" >&2; return 1; }
  printf '%s\n' "$MESH_TAILNETS_TABLE" | awk -F'|' -v t="$tailnet" -v c="$col" '$1 == t { print $c; found=1 } END { exit found ? 0 : 1 }' \
    || { echo "[ERROR] mesh-plane: unknown tailnet '$tailnet'" >&2; return 1; }
}

# Tailnets whose relay + substrate-gw run on ENV's VM.
mesh_vm_tailnets() {
  printf '%s\n' "$MESH_TAILNETS_TABLE" | awk -F'|' -v e="$1" 'NF > 1 && $2 == e { print $1 }'
}

# Tailnets whose coordinator ENV's edge fronts.
mesh_coordinator_tailnets() {
  printf '%s\n' "$MESH_TAILNETS_TABLE" | awk -F'|' -v e="$1" 'NF > 1 && $3 == e { print $1 }'
}

# <label>.<zone> for a tailnet's control or relay host:  mesh_host <tailnet> control|relay
mesh_host() {
  local label zone
  label="$(mesh_tailnet_field "$1" "${2}_label")" || return 1
  zone="$(mesh_tailnet_field "$1" zone)" || return 1
  printf '%s.%s' "$label" "$zone"
}

# Every plain-HTTP edge-only NodePort (coordinator, relay, publisher), sorted, comma-separated. The
# hardener drops exactly these from the public NIC on every VM.
mesh_edge_only_nodeports_csv() {
  printf '%s\n' "$MESH_TAILNETS_TABLE" \
    | awk -F'|' 'NF > 1 { for (i = 6; i <= 8; i++) if ($i != "") print $i }' \
    | LC_ALL=C sort -n | paste -sd, -
}
