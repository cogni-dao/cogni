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
for _t in "${ALL_TARGETS[@]}"; do
  _s=$(yq '.image_tag_suffix' "${_image_tags_catalog_root}/${_t}.yaml")
  [ "$_s" = "null" ] && _s=""
  _image_tags_suffix_cache["$_t"]="$_s"
done
unset _t _s

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

# bug.5002 — per-env public URL from catalog. Replaces the legacy
# `if node = operator then DOMAIN else ${node}-${DOMAIN}` URL builder
# in verify-{candidate-ready,buildsha,deployment} + smoke-candidate.
# Returns "" if the catalog entry has no public_url for this env
# (service-type targets, e.g. scheduler-worker, or older catalogs);
# callers treat "" as a skip (no Ingress to verify).
public_url_for_target() {
  local env="$1" target="$2" url
  if [ -z "${_image_tags_suffix_cache[$target]+x}" ]; then
    echo "[ERROR] image-tags: unknown target: $target" >&2
    return 1
  fi
  url=$(yq ".public_url.\"${env}\" // \"\"" "${_image_tags_catalog_root}/${target}.yaml")
  [ "$url" = "null" ] && url=""
  printf '%s' "$url"
}
