#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Fork identity helpers for setup/provision scripts. This file is sourced;
# callers own shell options.
#
# Fork domain root is read from the FORK_DOMAIN_ROOT env var (GitHub repo
# variable in the GHA path; exported via shell or .env.bootstrap in the
# laptop fallback). Callers use `${FORK_DOMAIN_ROOT:?…}` with their own
# error when they need the value.

fork_identity_slug() {
  local repo_root="$1" origin repo slug

  if [[ -n "${FORK_SLUG:-}" ]]; then
    slug="$FORK_SLUG"
  else
    origin=$(git -C "$repo_root" remote get-url origin 2>/dev/null || echo "")
    repo=$(echo "$origin" | sed -E 's#.*github.com[:/]([^/]+/)?([^/.]+)(\.git)?$#\2#')
    [[ -z "$repo" || "$repo" == "$origin" ]] && repo="node-template"
    slug="$repo"
  fi

  echo "$slug" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//; s/-+/-/g'
}

fork_image_name() {
  # GHCR image namespace this fork pushes to + deploys from:
  # ghcr.io/<owner-lowercased>/cogni-node-template.
  #
  # GHCR package-write is owner-scoped at GitHub's layer — a fork's
  # GITHUB_TOKEN (and any GH App installation token) can only write under its
  # own owner — so the namespace MUST follow the repo owner. Unlike
  # FORK_DOMAIN_ROOT (an external Cloudflare fact), this is fully derivable, so
  # bootstrap computes + sets it rather than asking the human.
  #
  # The image BASENAME stays `cogni-node-template` across forks: it is the
  # image name, not the repo name. A fork repo named `cogni-node-20260528`
  # still publishes ghcr.io/<owner>/cogni-node-template[-<suffix>]. Lowercased
  # because GHCR rejects uppercase reference paths.
  local repo_root="$1" owner origin
  if [[ -n "${FORK_IMAGE_OWNER:-}" ]]; then
    owner="$FORK_IMAGE_OWNER"
  else
    origin=$(git -C "$repo_root" remote get-url origin 2>/dev/null || echo "")
    owner=$(echo "$origin" | sed -E 's#.*github.com[:/]([^/]+)/[^/.]+(\.git)?$#\1#')
    [[ -z "$owner" || "$owner" == "$origin" ]] && owner="cogni-dao"
  fi
  printf 'ghcr.io/%s/cogni-node-template' "$(echo "$owner" | tr '[:upper:]' '[:lower:]')"
}

domain_for_env() {
  local deploy_env="$1" root="$2"
  case "$deploy_env" in
    production)  printf '%s' "$root" ;;
    preview)     printf 'preview.%s' "$root" ;;
    candidate-a) printf 'test.%s' "$root" ;;
    candidate-*) printf '%s.%s' "$deploy_env" "$root" ;;
    *)           return 1 ;;
  esac
}

vm_host_for_env() {
  local deploy_env="$1" root="$2" slug="$3"
  case "$deploy_env" in
    production) printf '%s.vm.%s' "$slug" "$root" ;;
    *)          printf '%s-%s.vm.%s' "$slug" "$deploy_env" "$root" ;;
  esac
}
