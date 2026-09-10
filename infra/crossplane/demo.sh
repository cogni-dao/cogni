#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
#
# End-to-end demo for the PRODUCTION-form Crossplane Akash reconcile.
#
#   unit tests (Go provider + JS mock)
#   -> kind up -> crossplane core -> functions -> custom provider-akash
#   -> mock Console -> XRD + Composition
#   -> apply XAkashWorkload -> reconcile to READY (Create+Observe via the provider)
#   -> IN-CLUSTER CRASH-SAFE ADOPTION: drop the lease (external-name), provider
#      re-Observes and ADOPTS the same lease — NO second lease minted
#   -> DRIFT a field -> provider Update (same lease)
#   -> DELETE XR -> provider Delete -> lease released, escrow returned
#   -> teardown
#
# Everything runs against the in-cluster MOCK. ZERO real escrow is spent.
#
# Env:
#   OPERATOR_COMPUTE_TOKEN   bearer header value (default "Bearer mock-token")
#   KEEP_CLUSTER=1           skip teardown at the end
#   SKIP_UNIT=1              skip the unit-test phase (assume already run)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLUSTER=crossplane-akash-provider
KUBECTL="kubectl --context kind-${CLUSTER}"
TOKEN="${OPERATOR_COMPUTE_TOKEN:-Bearer mock-token}"
IMG=provider-akash:demo
PROVIDER_DIR="$HERE/provider-akash"
NODE_ID="11111111-1111-1111-1111-111111111111"

banner() { printf '\n\033[1;36m========== %s ==========\033[0m\n' "$*"; }
step()   { printf '\n\033[1;33m--- %s ---\033[0m\n' "$*"; }
green()  { printf '\033[1;32m%s\033[0m\n' "$*"; }
red()    { printf '\033[1;31m%s\033[0m\n' "$*"; }

mock_curl() { # $1 = path -> hit the mock from inside the cluster (with auth)
  # Retry: kubectl exec streams can transiently time out under host load.
  local i out
  for i in 1 2 3 4 5 6; do
    if out="$($KUBECTL -n akash-mock exec deploy/mock-console -- \
        wget -q -O - --header="authorization: ${TOKEN}" "http://localhost:8080$1" 2>/dev/null)"; then
      printf '%s' "$out"; return 0
    fi
    sleep 3
  done
  echo "mock_curl failed after retries: $1" >&2
  return 1
}
jval() { python3 -c "import sys,json;print(json.load(sys.stdin)['$1'])"; }
jlen() { python3 -c "import sys,json;print(len(json.load(sys.stdin)['$1']))"; }
mr_name()  { $KUBECTL get akashdeployment -o name | head -1; }
mr_lease() { $KUBECTL get "$(mr_name)" -o jsonpath='{.metadata.annotations.crossplane\.io/external-name}'; }

# ------------------------------------------------------------------ unit tests
if [ "${SKIP_UNIT:-0}" != "1" ]; then
  banner "UNIT TESTS (crash-safe adoption proof + mock contract)"
  step "Go provider unit tests"
  ( cd "$PROVIDER_DIR" && go test ./... -count=1 )
  step "JS mock unit tests"
  ( cd "$HERE/mock" && node --test )
fi

# ------------------------------------------------------------------ preflight
banner "PREFLIGHT"
for bin in docker kind kubectl helm go; do command -v "$bin" >/dev/null || { red "missing $bin"; exit 1; }; done
docker info >/dev/null 2>&1 || { red "docker daemon not running"; exit 1; }
echo "tooling OK"

# ------------------------------------------------------------------ kind
banner "KIND CLUSTER"
if kind get clusters | grep -qx "$CLUSTER"; then
  echo "cluster $CLUSTER exists — reusing"
else
  kind create cluster --config "$HERE/demo/kind.yaml"
fi
$KUBECTL cluster-info | head -1

