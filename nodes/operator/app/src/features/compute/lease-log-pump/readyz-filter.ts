// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/compute/lease-log-pump/readyz-filter`
 * Purpose: Recognize a successful, fast readiness-probe access line so the lease-log pump can
 *   drop it before Loki (task.5344, bug.5527). Lease readyz completions were ~0.34 GB/day of
 *   Loki ingest with no diagnostic value; Alloy already drops the same lines on the VM/k8s
 *   lanes (`drop_readyz_ok`), but Akash leases bypass Alloy.
 * Scope: Pure predicate only. No IO, no labels, no cursor state — the pump owns those.
 * Invariants:
 *   - SAME_PREDICATE_AS_ALLOY: `route == "meta.readyz"` AND `status == 200` AND
 *     `durationMs < 1000`, matching `drop_readyz_ok` in
 *     infra/compose/runtime/configs/alloy-config*.alloy.
 *   - FAIL_SAFE_KEEP: a line drops only when every field is present and matches. Non-200,
 *     slow, field-missing, non-JSON or malformed lines always ship.
 * Side-effects: none
 * Links: ./lease-log-pump, task.5344, bug.5527, knowledge grafana-spend-cut-design
 * @internal
 */

const READYZ_ROUTE = "meta.readyz";
const SLOW_PROBE_MS = 1000;

/** True only for a parseable `meta.readyz` access line with status 200 under 1s. */
export function isReadyzOkLine(line: string): boolean {
  // Cheap gate: most lines never mention the route, so skip JSON.parse for them.
  if (!line.includes(READYZ_ROUTE)) return false;
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return false;
  }
  if (typeof record !== "object" || record === null) return false;
  const { route, status, durationMs } = record as Record<string, unknown>;
  return (
    route === READYZ_ROUTE &&
    status === 200 &&
    typeof durationMs === "number" &&
    durationMs < SLOW_PROBE_MS
  );
}
