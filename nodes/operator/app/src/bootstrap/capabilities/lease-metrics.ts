// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/lease-metrics`
 * Purpose: Factory for the lease metrics collector (bug.5641): the operator's serving lanes from the release
 *   store, scraped over their public host with a derived per-lane bearer, merged into one exposition.
 *   Routes may not import adapters, so the wiring lives here.
 * Scope: Wiring only. Derivation, merge and fan-out live in `@features/node-deploy/lease-metrics`.
 * Side-effects: IO when the returned function runs (Postgres read, outbound HTTPS)
 * Links: features/node-deploy/lease-metrics.ts, adapters/server/node-deploy/delivery-kpi-source.adapter.ts, bug.5641
 * @internal
 */

import { DeliveryKpiSource } from "@/adapters/server";
import { resolveServiceDb } from "@/bootstrap/container";
import {
  collectLeaseMetrics,
  LEASE_METRICS_PATH,
  LEASE_SCRAPE_MAX_BYTES,
  LEASE_SCRAPE_TIMEOUT_MS,
  type LeaseMetricsReport,
  MAX_LEASE_LANES,
} from "@/features/node-deploy/lease-metrics";

/** `root` is the operator's own `METRICS_TOKEN`. The returned function never throws for a lane failure. */
export function createLeaseMetricsCollector(
  root: string
): (signal: AbortSignal) => Promise<LeaseMetricsReport> {
  const source = new DeliveryKpiSource(resolveServiceDb().$client);
  return async (signal) => {
    const read = await source.servingLanes({
      scope: {},
      maxRows: MAX_LEASE_LANES,
      signal,
    });
    return collectLeaseMetrics(
      { root, lanes: read.lanes, truncated: read.truncated, signal },
      {
        fetchLane: (lane, token, laneSignal) =>
          source.probe({
            host: lane.host,
            path: LEASE_METRICS_PATH,
            timeoutMs: LEASE_SCRAPE_TIMEOUT_MS,
            maxBytes: LEASE_SCRAPE_MAX_BYTES,
            signal: laneSignal,
            headers: { authorization: `Bearer ${token}` },
          }),
      }
    );
  };
}
