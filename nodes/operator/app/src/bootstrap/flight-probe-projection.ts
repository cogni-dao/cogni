// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Composition root for the control-only flight-prober credential projection.
 * The delivery layer sees a narrow capability and never imports infrastructure.
 */

import { OpenBaoFlightProbeProjectionAdapter } from "@/adapters/server";
import { NETWORK_NODES } from "@/adapters/server/node-registry/network-nodes.data";
import { serverEnv } from "@/shared/env";

export interface FlightProbeProjectionCapability {
  readonly isControl: () => boolean;
  readonly isCatalogNode: (nodeId: string) => boolean;
  readonly readRing: OpenBaoFlightProbeProjectionAdapter["readRing"];
}

export function createFlightProbeProjectionCapability(): FlightProbeProjectionCapability {
  const env = serverEnv();
  const adapter = new OpenBaoFlightProbeProjectionAdapter({
    addr: env.OPENBAO_ADDR,
  });
  return {
    isControl: () =>
      env.DEPLOY_ENVIRONMENT === (env.FLEET_CONTROL_ENV ?? "production"),
    isCatalogNode: (nodeId) =>
      NETWORK_NODES.some((node) => node.nodeId === nodeId),
    readRing: (input) => adapter.readRing(input),
  };
}
