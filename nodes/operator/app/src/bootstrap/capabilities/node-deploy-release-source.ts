// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/node-deploy-release-source`
 * Purpose: Factory for the read-only delivery release source (the same one the delivery goal KPIs read)
 *   bound to the operator's service-role Postgres, for the `deploy/workloads/lanes` route (task.5479).
 *   Routes may not import adapters.
 * Scope: Wiring only. Only `releases()` is used by the lane view; it never probes or writes.
 * Side-effects: none (the client is lazy)
 * Links: src/ports/delivery-kpi.port.ts, src/adapters/server/node-deploy/delivery-kpi-source.adapter.ts
 * @internal
 */

import { DeliveryKpiSource } from "@/adapters/server";
import { resolveServiceDb } from "@/bootstrap/container";
import type { DeliveryKpiSourcePort } from "@/ports";

export function createDeliveryReleaseSource(): Pick<
  DeliveryKpiSourcePort,
  "releases"
> {
  return new DeliveryKpiSource(resolveServiceDb().$client);
}
