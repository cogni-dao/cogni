// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/compute/provider-outcome-store`
 * Purpose: Persistence seam for per-provider workload boot outcomes (task.5051) — the
 *   append-only history behind the derived blacklist and own-history ranking signal.
 * Scope: Record + aggregate reads over compute_provider_outcomes. Does NOT decide
 *   blacklist state (pure logic in ./akash-provider-screen) or call any provider API.
 * Invariants:
 *   - APPEND_ONLY: outcomes are immutable facts; manual blacklist clear = row deletion.
 *   - BEST_EFFORT_AT_CALLSITE: the adapter treats store IO as advisory — a failed write
 *     never fails a live provision, a failed read screens with empty history. The store
 *     itself throws honestly; the caller wraps.
 *   - APP_ROLE_ONLY: uses the RLS-enforced app-role client (table has no user FK, no RLS —
 *     attribution.ts precedent); the BYPASSRLS service client stays depcruiser-gated.
 * Side-effects: IO (Postgres via the lazily-resolved app-role Drizzle client)
 * Links: @cogni/db-schema/compute (table), ./akash-provider-screen (consumer of stats),
 *   knowledge hub `akash-provider-quality-mandate`, task.5051
 * @internal
 */

import type { Database } from "@cogni/db-client";
import { eq, sql } from "drizzle-orm";

import { computeProviderOutcomes } from "@/shared/db/schema";

import type { ProviderOutcomeStats } from "./akash-provider-screen";

/** One boot-attempt outcome to persist. */
export interface ProviderOutcomeRecord {
  /** Compute marketplace label, e.g. "akash". */
  readonly computeProvider: string;
  /** Provider account address on that marketplace (akash1…). */
  readonly providerAccount: string;
  readonly outcome: "boot_ok" | "slo_timeout";
  /** Opaque workload handle (Akash dseq), when known. */
  readonly leaseId?: string;
  /** Workload label (ProvisionSpec.name). */
  readonly workload?: string;
  /** Seconds from lease to first serving response (successes only). */
  readonly bootSeconds?: number;
  /** Short context string — never secrets or raw response bodies. */
  readonly detail?: string;
}

/** Persistence seam for provider boot outcomes; injectable for tests. */
export interface ProviderOutcomeStore {
  record(rec: ProviderOutcomeRecord): Promise<void>;
  /** Aggregate history for one marketplace, keyed by provider account address. */
  stats(
    computeProvider: string
  ): Promise<ReadonlyMap<string, ProviderOutcomeStats>>;
}

/** Drizzle-backed store over compute_provider_outcomes (app-role client). */
export class DrizzleProviderOutcomeStore implements ProviderOutcomeStore {
  constructor(private readonly getDb: () => Promise<Database>) {}

  async record(rec: ProviderOutcomeRecord): Promise<void> {
    const db = await this.getDb();
    // task.5153 — the live-path writers (recovery-entry strike, serving-proof boot_ok)
    // legitimately retry across Crossplane reconcile ticks; the partial unique index
    // (lease_id, outcome) makes the replay a no-op instead of history inflation.
    await db
      .insert(computeProviderOutcomes)
      .values({
        computeProvider: rec.computeProvider,
        providerAccount: rec.providerAccount,
        outcome: rec.outcome,
        leaseId: rec.leaseId ?? null,
        workload: rec.workload ?? null,
        bootSeconds: rec.bootSeconds ?? null,
        detail: rec.detail ?? null,
      })
      .onConflictDoNothing();
  }

  async stats(
    computeProvider: string
  ): Promise<ReadonlyMap<string, ProviderOutcomeStats>> {
    const db = await this.getDb();
    const rows = await db
      .select({
        providerAccount: computeProviderOutcomes.providerAccount,
        successes: sql<string>`count(*) filter (where ${computeProviderOutcomes.outcome} = 'boot_ok')`,
        failures: sql<string>`count(*) filter (where ${computeProviderOutcomes.outcome} = 'slo_timeout')`,
        lastFailureAt: sql<
          string | null
        >`max(${computeProviderOutcomes.createdAt}) filter (where ${computeProviderOutcomes.outcome} = 'slo_timeout')`,
      })
      .from(computeProviderOutcomes)
      .where(eq(computeProviderOutcomes.computeProvider, computeProvider))
      .groupBy(computeProviderOutcomes.providerAccount);
    const map = new Map<string, ProviderOutcomeStats>();
    for (const row of rows) {
      map.set(row.providerAccount, {
        successes: Number(row.successes),
        failures: Number(row.failures),
        lastFailureAtMs: row.lastFailureAt
          ? new Date(row.lastFailureAt).getTime()
          : null,
      });
    }
    return map;
  }
}

/**
 * Default store for the bootstrap-constructed adapter (which receives no Database):
 * resolves the app-role client lazily on first use so unit tests and env-less builds
 * never touch the DB module.
 */
export function createDefaultProviderOutcomeStore(): ProviderOutcomeStore {
  return new DrizzleProviderOutcomeStore(async () => {
    const { getAppDb } = await import("../db/client");
    return getAppDb();
  });
}
