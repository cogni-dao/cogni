#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Cogni deployment identity helpers for setup/provision scripts. This file is
# sourced; callers own shell options.

cogni_domain_root() {
  printf '%s' "${COGNI_DOMAIN_ROOT:-cognidao.org}"
}

cogni_deployment_slug() {
  printf '%s' "${COGNI_DEPLOYMENT_SLUG:-cogni}"
}

cogni_operator_domain_for_env() {
  local deploy_env="$1" root="$2"
  case "$deploy_env" in
    production)  printf '%s' "$root" ;;
    preview)     printf 'preview.%s' "$root" ;;
    candidate-a) printf 'test.%s' "$root" ;;
    candidate-*) printf '%s.%s' "$deploy_env" "$root" ;;
    *)           return 1 ;;
  esac
}

cogni_resy_domain_for_env() {
  local deploy_env="$1" root="$2"
  case "$deploy_env" in
    production)  printf 'resy.%s' "$root" ;;
    preview)     printf 'resy-preview.%s' "$root" ;;
    candidate-a) printf 'resy-test.%s' "$root" ;;
    candidate-*) printf 'resy-%s.%s' "$deploy_env" "$root" ;;
    *)           return 1 ;;
  esac
}

cogni_vm_host_for_env() {
  local deploy_env="$1" root="$2" slug="$3"
  case "$deploy_env" in
    production) printf '%s.vm.%s' "$slug" "$root" ;;
    *)          printf '%s-%s.vm.%s' "$slug" "$deploy_env" "$root" ;;
  esac
}
