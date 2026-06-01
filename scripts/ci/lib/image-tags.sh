#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# scripts/ci/lib/image-tags.sh — thin catalog-reader shim.
#
# CATALOG_IS_SSOT (docs/spec/ci-cd.md axiom 16): infra/catalog/*.yaml is the
# single declaration site. This file populates ALL_TARGETS / NODE_TARGETS and
# resolves tag_suffix_for_target by reading catalog at source time.
#
# Intentionally no `set -euo pipefail` — meant to be sourced; caller owns
# error handling.

# shellcheck disable=SC2034
IMAGE_NAME_APP=${IMAGE_NAME_APP:-ghcr.io/cogni-dao/cogni-template}

if ! command -v yq >/dev/null 2>&1; then
  echo "[ERROR] image-tags: yq is required (CATALOG_IS_SSOT). Install: bash scripts/bootstrap/install/install-yq.sh" >&2
  return 1 2>/dev/null || exit 1
fi

_image_tags_lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_image_tags_repo_root="$(cd "${_image_tags_lib_dir}/../../.." && pwd)"
_image_tags_catalog_root="${COGNI_CATALOG_ROOT:-${_image_tags_repo_root}/infra/catalog}"

# shellcheck disable=SC2034
mapfile -t ALL_TARGETS  < <(yq -N '.name' "$_image_tags_catalog_root"/*.yaml)
# shellcheck disable=SC2034
mapfile -t NODE_TARGETS < <(yq -N 'select(.type == "node") | .name' "$_image_tags_catalog_root"/*.yaml)

declare -A _image_tags_suffix_cache=()
declare -A _image_tags_primary_cache=()
declare -A _image_tags_node_port_cache=()
for _t in "${ALL_TARGETS[@]}"; do
  _s=$(yq '.image_tag_suffix' "${_image_tags_catalog_root}/${_t}.yaml")
  [ "$_s" = "null" ] && _s=""
  _image_tags_suffix_cache["$_t"]="$_s"
  _p=$(yq -N '.is_primary_host // false' "${_image_tags_catalog_root}/${_t}.yaml")
  _image_tags_primary_cache["$_t"]="$_p"
  _np=$(yq -N '.node_port // ""' "${_image_tags_catalog_root}/${_t}.yaml")
  _image_tags_node_port_cache["$_t"]="$_np"
done
unset _t _s _p _np

image_name_for_target() {
  printf '%s' "$IMAGE_NAME_APP"
}

tag_suffix_for_target() {
  local target="$1"
  if [ -z "${_image_tags_suffix_cache[$target]+x}" ]; then
    echo "[ERROR] image-tags: unknown target: $target" >&2
    return 1
  fi
  printf '%s' "${_image_tags_suffix_cache[$target]}"
}

image_tag_for_target() {
  local image_name="$1" base_tag="$2" target="$3" suffix
  suffix=$(tag_suffix_for_target "$target") || return 1
  printf '%s:%s%s' "$image_name" "$base_tag" "$suffix"
}

# Resolve the public host for a node, given a base DOMAIN. Catalog drives
# which entry is the bare-domain primary via `is_primary_host: true`
# (defaults false). For non-primary nodes: when DOMAIN has 3+ parts (an
# env-prefixed deep subdomain like `test.cognidao.org`), join with `-` so
# `resy + test.cognidao.org` → `resy-test.cognidao.org`; for shorter domains
# (TLD-style forks) join with `.` so `resy + example.org` → `resy.example.org`.
# Returns the bare host (no scheme).
host_for_node() {
  local node="$1" domain="$2" primary
  primary="${_image_tags_primary_cache[$node]:-false}"
  if [ "$primary" = "true" ]; then
    printf '%s' "$domain"
  elif [[ "$domain" == *.*.* ]]; then
    printf '%s-%s' "$node" "$domain"
  else
    printf '%s.%s' "$node" "$domain"
  fi
}

# Resolve the k3s Service NodePort for a node from the catalog (task.5078).
# The edge Caddy reverse-proxies to host.docker.internal:<node_port>. Errors
# loud on an unknown target or a type:node missing node_port — never silently
# emits an empty upstream (which would make Caddy round-robin / 502).
is_primary_host() {
  [ "${_image_tags_primary_cache[$1]:-false}" = "true" ]
}

node_port_for_target() {
  local node="$1" port
  port="${_image_tags_node_port_cache[$node]:-}"
  if [ -z "$port" ]; then
    echo "[ERROR] image-tags: node_port missing for '$node' (CATALOG_IS_SSOT: add node_port to infra/catalog/${node}.yaml)" >&2
    return 1
  fi
  printf '%s' "$port"
}

node_database_for_target() {
  local node="$1"
  if [ -z "${_image_tags_primary_cache[$node]+x}" ]; then
    echo "[ERROR] image-tags: unknown target: $node" >&2
    return 1
  fi
  printf 'cogni_%s' "${node//-/_}"
}

node_database_csv() {
  local sep="" node
  for node in "${NODE_TARGETS[@]}"; do
    printf '%s%s' "$sep" "$(node_database_for_target "$node")"
    sep=","
  done
}
