// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/db-client`
 * Purpose: Safe-surface DB client: app-role factory, adapters, tenant-scope, schema.
 * Scope: App-role factory, adapters, tenant-scope, schema. Does not export createServiceDbClient (BYPASSRLS) — that lives in @cogni/db-client/service.
 * Invariants:
 * - FORBIDDEN: @/shared/env, process.env, Next.js imports
 * - createServiceDbClient is NOT re-exported here (use @cogni/db-client/service)
 * - Re-exports full schema (all domain slices)
 * Side-effects: IO (database operations)
 * Links: docs/spec/packages-architecture.md, docs/spec/database-rls.md
 * @public
 */

// Re-export full schema (consumers get all tables transitively through db-client)
export * from "@cogni/db-schema";
export { DrizzleAttributionAdapter } from "./adapters/drizzle-attribution.adapter";
export { DrizzleClaimantWalletResolver } from "./adapters/drizzle-claimant-wallet-resolver.adapter";
// Branded ID types live in @cogni/ids — import directly, not through this barrel.
export { DrizzleExecutionRequestAdapter } from "./adapters/drizzle-execution-request.adapter";
// Adapters (split by trust boundary: user = appDb/RLS, worker = serviceDb/BYPASSRLS)
export {
  DrizzleExecutionGrantUserAdapter,
  DrizzleExecutionGrantWorkerAdapter,
} from "./adapters/drizzle-grant.adapter";
export { DrizzleGraphRunAdapter } from "./adapters/drizzle-run.adapter";
export {
  DrizzleScheduleUserAdapter,
  DrizzleScheduleWorkerAdapter,
} from "./adapters/drizzle-schedule.adapter";
// Client factories (safe surface only — no createServiceDbClient)
export {
  createAppDbClient,
  type Database,
  type LoggerLike,
} from "./client";
// Tenant-scope helpers (generic over any Drizzle schema)
export { setTenantContext, withTenantScope } from "./tenant-scope";
