#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
#
# Native admission proof, not a deployment or a preview-recovery assertion.
# prepare BASE HEAD BUNDLE: archive exact committed inputs on the developer host.
# run BUNDLE: bounded candidate-a-only experiment; requires local Docker/k3s.
# A disposable, credential-free Pod owns all namespaces, files and rules. Only
# systemctl is stubbed: unchanged boot persistence is outside this policy proof.
# Real renderer, hardener, iptables, DNAT, conntrack and TCP are never replaced.
# Render resolves the existing migration-custodian DNS name; no deployed service
# endpoint is probed. All TCP exercises stay inside owned network namespaces.
# No host firewall or service is changed. PodSecurity rejection is a hard stop,
# never permission for privileged, host-network or host-filesystem fallback.
# Links: bug.5538; bug.5326 remains the broader egress-drift automation owner.
set -euo pipefail

SELF_PATH=scripts/ci/prove-compute-egress-native.sh

if [[ ${1:-} == prepare ]]; then
  [[ $# == 4 ]] || { echo 'usage: prepare BASE HEAD BUNDLE' >&2; exit 2; }
  base=$(git rev-parse --verify "$2^{commit}")
  head=$(git rev-parse --verify "$3^{commit}")
  bundle=$4
  stage=$(mktemp -d)
  trap 'rm -rf "$stage"' EXIT
  for pair in "base:$base" "head:$head"; do
    name=${pair%%:*}; sha=${pair#*:}
    mkdir "$stage/$name"
    git archive "$sha" infra/catalog scripts/ci/render-compute-egress-allowlist.sh \
      scripts/ci/lib/image-tags.sh scripts/ci/lib/appset-paths.sh \
      scripts/ci/lib/lane-db-residency.sh scripts/ci/lib/compute-egress-policy.sh \
      scripts/setup/lib/cogni-deployment-identity.sh scripts/setup/lib/fork-identity.sh \
      scripts/bootstrap/install/install-yq.sh \
      infra/provision/cherry/harden-docker-public-ports.sh \
      infra/compose/runtime/docker-compose.yml nodes/operator/.cogni/repo-spec.yaml \
      | tar -x -C "$stage/$name"
  done
  git show "$head:$SELF_PATH" > "$stage/proof.sh"
  printf '%s\n%s\n' "$base" "$head" > "$stage/sources"
  tar -czf "$bundle" -C "$stage" .
  printf 'base=%s head=%s bundle=%s\n' "$base" "$head" "$bundle"
  exit
fi

if [[ ${1:-} == run ]]; then
  [[ $# == 2 ]] || exit 2
  exec timeout --signal=TERM --kill-after=25 270 bash "$0" run-bounded "$2"
fi

if [[ ${1:-} == run-bounded ]]; then
  [[ $# == 2 && $(hostname) == candidate-a-* ]] || {
    echo 'run requires one bundle on the candidate-a VM' >&2; exit 2;
  }
  # The caller also imposes a five-minute wall-clock deadline. A Pod deadline
  # and cleanup trap bound runtime even if a native assertion fails.
  stage=$(mktemp -d)
  fixture="candidate-policy-proof-$(date +%s)-$$"
  image="localhost/$fixture:proof"
  namespace=cogni-candidate-a
  # shellcheck disable=SC2329 # Invoked by EXIT, including timeout/TERM failures.
  cleanup() {
    status=$?
    trap - EXIT
    timeout 10 k3s kubectl -n "$namespace" delete pod "$fixture" \
      --ignore-not-found --wait=true --timeout=8s >/dev/null 2>&1 || status=1
    timeout 5 k3s ctr images rm "$image" >/dev/null 2>&1 || status=1
    timeout 5 docker image rm "$image" >/dev/null 2>&1 || status=1
    rm -rf "$stage"
    exit "$status"
  }
  trap cleanup EXIT
  trap 'exit 130' INT TERM
  tar -xzf "$2" -C "$stage"
  mapfile -t sources < "$stage/sources"
  [[ ${sources[0]} =~ ^[a-f0-9]{40}$ && ${sources[1]} =~ ^[a-f0-9]{40}$ ]]
  k3s kubectl get namespace "$namespace" >/dev/null
  printf 'candidate=%s base=%s head=%s fixture=%s\n' \
    "$(hostname)" "${sources[0]}" "${sources[1]}" "$fixture"
  # Resolve the existing declared fixture base and bootstrap tool version;
  # never import a new application image or modify a deployed container.
  base_image=$(awk '/^  postgres:/{seen=1;next} seen && /image:/{print $2;exit}' \
    "$stage/head/infra/compose/runtime/docker-compose.yml")
  yq_version=$(sed -n 's/.*YQ_VERSION:-\(v[0-9.]*\).*/\1/p' \
    "$stage/head/scripts/bootstrap/install/install-yq.sh")
  [[ $base_image == postgres:* && $yq_version =~ ^v[0-9.]+$ ]]
  cat > "$stage/Dockerfile" <<'DOCKER'
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ARG YQ_VERSION
USER root
ENV DEBIAN_FRONTEND=noninteractive
COPY head/scripts/bootstrap/install/install-yq.sh /tmp/install-yq.sh
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
    iproute2 iptables iptables-persistent conntrack python3 util-linux procps \
    curl ca-certificates sudo \
    && YQ_VERSION="${YQ_VERSION}" bash /tmp/install-yq.sh \
    && rm -rf /var/lib/apt/lists/* /tmp/install-yq.sh
COPY base /base
COPY head /head
COPY sources /sources
COPY proof.sh /proof.sh
ENTRYPOINT ["bash", "/proof.sh", "inside"]
DOCKER
  timeout 100 docker build --quiet --build-arg "BASE_IMAGE=$base_image" \
    --build-arg "YQ_VERSION=$yq_version" -t "$image" "$stage"
  docker image inspect "$image" --format 'fixture_image={{.Id}}'
  # shellcheck disable=SC2016 # $1 is the child shell's argument, not outer interpolation.
  timeout 20 bash -o pipefail -c 'docker save "$1" | k3s ctr images import -' _ "$image" >/dev/null
  # No host mounts, host namespaces, service-account token or network service.
  # SYS_ADMIN permits only this Pod's nested netns/mount operations; never
  # escalate to privileged or hostNetwork if the runtime refuses them.
  k3s kubectl -n "$namespace" create -f - <<POD
apiVersion: v1
kind: Pod
metadata:
  name: $fixture
  labels:
    app: candidate-policy-proof
  annotations:
    container.apparmor.security.beta.kubernetes.io/candidate-policy-proof: unconfined
spec:
  automountServiceAccountToken: false
  hostNetwork: false
  hostPID: false
  hostIPC: false
  restartPolicy: Never
  activeDeadlineSeconds: 100
  terminationGracePeriodSeconds: 5
  containers:
    - name: candidate-policy-proof
      image: $image
      imagePullPolicy: Never
      securityContext:
        runAsUser: 0
        capabilities:
          drop: [ALL]
          add: [NET_ADMIN, SYS_ADMIN]
        seccompProfile:
          type: Unconfined
      resources:
        requests: {cpu: 50m, memory: 64Mi, ephemeral-storage: 128Mi}
        limits: {cpu: 500m, memory: 256Mi, ephemeral-storage: 512Mi}
POD
  phase=''
  for _ in $(seq 1 55); do
    phase=$(k3s kubectl -n "$namespace" get pod "$fixture" -o jsonpath='{.status.phase}')
    [[ $phase != Succeeded && $phase != Failed ]] || break
    sleep 2
  done
  k3s kubectl -n "$namespace" get pod "$fixture" -o \
    'jsonpath={.metadata.uid} {.spec.nodeName} {.status.containerStatuses[0].imageID} {.status.containerStatuses[0].state}{"\n"}'
  k3s kubectl -n "$namespace" logs "$fixture" --timestamps
  # Preserve the native stdout long enough for Alloy's existing 10s discovery.
  sleep 12
  [[ $phase == Succeeded ]]
  exit
fi

[[ ${1:-} == inside && -f /sources ]] || {
  echo 'usage: prepare BASE HEAD BUNDLE | run BUNDLE' >&2; exit 2;
}
mapfile -t sources < /sources
export FORK_DOMAIN_ROOT=cognidao.org
emit() {
  python3 - "$1" "${sources[0]}" "${sources[1]}" "${2:-}" <<'PY'
import json,sys
print(json.dumps(dict(event="compute.egress.native", fixture="candidate-policy-proof",
    assertion=sys.argv[1],baseSha=sys.argv[2],sourceSha=sys.argv[3],detail=sys.argv[4])),flush=True)
PY
}
trap 'emit terminal "exit=$?"' EXIT
emit start "yq=$(yq --version); binary=$(sha256sum /usr/local/bin/yq)"
for tree in base head; do
  bash "/$tree/scripts/ci/render-compute-egress-allowlist.sh" preview preview > "/$tree.rules"
  emit render "$tree $(sha256sum "/$tree.rules")"
done
cmp /base/infra/provision/cherry/harden-docker-public-ports.sh \
  /head/infra/provision/cherry/harden-docker-public-ports.sh
emit hardener "$(sha256sum /head/infra/provision/cherry/harden-docker-public-ports.sh)"
if grep -qx '95.217.139.183/32:5432' /base.rules; then
  emit invalid-baseline 'Base already admits this source and port.'
  exit 1
fi
grep -qx '95.217.139.183/32:5432' /head.rules

# systemctl alone is a fixture shim: there is no service manager in this Pod.
# Persistence still writes real files and real iptables-save in the Pod rootfs.
mkdir /proof-bin
printf '#!/bin/sh\nexit 0\n' > /proof-bin/systemctl
chmod +x /proof-bin/systemctl
export PATH="/proof-bin:$PATH"
for ns in client router server; do ip netns add "$ns"; ip -n "$ns" link set lo up; done
ip link add public type veth peer name uplink
ip link set public netns router; ip link set uplink netns client
ip link add private type veth peer name backend
ip link set private netns router; ip link set backend netns server
ip -n router addr add 192.0.2.1/24 dev public
ip -n client addr add 192.0.2.2/24 dev uplink
ip -n router addr add 198.18.0.1/24 dev private
ip -n server addr add 198.18.0.2/24 dev backend
for pair in router:public router:private client:uplink server:backend; do
  ip -n "${pair%%:*}" link set "${pair#*:}" up
done
for suffix in 183 184; do
  ip -n client addr add "95.217.139.$suffix/32" dev lo
  ip -n router route add "95.217.139.$suffix/32" via 192.0.2.2
done
ip -n client route add default via 192.0.2.1
ip -n server route add default via 198.18.0.1
ip -n router route add default via 192.0.2.2
# Kubelet mounts proc/sys read-only by default. Remount only inside this
# Pod-owned router mount/network namespace; never change any host sysctl.
ip netns exec router sh -c \
  'mount -o remount,bind,rw /proc/sys && sysctl -qw net.ipv4.ip_forward=1'
[[ $(ip netns exec router sysctl -n net.ipv4.ip_forward) == 1 ]]
emit forwarding-enabled 'router net.ipv4.ip_forward=1; private mount lifetime only'
ip netns exec router iptables -N DOCKER-USER
ip netns exec router iptables -A FORWARD -j DOCKER-USER
for port in 5432 5435; do
  ip netns exec router iptables -t nat -A PREROUTING -i public -p tcp --dport "$port" \
    -j DNAT --to-destination 198.18.0.2:5432
done
cat > /listener.py <<'PY'
import socket
s=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
s.bind(("0.0.0.0",5432));s.listen()
while True:
    c,_=s.accept()
    with c:
        c.settimeout(2)
        try: c.sendall(c.recv(100))
        except OSError: pass
PY
ip netns exec server python3 /listener.py &
listener=$!
for _ in $(seq 1 20); do
  ip netns exec server ss -ltn | grep -q ':5432 ' && break
  sleep .1
done
ip netns exec server ss -ltn | grep ':5432 '
cat > /probe.py <<'PY'
import socket,sys
s=socket.socket();s.settimeout(1.5)
if sys.argv[1]!="-": s.bind((sys.argv[1],0))
try:
    s.connect((sys.argv[2],int(sys.argv[3])));s.sendall(b"native-policy-control")
    assert s.recv(100)==b"native-policy-control"
except (OSError,AssertionError): sys.exit(1)
finally: s.close()
PY

probe() {
  local name=$1 source=$2 port=$3 expect=$4 rc=0
  # A direct backend control proves the listener independently of admission.
  ip netns exec router python3 /probe.py - 198.18.0.2 5432
  ip netns exec router conntrack -F >/dev/null 2>&1
  ip netns exec router iptables -Z DOCKER-USER
  ip netns exec router iptables -t nat -Z PREROUTING
  ip netns exec client python3 /probe.py "$source" 192.0.2.1 "$port" || rc=$?
  ip netns exec router iptables -nvxL DOCKER-USER
  ip netns exec router conntrack -L -p tcp -o extended 2>/dev/null
  ip netns exec router iptables-save -t nat -c | grep -E '^\[[1-9][0-9]*:' \
    | grep -- "--dport $port " | grep -- '--to-destination 198.18.0.2:5432' >/dev/null
  counters=$(ip netns exec router iptables-save -c)
  if [[ $expect == allow ]]; then
    [[ $rc == 0 ]]
    printf '%s\n' "$counters" | grep -E '^\[[1-9][0-9]*:' \
      | grep -- '-s 95.217.139.183/32' | grep -- '--ctorigdstport 5432' >/dev/null
    ip netns exec router conntrack -L -p tcp -o extended 2>/dev/null \
      | grep -E "src=$source dst=192.0.2.1 .*dport=$port .*src=198.18.0.2 .*sport=5432 " >/dev/null
  else
    [[ $rc == 1 ]]
    printf '%s\n' "$counters" | grep -E '^\[[1-9][0-9]*:' \
      | grep 'cogni-harden-internal-ports:drop-public' >/dev/null
  fi
  emit "$name" "source=$source publishedPort=$port expected=$expect actualExit=$rc"
}
for tree in base head; do
  ip netns exec router env STAGED_ALLOWLIST="/$tree.rules" \
    bash "/$tree/infra/provision/cherry/harden-docker-public-ports.sh"
  if [[ $tree == base ]]; then
    probe base-denies-new-source 95.217.139.183 5432 deny
  else
    probe head-admits-exact-port 95.217.139.183 5432 allow
    probe head-denies-other-source 95.217.139.184 5432 deny
    probe head-denies-other-published-port 95.217.139.183 5435 deny
  fi
done
kill "$listener"
wait "$listener" 2>/dev/null || true
emit pass 'Policy proof only; actual preview recovery remains unproven.'
