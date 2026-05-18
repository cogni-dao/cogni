#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# shellcheck source=../lib/cogni-deployment-identity.sh
source "$REPO_ROOT/scripts/setup/lib/cogni-deployment-identity.sh"

assert_eq() {
  local want="$1" got="$2" label="$3"
  if [[ "$want" != "$got" ]]; then
    echo "FAIL ${label}: want '${want}', got '${got}'" >&2
    exit 1
  fi
}

root="$(cogni_domain_root)"
slug="$(cogni_deployment_slug)"

assert_eq "cognidao.org" "$root" "default root"
assert_eq "cogni" "$slug" "default slug"
assert_eq "test.cognidao.org" "$(cogni_operator_domain_for_env candidate-a "$root")" "candidate-a operator domain"
assert_eq "resy-test.cognidao.org" "$(cogni_resy_domain_for_env candidate-a "$root")" "candidate-a resy domain"
assert_eq "cogni-candidate-a.vm.cognidao.org" "$(cogni_vm_host_for_env candidate-a "$root" "$slug")" "candidate-a vm alias"
assert_eq "preview.cognidao.org" "$(cogni_operator_domain_for_env preview "$root")" "preview operator domain"
assert_eq "resy-preview.cognidao.org" "$(cogni_resy_domain_for_env preview "$root")" "preview resy domain"
assert_eq "cogni-preview.vm.cognidao.org" "$(cogni_vm_host_for_env preview "$root" "$slug")" "preview vm alias"
assert_eq "cognidao.org" "$(cogni_operator_domain_for_env production "$root")" "production operator domain"
assert_eq "resy.cognidao.org" "$(cogni_resy_domain_for_env production "$root")" "production resy domain"
assert_eq "cogni.vm.cognidao.org" "$(cogni_vm_host_for_env production "$root" "$slug")" "production vm alias"

echo "cogni-deployment-identity tests passed"
