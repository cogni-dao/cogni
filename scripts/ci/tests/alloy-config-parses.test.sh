#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
#
# alloy-config-parses.test.sh — every committed Alloy config must PARSE against the
# exact alloy binary the runtime deploys (bug.5293).
#
# WHY THIS EXISTS. On 2026-09-30 a single `#` comment (River uses `//`) made
# alloy-config.metrics.alloy unparseable. One illegal character invalidates the WHOLE
# file, so alloy exited 1 and crash-looped, and candidate-a's ENTIRE metrics pipeline
# went dark for ~20 minutes — cadvisor, node, app and worker scrapes, not just the one
# block being edited. It survived THREE deploys because:
#   - deploy-infra only hashes + restarts the config; it never validates it;
#   - a dead metrics pipeline cannot report its own death, so `up == 1` kept reading
#     "healthy" from the last good scrapes before it stopped (freshness, not value, is
#     the honest check);
#   - alloy's own logs were not shipped, so the only evidence anywhere was a
#     `docker ps` line buried in a workflow log.
# `alloy fmt` catches it in under a second, offline. That is the whole point.
#
# VERSION IS READ FROM COMPOSE, never hardcoded: validating against a different alloy
# than the one deployed is how a validator drifts into uselessness.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
COMPOSE="$REPO_ROOT/infra/compose/runtime/docker-compose.yml"
CONFIG_DIR="$REPO_ROOT/infra/compose/runtime/configs"

fail() { echo "❌ $*" >&2; exit 1; }

[ -f "$COMPOSE" ] || fail "missing $COMPOSE"

# The image the `alloy` service actually runs, e.g. grafana/alloy:v1.9.2.
ALLOY_IMAGE="$(grep -oE 'grafana/alloy:[A-Za-z0-9._-]+' "$COMPOSE" | head -1)"
[ -n "$ALLOY_IMAGE" ] \
  || fail "could not read the alloy image from $COMPOSE — the validator must match the deployed binary"

mapfile -t CONFIGS < <(find "$CONFIG_DIR" -maxdepth 1 -name '*.alloy' | LC_ALL=C sort)
[ "${#CONFIGS[@]}" -gt 0 ] || fail "no *.alloy configs found under $CONFIG_DIR"

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  # LOUD, never silent: a skipped validation must not read as a pass. CI runners have
  # docker; a local dev without it still sees why the gate did not run.
  echo "::warning::alloy-config-parses: docker unavailable — SKIPPED ${#CONFIGS[@]} config(s) against $ALLOY_IMAGE. This gate did NOT run; a River syntax error would reach a deploy unvalidated (bug.5293)."
  echo "SKIP (no docker): alloy-config-parses.test.sh"
  exit 0
fi

echo "validating ${#CONFIGS[@]} alloy config(s) against $ALLOY_IMAGE"
rc=0
for cfg in "${CONFIGS[@]}"; do
  name="$(basename "$cfg")"
  # `fmt` parses without building components, so it needs no DB, no network and none of
  # the host mounts (/host/sys, /var/log/journal) that a full `alloy run` would demand.
  if out="$(docker run --rm -v "$cfg:/w/$name:ro" --entrypoint /bin/alloy "$ALLOY_IMAGE" fmt "/w/$name" 2>&1 >/dev/null)"; then
    echo "  ok    $name"
  else
    rc=1
    echo "  FAIL  $name"
    printf '%s\n' "$out" | sed 's/^/          /' | head -12
  fi
done

[ "$rc" -eq 0 ] || fail "alloy config(s) failed to parse against $ALLOY_IMAGE — alloy would exit 1 and crash-loop, taking the whole metrics pipeline down (bug.5293). River comments are '//', never '#'."

echo "PASS: alloy-config-parses.test.sh"