# ------------------------------------------------------------------ build + load provider
banner "BUILD + LOAD provider-akash image"
docker build --platform=linux/arm64 -t "$IMG" "$PROVIDER_DIR"
kind load docker-image "$IMG" --name "$CLUSTER"

# ------------------------------------------------------------------ crossplane core
banner "INSTALL CROSSPLANE CORE (2.4.0)"
helm repo add crossplane-stable https://charts.crossplane.io/stable >/dev/null 2>&1 || true
helm repo update crossplane-stable >/dev/null
helm upgrade --install crossplane crossplane-stable/crossplane \
  --version 2.4.0 -n crossplane-system --create-namespace --wait --timeout 5m
$KUBECTL -n crossplane-system rollout status deploy/crossplane --timeout=180s

# ------------------------------------------------------------------ functions
banner "INSTALL composition functions"
$KUBECTL apply -f "$HERE/install/provider/functions.yaml"
$KUBECTL wait function.pkg/function-go-templating --for=condition=Healthy --timeout=300s
$KUBECTL wait function.pkg/function-auto-ready --for=condition=Healthy --timeout=300s

# ------------------------------------------------------------------ provider CRDs + controller
banner "INSTALL provider-akash (CRDs + controller)"
$KUBECTL apply -f "$PROVIDER_DIR/package/crds/"
$KUBECTL wait --for=condition=Established crd/akashdeployments.akash.crossplane.io --timeout=60s
$KUBECTL wait --for=condition=Established crd/providerconfigs.akash.crossplane.io --timeout=60s
$KUBECTL wait --for=condition=Established crd/providerconfigusages.akash.crossplane.io --timeout=60s
$KUBECTL apply -f "$HERE/demo/provider-rbac.yaml"
$KUBECTL apply -f "$HERE/demo/provider-deployment.yaml"
$KUBECTL -n crossplane-system rollout status deploy/provider-akash --timeout=180s

# ------------------------------------------------------------------ mock console
banner "DEPLOY MOCK AKASH CONSOLE"
$KUBECTL create namespace akash-mock --dry-run=client -o yaml | $KUBECTL apply -f -
$KUBECTL -n akash-mock delete configmap mock-console-src --ignore-not-found >/dev/null
$KUBECTL -n akash-mock create configmap mock-console-src --from-file=server.js="$HERE/mock/server.js"
$KUBECTL apply -f "$HERE/mock/k8s.yaml"
$KUBECTL -n akash-mock rollout restart deploy/mock-console
$KUBECTL -n akash-mock rollout status deploy/mock-console --timeout=120s
step "mock initial state"
mock_curl /debug/state; echo

# ------------------------------------------------------------------ credentials + providerconfig
banner "PROVIDERCONFIG (bearer from env, never hardcoded)"
$KUBECTL -n crossplane-system delete secret akash-console-credentials --ignore-not-found >/dev/null
$KUBECTL -n crossplane-system create secret generic akash-console-credentials \
  --from-literal=authorization="$TOKEN"
$KUBECTL apply -f "$HERE/demo/providerconfig.yaml"
echo "ProviderConfig default -> Secret akash-console-credentials (key: authorization)"

# ------------------------------------------------------------------ XRD + Composition
banner "INSTALL XRD + COMPOSITION (the only net-new YAML)"
$KUBECTL apply -f "$HERE/composition/xrd.yaml"
$KUBECTL wait xrd/xakashworkloads.compute.cogni.io --for=condition=Established --timeout=120s
$KUBECTL apply -f "$HERE/composition/composition.yaml"

