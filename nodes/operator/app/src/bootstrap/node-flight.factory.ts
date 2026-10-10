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

import {
  EnvFlightProbeCredentialResolver,
  HttpNodeProber,
  isFlightProbeControlEnvironment,
} from "@/adapters/server";
import type { NodeProber } from "@/ports";
import { serverEnv } from "@/shared/env";

/**
 * Real-fetch prober for the liveness gate. Serving remains public; run-carries resolves one bounded
 * credential for the exact `{env,nodeId}` target. Only the fleet-control operator may resolve the
 * map (`DEPLOY_ENVIRONMENT === FLEET_CONTROL_ENV`, default production); every other env fails closed.
 */
export function createNodeProber(): NodeProber {
  const env = serverEnv();
  const credentials = new EnvFlightProbeCredentialResolver(
    env.FLIGHT_PROBE_CREDENTIALS_JSON,
    isFlightProbeControlEnvironment({
      deployEnvironment: env.DEPLOY_ENVIRONMENT,
      fleetControlEnvironment: env.FLEET_CONTROL_ENV,
    })
  );
  return new HttpNodeProber(credentials);
}
