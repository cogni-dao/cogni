// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/drizzle-compute-cost-store.int`
 * Purpose: Run the compute-cost store port contract against real PostgreSQL.
 * Scope: Schema constraints, app-role writes, idempotency, monotonic observations, and reports.
 * Invariants: DATABASE_URL_APP_ROLE_ONLY, NEVER_MOCK_THE_DATABASE.
 * Side-effects: IO (ephemeral testcontainers PostgreSQL).
 * Links: src/adapters/server/compute/compute-cost-store.ts
 * @public
 */

import { DrizzleComputeCostStore } from "@/adapters/server/compute/compute-cost-store";
import { getAppDb } from "@/adapters/server/db/client";
import { registerComputeCostStoreContract } from "../../ports/harness/compute-cost-store.port.harness";

registerComputeCostStoreContract(async () => {
  // Intentionally app-role: the controller must not receive DATABASE_SERVICE_URL/BYPASSRLS.
  return new DrizzleComputeCostStore(getAppDb());
});