# ------------------------------------------------------------------ CREATE -> READY
banner "APPLY XAkashWorkload -> RECONCILE TO READY"
$KUBECTL apply -f "$HERE/examples/xakashworkload.yaml"
step "waiting for the composed AkashDeployment to appear"
for _ in $(seq 1 30); do [ -n "$($KUBECTL get akashdeployment -o name 2>/dev/null)" ] && break; sleep 2; done
$KUBECTL wait xakashworkload/demo-node-app --for=condition=Ready --timeout=180s
step "XR status"
$KUBECTL get xakashworkload/demo-node-app -o jsonpath='{.status}'; echo
step "composed AkashDeployment (LEASE column = eagerly-captured external-name)"
$KUBECTL get akashdeployment -o wide
LEASE_BEFORE="$(mr_lease)"
echo "captured leaseId (external-name) = $LEASE_BEFORE"
step "mock state after create"
mock_curl /debug/state; echo
MINTED_BEFORE="$(mock_curl /debug/state | jval distinctLeasesMinted)"

# ------------------------------------------------------------------ CRASH-SAFE ADOPTION (in-cluster)
banner "CRASH-SAFE ADOPTION: lose the lease identity -> provider ADOPTS, no double-spend"
step "drop the external-name annotation (simulate a crash before identity persisted)"
$KUBECTL annotate "$(mr_name)" crossplane.io/external-name- --overwrite >/dev/null
echo "external-name after removal: '$(mr_lease)'"
echo "provider will re-Observe with no external-name -> FindByKey(nodeId) -> adopt..."
for _ in $(seq 1 30); do [ -n "$(mr_lease)" ] && break; sleep 2; done
LEASE_ADOPT="$(mr_lease)"
A_JSON="$(mock_curl /debug/state)"
MINTED_A="$(echo "$A_JSON" | jval distinctLeasesMinted)"
ACTIVE_A="$(echo "$A_JSON" | jlen activeLeaseIds)"
echo "mock after adoption: $A_JSON"
echo "leaseId: $LEASE_BEFORE -> $LEASE_ADOPT | distinctLeasesMinted: $MINTED_BEFORE -> $MINTED_A | activeLeases: $ACTIVE_A"
if [ "$LEASE_ADOPT" = "$LEASE_BEFORE" ] && [ "$MINTED_A" = "$MINTED_BEFORE" ] && [ "$ACTIVE_A" = "1" ]; then
  green "ADOPTED the same lease. No second lease minted. Window closed IN-CLUSTER."
else
  red "UNEXPECTED — investigate."
fi

# ------------------------------------------------------------------ DRIFT -> CONVERGE
banner "DRIFT: change memoryMi -> provider UPDATE (PUT), same lease"
$KUBECTL patch xakashworkload/demo-node-app --type=merge \
  -p '{"spec":{"services":[{"name":"app","image":"ghcr.io/cogni-dao/node-app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","cpuUnits":0.5,"memoryMi":1024,"storageMi":1024,"port":3000,"visibility":"public"}]}}'
echo "patched memoryMi 512 -> 1024; waiting for converge..."; sleep 20
$KUBECTL wait xakashworkload/demo-node-app --for=condition=Ready --timeout=120s
LEASE_DRIFT="$(mr_lease)"
step "mock view of the lease (memoryMi should be 1024, same leaseId)"
mock_curl "/api/v1/compute/deployments/${LEASE_DRIFT}"; echo
echo "leaseId after drift = $LEASE_DRIFT (create leaseId was $LEASE_BEFORE)"
mock_curl /debug/state; echo

# ------------------------------------------------------------------ DELETE -> RELEASE
banner "DELETE XR -> lease RELEASED"
$KUBECTL delete xakashworkload/demo-node-app
echo "waiting for finalizer-driven release..."; sleep 15
step "mock state after release (activeLeaseIds empty, deleteCount=1)"
mock_curl /debug/state; echo
step "balance recovered (escrow returned)"
mock_curl /api/v1/compute/balances; echo

# ------------------------------------------------------------------ teardown
banner "DONE"
if [ "${KEEP_CLUSTER:-0}" = "1" ]; then
  echo "KEEP_CLUSTER set — leaving kind cluster '$CLUSTER' running."
else
  echo "Deleting kind cluster '$CLUSTER' (set KEEP_CLUSTER=1 to keep it)."
  kind delete cluster --name "$CLUSTER"
fi
