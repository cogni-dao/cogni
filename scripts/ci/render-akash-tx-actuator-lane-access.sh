#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
#
# Render namespace-local migration permissions for the Akash actuator that
# custodies this fleet. The control environment is configuration: production in
# the canonical fleet, candidate-a in the isolated test fleet. Never grant a
# ClusterRole; each foreign lane gets only the Job/Pod verbs used by migrations.

set -euo pipefail

control_env="${1:-}"
case "$control_env" in
  candidate-a | preview | production) ;;
  *)
    echo "usage: $0 {candidate-a|preview|production}" >&2
    exit 2
    ;;
esac

for lane in candidate-a preview production; do
  # The actuator's own overlay already grants this Role in its namespace.
  [ "$lane" = "$control_env" ] && continue

  cat <<YAML
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: akash-tx-actuator-lane-migration
  namespace: cogni-${lane}
rules:
  - apiGroups: [batch]
    resources: [jobs]
    verbs: [get, list, create, delete]
  - apiGroups: [""]
    resources: [pods]
    verbs: [list]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: akash-tx-actuator-lane-migration
  namespace: cogni-${lane}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: akash-tx-actuator-lane-migration
subjects:
  - kind: ServiceAccount
    name: operator-akash-tx-actuator
    namespace: cogni-${control_env}
---
YAML
done
