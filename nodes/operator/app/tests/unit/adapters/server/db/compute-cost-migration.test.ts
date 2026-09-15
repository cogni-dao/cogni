// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MIGRATION_PATH = fileURLToPath(
  new URL(
    "../../../../../src/adapters/server/db/migrations/0047_easy_baron_strucker.sql",
    import.meta.url
  )
);

const LEGACY_COLUMNS = [
  "attempt_key",
  "node_id",
  "environment",
  "workload_uid",
  "workload_generation",
  "source_sha",
  "resource_shape",
  "state",
  "compute_provider",
  "resource_id",
  "compute_provider_account_id",
  "compute_supplier_account_id",
  "rate_amount",
  "rate_denom",
  "rate_unit",
  "provider_opened_at_position",
  "provider_closed_at_position",
  "escrow_state",
  "provider_settled_at_position",
  "escrow_funds",
  "cumulative_transferred",
  "first_observed_at",
  "last_observed_at",
  "closed_recorded_at",
  "prepared_at",
  "created_at",
  "updated_at",
] as const;

describe("compute cost migration legacy convergence (task.5071)", () => {
  const sql = readFileSync(MIGRATION_PATH, "utf8");
  const guardEnd = sql.indexOf("END $$;");
  const guard = sql.slice(0, guardEnd);

  it("fingerprints the complete rejected #2197 controller-era table", () => {
    for (const column of LEGACY_COLUMNS) {
      expect(guard).toContain(`'${column}'`);
    }
    expect(guard).toContain("compute_cost_intervals_binding_check");
    expect(guard).toContain("compute_cost_intervals_generation_check");
    expect(guard).toContain("compute_cost_intervals_resource_key");
    expect(guard).toContain("compute_cost_intervals_node_state_idx");
    expect(guard).toContain("compute_cost_intervals_workload_idx");
  });

  it("aborts an unrecognized preexisting shape before dropping any table", () => {
    const rejectAt = sql.indexOf("RAISE EXCEPTION");
    const dropAt = sql.indexOf("DROP TABLE public.compute_cost_intervals");
    const createAt = sql.indexOf('CREATE TABLE "compute_cost_intervals"');

    expect(guard).toContain("actual_columns IS DISTINCT FROM expected_columns");
    expect(guard).toContain(
      "actual_constraints IS DISTINCT FROM expected_constraints"
    );
    expect(guard).toContain("actual_indexes IS DISTINCT FROM expected_indexes");
    expect(rejectAt).toBeGreaterThan(-1);
    expect(dropAt).toBeGreaterThan(rejectAt);
    expect(createAt).toBeGreaterThan(dropAt);
  });

  it("does not treat rejected legacy rows as authoritative cost receipts", () => {
    expect(guard).not.toMatch(/\bINSERT\b/i);
    expect(guard).not.toMatch(/\bUPDATE\b/i);
    expect(sql).toContain('"allocation_receipt_id" uuid PRIMARY KEY NOT NULL');
    expect(sql).toContain(
      'FOREIGN KEY ("allocation_receipt_id") REFERENCES "public"."akash_tx_allocations"("id")'
    );
  });
});
