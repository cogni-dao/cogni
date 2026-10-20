#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni
#
# Test-owned catalog rows for historical custody and schema fixtures.
# Does not read credentials, contact providers, or change the committed fleet.

write_akash_catalog_fixture() {
  local catalog_dir="$1" slug="$2" tier="${3:-shared}" budget_profile="${4:-shared-default-v1}"
  mkdir -p "$catalog_dir"
  cat > "$catalog_dir/$slug.yaml" <<YAML
name: $slug
type: node
port: 3200
node_port: 32000
dockerfile: nodes/$slug/app/Dockerfile
image_tag_suffix: -$slug
migrator_tag_suffix: -$slug-migrate
source_repo: https://github.com/cogni-test-org/fixture-$slug.git
image_repository: ghcr.io/cogni-test-org/fixture-$slug
source_sha: '1111111111111111111111111111111111111111'
node_id: 4b06359a-a859-4399-888e-a8c7a6696f7e
candidate_a_branch: deploy/candidate-a-$slug
preview_branch: deploy/preview-$slug
production_branch: deploy/production-$slug
envs: [candidate-a, preview, production]
activity_env: production
owner_wallet: '0x0000000000000000000000000000000000000001'
path_prefix: nodes/$slug/
database:
  candidate-a: {tier: $tier, budget_profile: $budget_profile}
  preview: {tier: $tier, budget_profile: $budget_profile}
  production: {tier: $tier, budget_profile: $budget_profile}
deployment_provider: {candidate-a: akash, preview: akash, production: akash}
compute_api: {candidate-a: crossplane, preview: crossplane, production: crossplane}
compute_egress_cidrs: [{cidr: 192.0.2.1/32, comment: test-only provider}]
YAML
}

# Keep committed-catalog enumeration separate; only rollback scenarios use this copy.
write_historical_catalog_fixture() {
  local source_dir="$1" fixture_dir="$2" slug
  mkdir -p "$fixture_dir"
  cp "$source_dir"/*.yaml "$fixture_dir/"
  for slug in poly red toks5; do write_akash_catalog_fixture "$fixture_dir" "$slug"; done
}
