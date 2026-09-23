// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/compute/lease-log-pump/tail-merge`
 * Purpose: Pure tail-window reconciliation for poll-based log reading (bug.5240). The Akash
 *   provider lease-logs endpoint carries no timestamps and no cursor — each poll returns the
 *   CURRENT last-N window of a container's stdout. Turning consecutive windows into an
 *   append-only stream is exactly the classic tail-merge problem: find the longest suffix of
 *   what we already shipped that prefixes the new window; everything after it is new.
 * Scope: Pure functions only. No IO, no clock, no labels — the pump owns those.
 * Invariants:
 *   - AT_LEAST_ONCE_NEVER_INVENTED: when no overlap exists (more lines were written between
 *     polls than the window holds, or the container restarted) the WHOLE window is treated as
 *     new. Duplicates are acceptable for diagnosis; silently dropped lines are not.
 *   - BOUNDED_MEMORY: the retained tail is capped at `maxTail` lines per stream; the merge
 *     never grows state proportional to log volume.
 * Side-effects: none
 * Links: ./lease-log-pump, bug.5240, task.5144
 * @internal
 */

export interface TailMergeResult {
  /** Lines not yet shipped, in order. */
  readonly newLines: readonly string[];
  /** Tail window to retain for the next poll. Commit ONLY after a successful push. */
  readonly nextTail: readonly string[];
}

/**
 * Merge a freshly polled window into a previously shipped tail.
 *
 * Overlap is the longest `k` where the last `k` retained lines equal the first `k` window
 * lines. Scanning starts from the largest candidate so a window of repeated identical lines
 * resolves to the most-already-shipped interpretation (fewest duplicates).
 */
export function mergeTail(
  prevTail: readonly string[],
  window: readonly string[],
  maxTail: number
): TailMergeResult {
  const bound = Math.min(prevTail.length, window.length);
  let overlap = 0;
  for (let k = bound; k > 0; k--) {
    let matches = true;
    for (let i = 0; i < k; i++) {
      if (prevTail[prevTail.length - k + i] !== window[i]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      overlap = k;
      break;
    }
  }
  const newLines = window.slice(overlap);
  const combined = [...prevTail, ...newLines];
  return {
    newLines,
    nextTail: combined.slice(Math.max(0, combined.length - maxTail)),
  };
}

/**
 * Map a provider log-entry `name` (pod name, `<service>-<replicaset>-<pod>` on k8s-backed
 * providers) to its SDL service. Longest declared-service prefix wins so `paper-trader-…`
 * never mis-attributes to a hypothetical `paper` service; an unmatched name falls back to
 * itself, which keeps the line shipped (never dropped) and visibly mislabeled rather than
 * silently absent.
 */
export function serviceForLogName(
  name: string,
  services: readonly string[]
): string {
  let best: string | undefined;
  for (const service of services) {
    if (name === service || name.startsWith(`${service}-`)) {
      if (!best || service.length > best.length) best = service;
    }
  }
  return best ?? name;
}
