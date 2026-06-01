#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# scripts/ci/lib/image-tags.sh — thin catalog-reader shim.
#
# CATALOG_IS_SSOT (docs/spec/ci-cd.md axiom 16): infra/catalog/*.yaml is the
# single declaration site for deploy-shape (ports, tag suffixes, branches,
# path_prefix). This file populates ALL_TARGETS / NODE_TARGETS and resolves
# them by reading catalog at source time.
#
# REPO_SPEC_IS_IDENTITY_SSOT: node identity (node_id) is NOT declared in the
# catalog — it is sourced from each node's nodes/<name>/.cogni/repo-spec.yaml,
# the in-repo projection of the on-chain DAO and the sole identity authority
# (ROADMAP "Repo-Spec Authority"). Deploy-shape and identity stay disjoint.
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
# Root of the source tree holding nodes/<name>/.cogni/repo-spec.yaml. Derived
# from the catalog root (catalog lives at <tree>/infra/catalog) so the pre-merge
# birth flow — which points COGNI_CATALOG_ROOT at the PR checkout
# (app-src/infra/catalog) — reads the PR's repo-specs, not the workflow tree.
_image_tags_spec_root="$(cd "${_image_tags_catalog_root}/../.." 2>/dev/null && pwd || echo "${_image_tags_repo_root}")"

# shellcheck disable=SC2034
mapfile -t ALL_TARGETS  < <(yq -N '.name' "$_image_tags_catalog_root"/*.yaml)
# shellcheck disable=SC2034
mapfile -t NODE_TARGETS < <(yq -N 'select(.type == "node") | .name' "$_image_tags_catalog_root"/*.yaml)

declare -A _image_tags_suffix_cache=()
declare -A _image_tags_primary_cache=()
declare -A _image_tags_node_port_cache=()
declare -A _image_tags_node_id_cache=()
declare -A _image_tags_type_cache=()
for _t in "${ALL_TARGETS[@]}"; do
  _ty=$(yq -N '.type' "${_image_tags_catalog_root}/${_t}.yaml")
  _image_tags_type_cache["$_t"]="$_ty"
  _s=$(yq '.image_tag_suffix' "${_image_tags_catalog_root}/${_t}.yaml")
  [ "$_s" = "null" ] && _s=""
  _image_tags_suffix_cache["$_t"]="$_s"
  _p=$(yq -N '.is_primary_host // false' "${_image_tags_catalog_root}/${_t}.yaml")
  _image_tags_primary_cache["$_t"]="$_p"
  _np=$(yq -N '.node_port // ""' "${_image_tags_catalog_root}/${_t}.yaml")
  _image_tags_node_port_cache["$_t"]="$_np"
  # node_id from repo-spec (REPO_SPEC_IS_IDENTITY_SSOT), located via the
  # catalog path_prefix. Services (no path_prefix / no repo-spec) → empty.
  _pp=$(yq -N '.path_prefix // ""' "${_image_tags_catalog_root}/${_t}.yaml")
  _rs="${_image_tags_spec_root}/${_pp}.cogni/repo-spec.yaml"
  if [ -n "$_pp" ] && [ -f "$_rs" ]; then
    _nid=$(yq -N '.node_id // ""' "$_rs")
  else
    _nid=""
  fi
  _image_tags_node_id_cache["$_t"]="$_nid"
done
unset _t _ty _s _p _np _pp _rs _nid

# True for type:infra targets — built in CI but deployed via Compose-on-VM,
# not k8s/Argo. Overlay / promotion / gitops-coverage loops skip these.
is_infra_target() {
  [ "${_image_tags_type_cache[$1]:-}" = "infra" ]
}

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

# Content-hash tag for a type:infra target (e.g. litellm). The tag changes only
# when the image's build dir changes, so the affected-only build rebuilds it
# rarely and deploy-infra resolves the identical tag deterministically — no
# manual `docker build` + hand-pin, no per-sha gap. The build dir is the parent
# of the catalog `dockerfile`. AGENTS.md + __pycache__ are excluded so docs /
# bytecode never perturb the image identity. LC_ALL=C sort keeps it stable
# across macOS (dev) and Linux (CI).
infra_content_hash() {
  local target="$1" dockerfile dir base
  dockerfile=$(yq -N '.dockerfile' "${_image_tags_catalog_root}/${target}.yaml")
  dir=$(dirname "$dockerfile")
  # Resolve relative to the catalog's own tree so an override
  # (COGNI_CATALOG_ROOT=app-src/infra/catalog, the #1427 pre-merge birth flow)
  # hashes the PR's files; fall back to the script's repo root.
  base="$(cd "${_image_tags_catalog_root}/../.." 2>/dev/null && pwd || echo "$_image_tags_repo_root")"
  # git ls-files → tracked files only (untracked/gitignored, incl. __pycache__,
  # can't perturb identity); AGENTS.md excluded (docs ≠ image). `read -r` per line
  # keeps it space-safe and portable across BSD (dev) + GNU (CI) — no sort -z.
  ( cd "$base" && \
    git ls-files -- "$dir" \
      | grep -vE '(^|/)AGENTS\.md$' \
      | LC_ALL=C sort \
      | while IFS= read -r _f; do cat "$_f"; done \
      | shasum -a 256 | cut -c1-12 )
}

# Full GHCR tag for a type:infra image: <image>:<target>-<contenthash>
# (e.g. ghcr.io/cogni-dao/cogni-template:litellm-<hash>). Single source of
# truth for both the CI build (build-and-push) and the deploy (deploy-infra).
infra_image_tag() {
  local target="$1"
  printf '%s:%s-%s' "$IMAGE_NAME_APP" "$target" "$(infra_content_hash "$target")"
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

node_id_for_target() {
  local node="$1" node_id
  node_id="${_image_tags_node_id_cache[$node]:-}"
  if [ -z "$node_id" ]; then
    echo "[ERROR] image-tags: node_id missing for '$node' (REPO_SPEC_IS_IDENTITY_SSOT: set node_id in nodes/${node}/.cogni/repo-spec.yaml)" >&2
    return 1
  fi
  printf '%s' "$node_id"
}

# Default node_id for billing-callback attribution — the is_primary_host node
# (operator). Lets COGNI_DEFAULT_NODE_ID be injected from repo-spec so the
# LiteLLM callback carries no hardcoded identity. REPO_SPEC_IS_IDENTITY_SSOT.
default_node_id() {
  local node
  for node in "${NODE_TARGETS[@]}"; do
    if is_primary_host "$node"; then
      node_id_for_target "$node"
      return $?
    fi
  done
  echo "[ERROR] image-tags: no is_primary_host node found for default node_id" >&2
  return 1
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

node_internal_service_endpoint_csv() {
  local sep="" node node_id url
  for node in "${NODE_TARGETS[@]}"; do
    node_id="$(node_id_for_target "$node")" || return 1
    url="http://${node}-node-app:3000"
    printf '%s%s=%s,%s=%s' "$sep" "$node" "$url" "$node_id" "$url"
    sep=","
  done
}

node_billing_endpoint_csv() {
  local host="$1" sep="" node node_id port url
  for node in "${NODE_TARGETS[@]}"; do
    node_id="$(node_id_for_target "$node")" || return 1
    port="$(node_port_for_target "$node")" || return 1
    url="http://${host}:${port}"
    printf '%s%s=%s,%s=%s' "$sep" "$node" "$url" "$node_id" "$url"
    sep=","
  done
}
