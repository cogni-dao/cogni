#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO

# Candidate worker rollout is not sufficient: prove the internal /version SHA
# and digest gate succeeds exact and fails closed on a stale digest.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
VERIFY="$REPO_ROOT/scripts/ci/wait-for-in-cluster-services.sh"
TMPROOT="$(mktemp -d -t wait-worker.XXXXXX)"
trap 'rm -rf "$TMPROOT"' EXIT

cat >"$TMPROOT/ssh" <<'SH'
#!/usr/bin/env bash
command="${*: -1}"
case "$command" in
  *"get deploy scheduler-worker"*) printf '1 1 1 1 1 5\n' ;;
  *"get rs -o json"*) printf '1\n' ;;
  *"get pods -l app.kubernetes.io/name=scheduler-worker"*) printf '10.0.0.1\t%s\n' "${FAKE_WORKER_VERSION:?}" ;;
  *) echo "unexpected ssh command: $command" >&2; exit 1 ;;
esac
SH
chmod +x "$TMPROOT/ssh"

SHA="1111111111111111111111111111111111111111"
DIGEST="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

PATH="$TMPROOT:$PATH" \
FAKE_WORKER_VERSION="{\"sha\":\"$SHA\",\"imageDigest\":\"$DIGEST\"}" \
VM_HOST=fake DEPLOY_ENVIRONMENT=candidate-a PROMOTED_APPS=scheduler-worker \
SCHEDULER_EXPECTED_SHA="$SHA" SCHEDULER_EXPECTED_DIGEST="$DIGEST" \
ROLLOUT_TIMEOUT=1 bash "$VERIFY" >/dev/null

if PATH="$TMPROOT:$PATH" \
  FAKE_WORKER_VERSION="{\"sha\":\"$SHA\",\"imageDigest\":\"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\"}" \
  VM_HOST=fake DEPLOY_ENVIRONMENT=candidate-a PROMOTED_APPS=scheduler-worker \
  SCHEDULER_EXPECTED_SHA="$SHA" SCHEDULER_EXPECTED_DIGEST="$DIGEST" \
  ROLLOUT_TIMEOUT=0 bash "$VERIFY" >/dev/null 2>&1; then
  echo "FAIL: stale scheduler-worker /version digest passed" >&2
  exit 1
fi

echo "PASS: scheduler-worker /version identity is exact and fail-closed"
