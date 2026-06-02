// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/__arch_probes__/fail_service_db_import`
 * Purpose: Architecture probe proving both service-db rules fire.
 * Scope: Tests that arbitrary src/ code cannot reach BYPASSRLS via either layer. Does not test production behavior.
 * Invariants:
 * - Must trigger no-service-db-package-import (direct package import)
 * - Must trigger no-service-db-adapter-import (adapter singleton import)
 * Side-effects: none
 * Links: .dependency-cruiser.cjs, docs/spec/database-rls.md
 * @internal
 */

// @ts-expect-error - intentional violation: package-level gate
import { createServiceDbClient } from "@cogni/db-client/service";

// @ts-expect-error - intentional violation: adapter-level gate
import { getServiceDb } from "@/adapters/server/db/drizzle.service-client";

export const probePackage = createServiceDbClient;
export const probeAdapter = getServiceDb;
