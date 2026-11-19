// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/lease-metrics`
 * Purpose: Wiring for the lease metrics routes (bug.5641): serving lanes from the release store as SD targets, and
 *   one lane's `/api/metrics` relayed over its public host with the derived per-lane bearer.
 *   Routes may not import adapters, so the wiring lives here.
 * Scope: Wiring only. Derivation, target shape and relay classification live in `@features/node-deploy/lease-metrics`.
 * Side-effects: IO when the returned functions run (Postgres read, outbound HTTPS)
 * Links: features/node-deploy/lease-metrics.ts, adapters/server/node-deploy/delivery-kpi-source.adapter.ts, bug.5641
 * @internal
 */

import { DeliveryKpiSource } from "@/adapters/server";
import { resolveServiceDb } from "@/bootstrap/container";
import {
  classifyLeaseFetch,
  deriveLeaseMetricsToken,
  type HttpSdTargetGroup,
  LEASE_METRICS_PATH,
  LEASE_SCRAPE_MAX_BYTES,
  LEASE_SCRAPE_TIMEOUT_MS,
  type LeaseLaneKey,
  type LeaseRelayOutcome,
  leaseScrapeTargets,
  MAX_LEASE_LANES,
} from "@/features/node-deploy/lease-metrics";

/** Most lanes one node has in one env (the workload bound). */
const MAX_LANES_PER_NODE_ENV = 16;

const source = (): DeliveryKpiSource =>
  new DeliveryKpiSource(resolveServiceDb().$client);

/** Every serving lane as an HTTP SD target group. `truncated` = the lane read hit its bound. */
export async function listLeaseScrapeTargets(signal: AbortSignal): Promise<{
  readonly groups: HttpSdTargetGroup[];
  readonly truncated: boolean;
}> {
  const read = await source().servingLanes({
    scope: {},
    maxRows: MAX_LEASE_LANES,
    signal,
    nodeAppsOnly: true,
  });
  return { groups: leaseScrapeTargets(read.lanes), truncated: read.truncated };
}

/** Relay one serving lane's exposition. `not_serving` = no running lane has this key. */
export async function relayLeaseMetrics(
  root: string,
  key: LeaseLaneKey,
  signal: AbortSignal
): Promise<LeaseRelayOutcome | { readonly ok: false; reason: "not_serving" }> {
  const src = source();
  const read = await src.servingLanes({
    scope: { nodeId: key.nodeId, env: key.env },
    maxRows: MAX_LANES_PER_NODE_ENV,
    signal,
    nodeAppsOnly: true,
  });
  const lane = read.lanes.find((l) => l.workload === key.workload);
  if (!lane) return { ok: false, reason: "not_serving" };
  const result = await src.probe({
    host: lane.host,
    path: LEASE_METRICS_PATH,
    timeoutMs: LEASE_SCRAPE_TIMEOUT_MS,
    maxBytes: LEASE_SCRAPE_MAX_BYTES,
    signal,
    headers: {
      accept: "text/plain",
      authorization: `Bearer ${deriveLeaseMetricsToken(root, key.nodeId, key.env)}`,
    },
  });
  return classifyLeaseFetch(result);
}
