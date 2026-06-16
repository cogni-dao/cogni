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
import { serverEnv } from "@/shared/env";

/** Hosted-Loki datasource UID (mirrors scripts/loki-query.sh default). */
const LOKI_DATASOURCE_UID = "grafanacloud-logs";

/**
 * Real-fetch prober for the verification gate (serving + run-carries + Loki rungs). The operator's
 * read-only Grafana Viewer token (cogni/<env>/_shared, Phase 5e) lights up the Loki rungs; when it is
 * unwired those rungs report "loki-unwired" (a loud fail in assertLive), never a silent pass.
 */
export function createNodeProber(): NodeProber {
  const env = serverEnv();
  const loki =
    env.GRAFANA_URL && env.GRAFANA_SERVICE_ACCOUNT_TOKEN
      ? {
          url: env.GRAFANA_URL,
          token: env.GRAFANA_SERVICE_ACCOUNT_TOKEN,
          datasourceUid: LOKI_DATASOURCE_UID,
        }
      : undefined;
  return new HttpNodeProber(loki);
}
