#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

# Resolve the repository that owns a candidate-a cell's watched deploy branch.
# k3s candidate cells run in the manifest-declared test parent; external-compute
# cells retain the workflow repository because their control plane is fleet-owned.

set -euo pipefail

provider="${DEPLOYMENT_PROVIDER:?DEPLOYMENT_PROVIDER is required}"
current_repository="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
server_url="${GITHUB_SERVER_URL:-https://github.com}"
manifest="${SYNC_MANIFEST_PATH:-.cogni/sync-manifest.yaml}"
output="${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"

repository="$current_repository"
app_id=""
app_slug=""

if [[ "$provider" == "k3s" ]]; then
  [[ -f "$manifest" ]] || {
    echo "::error::candidate deploy-repository manifest missing: $manifest"
    exit 1
  }

  count="$(yq -N '[.artifacts[] | select(.role == "test-parent")] | length' "$manifest")"
  if [[ "$count" != "1" ]]; then
    echo "::error::candidate k3s deploy repository requires exactly one role:test-parent artifact; found $count"
    exit 1
  fi

  repository="$(yq -N '.artifacts[] | select(.role == "test-parent") | .repo' "$manifest")"
  app_id="$(yq -N '.artifacts[] | select(.role == "test-parent") | .github_app.id // ""' "$manifest")"
  app_slug="$(yq -N '.artifacts[] | select(.role == "test-parent") | .github_app.slug // ""' "$manifest")"
  if [[ -z "$repository" || -z "$app_id" || -z "$app_slug" ]]; then
    echo "::error::role:test-parent must declare repo plus github_app.id and github_app.slug"
    exit 1
  fi
fi

IFS=/ read -r owner repo extra <<<"$repository"
if [[ -z "$owner" || -z "$repo" || -n "${extra:-}" ]]; then
  echo "::error::candidate deploy repository must be owner/repo, got '$repository'"
  exit 1
fi

requires_app_token=false
if [[ "${repository,,}" != "${current_repository,,}" ]]; then
  requires_app_token=true
fi

{
  echo "repository=$repository"
  echo "url=${server_url}/${repository}.git"
  echo "owner=$owner"
  echo "repo=$repo"
  echo "app_id=$app_id"
  echo "app_slug=$app_slug"
  echo "requires_app_token=$requires_app_token"
} >>"$output"

echo "Candidate deploy repository: provider=$provider repository=$repository cross_repo=$requires_app_token"
