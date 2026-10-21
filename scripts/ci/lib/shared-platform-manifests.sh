#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO

# Reapply platform-owned settings after copying a reviewed app's manifests.
# This edits only the local deploy checkout, before its atomic GitOps commit.
reconcile_shared_platform_manifests() {
  local platform_root="$1" deploy_root="$2" environment="$3" node="$4"
  local relative="infra/k8s/overlays/${environment}/${node}"
  local platform_overlay="${platform_root}/${relative}/kustomization.yaml"
  local deploy_overlay="${deploy_root}/${relative}/kustomization.yaml"
  if [ "$node" = scheduler-worker ]; then
    reconcile_scheduler_platform_manifests "$platform_root" "$deploy_root" "$environment" || return 1
    return 0
  fi
  [ -f "$deploy_overlay" ] || return 0
  if [ ! -f "$platform_overlay" ]; then
    if yq -e '.resources[] | select(test("database-reliability"))' "$deploy_overlay" >/dev/null 2>&1; then
      echo '[ERROR] trusted database observer policy missing' >&2; return 1
    fi
    return 0
  fi

  if yq -e '.resources[] | select(test("database-reliability-actuator"))' "$platform_overlay" >/dev/null 2>&1; then
    mkdir -p "${deploy_root}/infra/k8s/base/database-reliability-actuator"
    rsync -a --delete "${platform_root}/infra/k8s/base/database-reliability-actuator/" \
      "${deploy_root}/infra/k8s/base/database-reliability-actuator/"
    cp "${platform_root}/${relative}/database-reliability-actuator-external-secret.yaml" \
      "${deploy_root}/${relative}/database-reliability-actuator-external-secret.yaml"
    # shellcheck disable=SC2016 # yq variables, not shell interpolation.
    yq eval-all -i '
      select(fileIndex == 0) as $app | select(fileIndex == 1) as $platform |
      $app |
      .resources = ((.resources // [] | map(select(test("database-reliability") | not))) +
        ($platform.resources // [] | map(select(test("database-reliability"))))) |
      .patches = ((.patches // [] | map(select((.target.name // "" | test("^database-reliability-")) | not))) +
        ($platform.patches // [] | map(select(.target.name // "" | test("^database-reliability-")))))
    ' "$deploy_overlay" "$platform_overlay"
  fi
}

# Source this function from the shared manifest refresher. Caller owns the root
# authority and invokes it after copying reviewed application manifests.
reconcile_scheduler_platform_manifests() {
  local platform_root="$1" deploy_root="$2" deploy_env="$3"
  local relative="infra/k8s/overlays/$deploy_env/scheduler-worker"
  local source_overlay="$platform_root/$relative" target_overlay="$deploy_root/$relative"
  local replicas serial="serial-rollout.patch.yaml"
  [ -f "$source_overlay/kustomization.yaml" ] && [ -f "$target_overlay/kustomization.yaml" ] || {
    echo '[ERROR] deployed scheduler overlay missing' >&2; return 1;
  }
  if [ -f "$source_overlay/replicas.patch.yaml" ]; then
    replicas="$(yq -N '.spec.replicas' "$source_overlay/replicas.patch.yaml")" || return 1
  elif yq -e '.patches[] | select(.path == "replicas.patch.yaml")' "$source_overlay/kustomization.yaml" >/dev/null 2>&1; then
    echo '[ERROR] referenced platform replica policy missing' >&2; return 1
  else
    replicas="$(yq -N '.spec.replicas' "$platform_root/infra/k8s/base/scheduler-worker/deployment.yaml")" || return 1
  fi
  [[ "$replicas" =~ ^[0-9]+$ ]] || {
    echo '[ERROR] trusted scheduler replica policy missing or invalid' >&2; return 1;
  }
  # The native transform applies after strategic/inline patches, so an older
  # application's patch or replicas transformer cannot restore an old count.
  SCHEDULER_PLATFORM_REPLICAS="$replicas" yq -i \
    '.replicas = ((.replicas // []) | map(select(.name != "scheduler-worker"))) + [{"name": "scheduler-worker", "count": env(SCHEDULER_PLATFORM_REPLICAS)}]' \
    "$target_overlay/kustomization.yaml" || return 1
  if [ "$deploy_env" = candidate-a ]; then
    [ -f "$source_overlay/$serial" ] || {
      echo '[ERROR] trusted candidate startup policy missing' >&2; return 1;
    }
    # A temporary file also handles same-tree local promotion safely.
    cat "$source_overlay/$serial" > "$target_overlay/$serial.platform.tmp" || return 1
    mv "$target_overlay/$serial.platform.tmp" "$target_overlay/$serial" || return 1
    yq -i '.patches = ((.patches // []) | map(select(.path != "serial-rollout.patch.yaml"))) + [{"path": "serial-rollout.patch.yaml"}]' \
      "$target_overlay/kustomization.yaml" || return 1
  fi
}
