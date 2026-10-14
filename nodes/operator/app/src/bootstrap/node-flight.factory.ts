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
import { serverEnv } from "@/shared/env/server-env";

export function parseFlightProbeCredentials(
  raw: string | undefined
): Readonly<Record<string, string>> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] =>
          entry[0].length > 0 &&
          typeof entry[1] === "string" &&
          entry[1].startsWith("cogni_ag_sk_v2_")
      )
    );
  } catch {
    return {};
  }
}

/**
 * Real-fetch prober for the liveness gate — exercises a node's PUBLIC surface only (serving +
 * run-carries). The operator holds NO Grafana token; observability querying is a dev-direct RBAC
 * concern (docs/spec/grafana-observability-access.md), not an operator-API proxy.
 */
export function createNodeProber(): NodeProber {
  const credentials = parseFlightProbeCredentials(
    serverEnv().FLIGHT_PROBE_CREDENTIALS_JSON
  );
  return new HttpNodeProber((host) => credentials[host] ?? null);
}
