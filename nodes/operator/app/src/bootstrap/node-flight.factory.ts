// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/node-flight.factory`
 * Purpose: Composition seam for the substrate-verification-gate prober. Routes call this factory
 *   (app → bootstrap) so the app layer never imports adapters directly (no-restricted-imports).
 * Scope: Wiring only — constructs the NodeProber adapter. No business logic.
 * Side-effects: none
 * Links: src/features/nodes/flight-status.ts, src/adapters/server/node-flight/node-prober.adapter.ts, task.5021
 * @public
 */

import { HttpNodeProber } from "@/adapters/server";
import type { NodeProber } from "@/ports";

/**
 * Real-fetch prober for the liveness gate — exercises a node's PUBLIC surface only (serving +
 * run-carries). The operator holds NO Grafana token; observability querying is a dev-direct RBAC
 * concern (docs/spec/grafana-observability-access.md), not an operator-API proxy.
 */
export function createNodeProber(): NodeProber {
  return new HttpNodeProber();
}
