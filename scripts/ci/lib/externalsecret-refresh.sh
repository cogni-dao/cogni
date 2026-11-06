#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
#
# bug.5566 — prove an ExternalSecret was refreshed AFTER a force-sync marker.
#
# The old proof ("status.refreshTime != the value read before the annotate") failed
# whenever ESO's resync for a spec change and the force-sync landed in the SAME
# whole second: refreshTime has one-second resolution and the interval is 1h, so
# nothing else ever advanced it. The robust proof is monotonic instead:
#   refreshTime (epoch seconds) >= marker (epoch seconds, floored), then Ready=True.
# The marker is taken BEFORE the annotate, so any refresh caused by the annotate has
# a refreshTime >= marker; a stale refresh from an earlier second is still rejected.
#
# Usage: source this lib (locally, or ship `declare -f` of it to the remote shell), then
#   cogni_wait_externalsecret_refreshed <namespace> <name> <marker-epoch> [attempts] [interval-seconds]
# Exit 0 = refreshed at/after marker and Ready; 1 = never advanced within the bound.
cogni_wait_externalsecret_refreshed() {
  local ns="$1" es="$2" marker="$3" attempts="${4:-60}" interval="${5:-2}"
  local after="" epoch="" i
  for ((i = 0; i < attempts; i++)); do
    after="$(kubectl -n "$ns" get externalsecret "$es" -o jsonpath='{.status.refreshTime}' 2>/dev/null || true)"
    if [[ -n "$after" ]]; then
      # GNU date on the VM; BSD fallback keeps the hermetic test runnable on macOS.
      epoch="$(date -u -d "$after" +%s 2>/dev/null \
        || date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$after" +%s 2>/dev/null || true)"
      if [[ -n "$epoch" && "$epoch" -ge "$marker" ]]; then
        kubectl -n "$ns" wait --for=condition=Ready "externalsecret/$es" --timeout=120s >/dev/null
        return $?
      fi
    fi
    sleep "$interval"
  done
  echo "ExternalSecret refresh did not advance: $es (refreshTime=${after:-unset} marker=$marker)" >&2
  return 1
}
