#!/usr/bin/env bash
# Prove prod operator pod sees the node mint env keys without printing values.
set -euo pipefail

: "${VM_HOST:?VM_HOST required}"
: "${K8S_NS:=cogni-production}"
: "${SSH_KEY_PATH:=$HOME/.ssh/deploy_key}"
: "${PROOF_RESTART:=true}"

ssh -i "$SSH_KEY_PATH" \
  -o StrictHostKeyChecking=yes \
  -o ServerAliveInterval=15 \
  -o ServerAliveCountMax=8 \
  root@"$VM_HOST" "K8S_NS='$K8S_NS' PROOF_RESTART='$PROOF_RESTART' bash -s" <<'REMOTE'
set -euo pipefail

require() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required command: $1" >&2
    exit 1
  }
}
require kubectl
require timeout

test -n "$(kubectl -n "$K8S_NS" get secret operator-node-app-secrets -o jsonpath='{.data.NODE_MINT_OWNER}')"
test -n "$(kubectl -n "$K8S_NS" get secret operator-node-app-secrets -o jsonpath='{.data.NODE_TEMPLATE_OWNER}')"
echo "operator-node-app-secrets has required mint keys (values redacted)"

if [ "$PROOF_RESTART" = "true" ]; then
  kubectl -n "$K8S_NS" rollout restart deployment/operator-node-app
fi

pod=""
deadline="$(($(date -u +%s) + 420))"
while [ "$(date -u +%s)" -lt "$deadline" ]; do
  pod="$(
    timeout 20 kubectl -n "$K8S_NS" get pods \
      -l app.kubernetes.io/name=node-app,app.kubernetes.io/instance=operator \
      --sort-by=.metadata.creationTimestamp \
      -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.deletionTimestamp}{"\t"}{range .status.containerStatuses[?(@.name=="app")]}{.ready}{end}{"\n"}{end}' \
      | awk -F '\t' '$2 == "" && $3 == "true" { pod = $1 } END { print pod }'
  )"
  if [ -n "$pod" ]; then
    break
  fi
  sleep 5
done

if [ -z "$pod" ]; then
  kubectl -n "$K8S_NS" get pods -l app.kubernetes.io/name=node-app,app.kubernetes.io/instance=operator -o wide || true
  echo "no new ready non-terminating operator pod found" >&2
  exit 1
fi

timeout 20 kubectl -n "$K8S_NS" exec "$pod" -c app -- \
  /bin/sh -lc 'test -n "${NODE_MINT_OWNER:-}" && test -n "${NODE_TEMPLATE_OWNER:-}"'
echo "operator runtime has required mint env keys on pod ${pod} (values redacted)"
REMOTE
