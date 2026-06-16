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

/** Real-fetch prober that exercises a node's public surface (serving + run-carries). */
export function createNodeProber(): NodeProber {
  return new HttpNodeProber();
}
