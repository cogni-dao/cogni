#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# scripts/secrets/sync-secret.sh — push a written secret into its consumers NOW,
# and prove it landed. The second half of a rotation; `set-secret.sh` (or the
# operator API) is the first.
#
# Usage: pnpm secrets:sync <env> <service>
#   <env>     candidate-a | preview | production
#   <service> catalog/platform service name (the ExternalSecret label selector)
#
# WHY THIS EXISTS — ROTATION PUSHES, IT DOES NOT POLL.
# "Written to OpenBao" and "the consumer holds it" are two facts with an
# ExternalSecret `refreshInterval` between them. The interval bounds UNPLANNED
# drift; it is the wrong lever for a DELIBERATE rotation, which always has an
# operator or agent in the loop. Shortening it to compensate (the rejected `1m`
# proposal, PR #2217 / reverted #2234) buys latency with a permanent multiple on
# OpenBao read + audit load, against a Shamir 1-of-1 OpenBao that has already
# OOMKilled (bug.5011). Pushing costs nothing at steady state.
# See docs/spec/secrets-management.md "Refresh intervals".
#
# WHY IT IS A SCRIPT AND NOT A CONTROLLER.
# The push needs a Kubernetes identity that may patch ExternalSecrets. The
# operator app must NOT be that identity: it has no ServiceAccount, and granting
# the internet-facing pod k8s write authority is a far larger blast radius than
# the latency it removes. A narrowly-scoped caller (this script, run by the
# deploy lane or an operator with a kubeconfig) is the correct actor. Making it a
# script rather than a hand-typed kubectl is what makes rotation
# reproducible-by-code — the repo's first standard.
#
# WHAT IT DOES NOT DO: restart pods. Stakater Reloader already does that on
# Secret change (secrets-management.md Invariant 11) and is present on the node-app
# and actuator Deployments. Re-implementing it here would fight the substrate.
#
# NEVER PRINTS A SECRET VALUE. Verification compares a truncated SHA-256
# fingerprint of the projected value, never the value itself — the same
# non-reversible identifier the Akash actuator logs (bug.5142), so a pod log and
# this output can be compared directly.
#
# Tests stub kubectl via $SYNC_SECRET_KUBECTL — see scripts/ci/tests/sync-secret.test.sh.

set -euo pipefail

err() { printf '%s\n' "$*" >&2; }
die() { err "$@"; exit 2; }

usage() {
  err "Usage: pnpm secrets:sync <env> <service>"
  err "  env     candidate-a | preview | production"
  err "  service the service whose ExternalSecrets should be pushed now"
  exit 2
}

[[ $# -eq 2 ]] || usage
env_name="$1"; service="$2"

case "$env_name" in
  candidate-a|preview|production) ;;
  *) die "Invalid env: '$env_name'. Must be candidate-a|preview|production." ;;
esac

[[ "$service" =~ ^[a-z][a-z0-9-]*$ ]] \
  || die "Invalid service '$service' (lowercase letters, digits, hyphens; must start with a letter)."

KUBECTL="${SYNC_SECRET_KUBECTL:-kubectl}"
ns="cogni-${env_name}"

# ExternalSecrets for a service are labelled by component; the objects themselves
# carry the overlay's namePrefix, so select by label rather than guessing names.
selector="app.kubernetes.io/component=${service}"

mapfile -t names < <("$KUBECTL" -n "$ns" get externalsecret \
  -l "$selector" -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null || true)

if [[ ${#names[@]} -eq 0 || -z "${names[0]:-}" ]]; then
  die "No ExternalSecret in ${ns} labelled ${selector}. Nothing to push — check the service name and that its overlay is deployed."
fi

stamp="$(date +%s)"
for name in "${names[@]}"; do
  [[ -n "$name" ]] || continue
  "$KUBECTL" -n "$ns" annotate externalsecret "$name" "force-sync=${stamp}" --overwrite >/dev/null
  printf 'pushed %s/%s\n' "$ns" "$name"
done

# PROVE IT LANDED. A write that returns success is not evidence the consumer has
# the value; that gap is the whole reason this script exists. Report a truncated,
# non-reversible fingerprint per projected key so the caller can compare it to the
# consumer's own logs without ever handling the value.
for name in "${names[@]}"; do
  [[ -n "$name" ]] || continue
  target="$("$KUBECTL" -n "$ns" get externalsecret "$name" -o jsonpath='{.spec.target.name}' 2>/dev/null || true)"
  [[ -n "$target" ]] || continue
  mapfile -t keys < <("$KUBECTL" -n "$ns" get secret "$target" \
    -o jsonpath='{range $.data}{""}{end}' 2>/dev/null; \
    "$KUBECTL" -n "$ns" get secret "$target" -o go-template='{{range $k,$v := .data}}{{$k}}{{"\n"}}{{end}}' 2>/dev/null || true)
  for k in "${keys[@]}"; do
    [[ -n "$k" ]] || continue
    fp="$("$KUBECTL" -n "$ns" get secret "$target" -o "jsonpath={.data.${k}}" 2>/dev/null \
      | base64 -d 2>/dev/null | tr -d '\r\n' | shasum -a 256 | cut -c1-12)"
    printf '  %s/%s %s fp=%s\n' "$ns" "$target" "$k" "$fp"
  done
done

printf '\nReloader restarts consumers on Secret change (Invariant 11).\n'
printf 'Compare fp= above to the consumer log line before calling the rotation done.\n'
