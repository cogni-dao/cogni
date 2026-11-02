// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/node-deploy-store`
 * Purpose: Factory for the node-deploy store behind its port, bound to the operator's service-role
 *   Postgres, for the `deploy/workloads` route (task.5400). Routes may not import adapters.
 * Scope: Wiring only. The sequencer process builds its own store from its own DSN.
 * Side-effects: none (the client is lazy)
 * Links: src/ports/node-deploy.port.ts, src/adapters/server/node-deploy/postgres-store.adapter.ts
 * @internal
 */

import { PostgresNodeDeployStore } from "@/adapters/server";
import { resolveServiceDb } from "@/bootstrap/container";
import type { StorePort } from "@/ports";

export function createNodeDeployStore(): StorePort {
  return new PostgresNodeDeployStore(resolveServiceDb());
}
