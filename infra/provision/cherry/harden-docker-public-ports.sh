#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
#
# Closes internal Docker-published ports (postgres, doltgres, redis, litellm,
# OpenFGA, temporal-grpc) and the selected k3s controller-metrics NodePort to
# the public internet on Cogni Cherry VMs.
#
# Why DOCKER-USER and not UFW: Docker publishes ports via DNAT in
# nat/PREROUTING and forwards via the DOCKER chain, bypassing UFW's INPUT.
# DOCKER-USER runs before Docker's own forward rules, so a DROP here is the
# canonical hook (per Docker docs). Public NodePort traffic is DNATed to a pod
# and traverses FORWARD too, so the same public-interface DROP protects 30901;
# same-host Alloy enters from the Docker bridge and does not match that DROP.
#
# Why we still allow 10.42/16 + 10.43/16: k3s pods reach host services via
# the VM's public IP (Cherry has no private NIC; EndpointSlice points at
# the public IP). The kernel routes pod->public-IP traffic locally, so the
# pod's source IP is preserved into DOCKER-USER. Allow flannel pod CIDR +
# k3s service CIDR.
#
# Idempotent: tagged rules are removed before re-insertion.
# Links: bug.5167

set -euo pipefail

# This script is the sole DOCKER-USER writer, but it is reached by several
# independently queued workflows. Serialize on the substrate host itself: GitHub
# concurrency permits only one pending run and therefore cannot be used as a lock
# without cancelling legitimate sibling-node work.
HARDEN_LOCK_FILE="${HARDEN_LOCK_FILE:-/run/lock/cogni-harden-docker-public-ports.lock}"
mkdir -p "$(dirname "$HARDEN_LOCK_FILE")"
exec 9>"$HARDEN_LOCK_FILE"
flock -x 9

# Bare legacy compute-egress entries default only to this pre-existing set.
# Never add scrape ports here: doing so would silently expand provider access.
INTERNAL_PORTS="5432,5435,6379,4000,7233,8080"
# 30901 is the compute-workload-controller metrics NodePort. It is reachable by
# the co-located Compose Alloy through the Docker bridge, but public-interface
# traffic is denied below and it is never eligible for compute-egress access.
PUBLIC_DROP_PORTS="${INTERNAL_PORTS},30901"
POD_CIDR="10.42.0.0/16"
SVC_CIDR="10.43.0.0/16"
TAG="cogni-harden-internal-ports"

PUBLIC_IFACE="$(ip route get 8.8.8.8 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="dev") print $(i+1)}' | head -1)"
[ -n "$PUBLIC_IFACE" ] || { echo "[harden] ERROR: could not detect public NIC" >&2; exit 1; }
echo "[harden] public NIC: $PUBLIC_IFACE"

for i in $(seq 1 30); do
  if iptables -L DOCKER-USER -n >/dev/null 2>&1; then break; fi
  echo "[harden] waiting for DOCKER-USER chain ($i/30)..."
  sleep 2
done
iptables -L DOCKER-USER -n >/dev/null

# Delete by rule line number, not by re-parsing `iptables -S` output.
# `iptables -S` quotes comment values (`--comment "foo"`); shell word-splitting
# of that string passes literal quote chars into `iptables -D`, which then
# fails to match the stored rule (`Bad rule (does a matching rule exist...)`)
# and aborts under set -e. (bug.5171)
while :; do
  ln=$(iptables -L DOCKER-USER --line-numbers -n 2>/dev/null | awk -v t="$TAG" '$0 ~ t {print $1; exit}')
  [ -z "$ln" ] && break
  iptables -D DOCKER-USER "$ln"
done

iptables -A DOCKER-USER -m conntrack --ctstate ESTABLISHED,RELATED -m comment --comment "$TAG:established" -j ACCEPT
iptables -A DOCKER-USER -s "$POD_CIDR" -m comment --comment "$TAG:pod-cidr" -j ACCEPT
iptables -A DOCKER-USER -s "$SVC_CIDR" -m comment --comment "$TAG:svc-cidr" -j ACCEPT
iptables -A DOCKER-USER -s 127.0.0.0/8 -m comment --comment "$TAG:loopback" -j ACCEPT

# Decentralized-compute egress allowlist (task.5044): node-app workloads running on
# external compute (e.g. Akash providers) dial the shared substrate on these same
# internal ports. One entry per line in $ALLOWLIST_FILE: `CIDR` or `CIDR:port,port`
# (comments/# allowed); each gets an ACCEPT ahead of the public DROP, scoped to the
# named ports (default: all internal ports). Empty/absent file = no external compute.
# Provider egress IPs are multi-tenant — grant only the ports the workload dials.
#
# task.5052 — the allowlist is CATALOG-RENDERED (CATALOG_IS_SSOT), not hand-managed:
# deploy-infra.sh renders infra/catalog/*.yaml `compute_egress_cidrs` via
# scripts/ci/render-compute-egress-allowlist.sh and stages the result at
# $STAGED_ALLOWLIST on every deploy. Installing it here — even when it contains no
# allow lines — is what makes catalog REMOVAL converge on the next run. No staged
# file (cloud-init boot runs before any deploy; a fresh VM has no installed file
# either) = fail-closed until the first deploy stages one. Paths are overridable
# for tests only.
ALLOWLIST_FILE="${ALLOWLIST_FILE:-/etc/cogni/compute-egress-allowlist}"
STAGED_ALLOWLIST="${STAGED_ALLOWLIST:-/tmp/compute-egress-allowlist}"
if [ -f "$STAGED_ALLOWLIST" ]; then
  mkdir -p "$(dirname "$ALLOWLIST_FILE")"
  install -m 0644 "$STAGED_ALLOWLIST" "$ALLOWLIST_FILE"
  echo "[harden] installed catalog-rendered compute-egress allowlist -> $ALLOWLIST_FILE"
fi
if [ -f "$ALLOWLIST_FILE" ]; then
  while IFS= read -r line; do
    case "$line" in ""|\#*) continue ;; esac
    cidr="${line%%:*}"
    ports="$INTERNAL_PORTS"
    case "$line" in *:*) ports="${line#*:}" ;; esac
    # Validate before touching iptables: a malformed line must NEVER abort the script
    # between the old-rule delete and the DROP append (that would fail OPEN).
    case "$cidr" in
      *[!0-9./]*|"") echo "[harden] WARN: skipping invalid CIDR: $line" >&2; continue ;;
    esac
    case "$ports" in
      *[!0-9,]*|"") echo "[harden] WARN: skipping invalid ports: $line" >&2; continue ;;
    esac
    if iptables -A DOCKER-USER -s "$cidr" -p tcp -m multiport --dports "$ports" \
      -m comment --comment "$TAG:compute-egress-allow" -j ACCEPT; then
      echo "[harden] compute-egress allow: $cidr -> $ports"
    else
      echo "[harden] WARN: iptables rejected allowlist line: $line" >&2
    fi
  done < "$ALLOWLIST_FILE"
fi

iptables -A DOCKER-USER -i "$PUBLIC_IFACE" -p tcp -m multiport --dports "$PUBLIC_DROP_PORTS" -m comment --comment "$TAG:drop-public" -j DROP

DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent >/dev/null
netfilter-persistent save >/dev/null

echo "[harden] done. DOCKER-USER rules:"
iptables -S DOCKER-USER | grep -- "$TAG" || true
