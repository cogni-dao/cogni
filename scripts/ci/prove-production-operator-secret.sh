#!/usr/bin/env bash
# Prove prod operator pod sees the node mint env keys without printing values.
set -euo pipefail

: "${VM_HOST:?VM_HOST required}"
: "${K8S_NS:=cogni-production}"
: "${SSH_KEY_PATH:=$HOME/.ssh/deploy_key}"

ssh -i "$SSH_KEY_PATH" \
  -o StrictHostKeyChecking=yes \
  -o ServerAliveInterval=15 \
  -o ServerAliveCountMax=8 \
  root@"$VM_HOST" "K8S_NS='$K8S_NS' bash -s" <<'REMOTE'
set -euo pipefail

require() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required command: $1" >&2
    exit 1
  }
}
require kubectl
require jq
require timeout

kubectl -n "$K8S_NS" get secret operator-node-app-secrets -o json \
  | jq -e '.data.NODE_MINT_OWNER and .data.NODE_TEMPLATE_OWNER' >/dev/null
echo "operator-node-app-secrets has required mint keys (values redacted)"

start_epoch="$(date -u +%s)"
kubectl -n "$K8S_NS" rollout restart deployment/operator-node-app

pod=""
deadline="$((start_epoch + 420))"
while [ "$(date -u +%s)" -lt "$deadline" ]; do
  pod="$(
    timeout 20 kubectl -n "$K8S_NS" get pods \
      -l app.kubernetes.io/name=node-app,app.kubernetes.io/instance=operator \
      -o json \
      | jq -r --argjson start "$start_epoch" '
          .items[]
          | select(.metadata.deletionTimestamp == null)
          | select((.metadata.creationTimestamp | fromdateiso8601) >= $start)
          | select(any(.status.containerStatuses[]?; .name == "app" and .ready == true))
          | .metadata.name
        ' \
      | tail -n 1
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
