#!/usr/bin/env bash
# assert-honest-allocatable.sh — fail unless the k3s node reserves memory for the
# co-resident Compose stack + OS (kubelet `system-reserved` in effect).
#
# WHY: prod nodes co-host a ~2.8GB Docker Compose stack k3s can't see. Without a
# `system-reserved` reservation the kubelet reports raw VM RAM as allocatable, the
# scheduler over-commits node-app pods, and under load the kubelet loses its
# heartbeat → cluster-wide readiness-probe timeouts → fleet-wide 502 (2026-07-16;
# a legacy node born before the reservation ran with allocatable == capacity).
# `provision-env-vm.sh` calls this as an explicit gate after the fresh node comes
# up, so a dishonest node fails the provision loudly instead of silently drifting.
# See docs/design/operator-fleet-safety.md SLA#1.
#
# Usage:
#   assert-honest-allocatable.sh            # uses $KUBECONFIG / default context
#   KUBECONFIG=/path/to/kubeconfig assert-honest-allocatable.sh
# Exit: 0 = honest (allocatable < capacity); 1 = dishonest or node unreadable.
set -euo pipefail

# Pure kubectl jsonpath (no jq) so this runs on a bare k3s VM via ssh as well as
# on a runner with a kubeconfig.
CAP=$(kubectl get node -o jsonpath='{.items[0].status.capacity.memory}' 2>/dev/null || true)
ALLOC=$(kubectl get node -o jsonpath='{.items[0].status.allocatable.memory}' 2>/dev/null || true)

if [ -z "$CAP" ] || [ -z "$ALLOC" ]; then
  echo "FATAL: node reported empty capacity/allocatable memory (cap='$CAP' alloc='$ALLOC')." >&2
  exit 1
fi

echo "node memory: capacity=$CAP allocatable=$ALLOC"

if [ "$CAP" = "$ALLOC" ]; then
  echo "FATAL: allocatable.memory == capacity.memory — kubelet system-reserved NOT in effect." >&2
  echo "  The node over-commits and will cascade to a fleet-502 under load." >&2
  echo "  Check /etc/rancher/k3s/config.yaml kubelet-arg and that k3s read it at start." >&2
  exit 1
fi

echo "OK: allocatable < capacity — system-reserved is in effect (honest allocatable)."
