#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
#
# Closes Docker-published "internal" ports (postgres, doltgres, redis,
# litellm, OpenFGA, temporal-grpc) to the public internet on Cogni Cherry VMs.
#
# Why DOCKER-USER and not UFW: Docker publishes ports via DNAT in
# nat/PREROUTING and forwards via the DOCKER chain, bypassing UFW's INPUT.
# DOCKER-USER runs before Docker's own forward rules, so a DROP here is the
# canonical hook (per Docker docs).
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

INTERNAL_PORTS="5432,5435,6379,4000,7233,8080"
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
iptables -A DOCKER-USER -i "$PUBLIC_IFACE" -p tcp -m multiport --dports "$INTERNAL_PORTS" -m comment --comment "$TAG:drop-public" -j DROP

DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent >/dev/null
netfilter-persistent save >/dev/null

echo "[harden] done. DOCKER-USER rules:"
iptables -S DOCKER-USER | grep -- "$TAG" || true
