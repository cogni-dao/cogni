// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import {
  NETWORK_NODES,
  OpenBaoAuthorizationFacadeProjectionAdapter,
} from "@/adapters/server";
import { serverEnv } from "@/shared/env";

export function createAuthorizationFacadeProjectionCapability() {
  const env = serverEnv();
  const adapter = new OpenBaoAuthorizationFacadeProjectionAdapter({
    addr: env.OPENBAO_ADDR,
  });
  return {
    isControl: () =>
      env.DEPLOY_ENVIRONMENT === (env.FLEET_CONTROL_ENV ?? "production"),
    isCatalogNode: (nodeId: string) =>
      NETWORK_NODES.some((node) => node.nodeId === nodeId),
    readRing: adapter.readRing.bind(adapter),
  };
}
