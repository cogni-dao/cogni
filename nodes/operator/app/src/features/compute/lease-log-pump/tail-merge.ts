// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/compute/lease-log-pump/tail-merge`
 * Purpose: Pure tail-window reconciliation for poll-based log reading (bug.5240). The Akash
 *   provider lease-logs endpoint carries no timestamps and no cursor — each poll returns the
 *   CURRENT last-N window of a container's stdout. Turning consecutive windows into an
 *   append-only stream is exactly the classic tail-merge problem: locate where what we
 *   already shipped ENDS inside the new window; everything after that point is new.
 * Scope: Pure functions only. No IO, no clock, no labels — the pump owns those.
 * Invariants:
 *   - AT_LEAST_ONCE_NEVER_INVENTED: when no overlap exists (more lines were written between
 *     polls than the window holds, or the container restarted) the WHOLE window is treated as
 *     new. Duplicates are acceptable for diagnosis; silently dropped lines are not.
 *   - BOUNDED_MEMORY: the retained tail is capped at `maxTail` lines per stream; the merge
 *     never grows state proportional to log volume.
 *   - TAIL_MAY_END_MID_WINDOW: the retained tail can be SHORTER than the polled window
 *     (maxTail 200 < tail 500 by default), so the shipped tail ends somewhere inside the
 *     window, not only at its head. Matching only window-prefix overlaps re-shipped the whole
 *     window every poll once a stream passed `maxTail` lines (bug.5516).
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
 * The window is a contiguous slice of the stream and the tail is the contiguous slice that
 * ends at the last shipped line, so the answer is the window index `end` where the shipped
 * prefix of the window stops. A candidate `end` is valid when the `min(end, tail)` window
 * lines just before it equal the same-length suffix of the tail. The longest such match wins
 * (more matched lines = stronger evidence); among equally long matches — only possible for a
 * full-tail match, e.g. a window of repeated identical lines — the EARLIEST end wins, which
 * re-ships rather than drops (AT_LEAST_ONCE_NEVER_INVENTED).
 */
export function mergeTail(
  prevTail: readonly string[],
  window: readonly string[],
  maxTail: number
): TailMergeResult {
  let shippedEnd = 0;
  let bestMatch = 0;
  for (let end = 1; end <= window.length; end++) {
    const length = Math.min(end, prevTail.length);
    if (length <= bestMatch) continue;
    let matches = true;
    for (let i = 1; i <= length; i++) {
      if (window[end - i] !== prevTail[prevTail.length - i]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      shippedEnd = end;
      bestMatch = length;
      if (length === prevTail.length) break; // full-tail anchor: earliest end wins
    }
  }
  const newLines = window.slice(shippedEnd);
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
