#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
# Pure catalog-entry policy shared by rendering and installed-rule assertions.

compute_egress_entry_in_env() {
  local file="$1" index="$2" env="$3" count i value seen=' '
  [[ "$(yq -N ".compute_egress_cidrs[$index] | has(\"envs\")" "$file")" == true ]] || return 0
  [[ "$(yq -N ".compute_egress_cidrs[$index].envs | tag" "$file")" == '!!seq' ]] || return 2
  count="$(yq -N ".compute_egress_cidrs[$index].envs | length" "$file")"
  [[ "$count" -gt 0 ]] || return 2
  i=0
  while [[ "$i" -lt "$count" ]]; do
    value="$(yq -N ".compute_egress_cidrs[$index].envs[$i]" "$file")"
    case "$value" in candidate-a|preview|production) ;; *) return 2 ;; esac
    case "$seen" in *" $value "*) return 2 ;; esac
    seen="${seen}${value} "
    yq -N -e ".envs // [] | contains([\"$value\"])" "$file" >/dev/null 2>&1 || return 2
    i=$((i+1))
  done
  case "$seen" in *" $env "*) return 0 ;; *) return 1 ;; esac
}

compute_egress_entry_ports() {
  local file="$1" index="$2" count i value seen=' ' output=''
  # Stable historical order also canonicalizes explicitly declared equivalent sets.
  local allowed='5432 5435 6379 4000 7233'
  if [[ "$(yq -N ".compute_egress_cidrs[$index] | has(\"ports\")" "$file")" != true ]]; then
    printf '%s' '5432,5435,6379,4000,7233'
    return 0
  fi
  [[ "$(yq -N ".compute_egress_cidrs[$index].ports | tag" "$file")" == '!!seq' ]] || return 2
  count="$(yq -N ".compute_egress_cidrs[$index].ports | length" "$file")"
  [[ "$count" -gt 0 ]] || return 2
  i=0
  while [[ "$i" -lt "$count" ]]; do
    [[ "$(yq -N ".compute_egress_cidrs[$index].ports[$i] | tag" "$file")" == '!!int' ]] || return 2
    value="$(yq -N ".compute_egress_cidrs[$index].ports[$i]" "$file")"
    case "$value" in 5432|5435|6379|4000|7233) ;; *) return 2 ;; esac
    case "$seen" in *" $value "*) return 2 ;; esac
    seen="${seen}${value} "
    i=$((i+1))
  done
  for value in $allowed; do
    case "$seen" in *" $value "*) output="${output:+${output},}${value}" ;; esac
  done
  printf '%s' "$output"
}
