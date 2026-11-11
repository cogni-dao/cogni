// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/agent-credentials.migration-guard`
 * Purpose: The agent-authority migration must carry its HAND-WRITTEN objects. drizzle-kit regenerates only the declarative DDL, and
 *   `db:check` is blind to hand-written SQL, so a regeneration that drops these hunks passes every other local gate (it did once,
 *   at PR #3135 head ae04f83536). The package's lookup/upgrade SQL selects `agent_credential_state`, so losing it 503s every verify.
 * Scope: Static grep of the migration file; does not run SQL or touch a database.
 * Side-effects: none
 * Links: https://cognidao.org/work/items/story.5156
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = join(
  __dirname,
  "../../../src/adapters/server/db/migrations"
);

describe("agent-authority migration carries its hand-written objects", () => {
  const file = readdirSync(MIGRATIONS_DIR).find((name) =>
    /^0063_.*\.sql$/.test(name)
  );

  it("finds exactly one 0063 migration", () => {
    expect(file).toBeDefined();
  });

  it("contains FORCE RLS on all three tables, both triggers and the state function", () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, file as string), "utf8");
    for (const needle of [
      'ALTER TABLE "agent_principals" FORCE ROW LEVEL SECURITY',
      'ALTER TABLE "agent_roles" FORCE ROW LEVEL SECURITY',
      'ALTER TABLE "agent_credentials" FORCE ROW LEVEL SECURITY',
      "FUNCTION agent_credential_state",
      "FUNCTION agent_principals_refuse_wallet_binding",
      "FUNCTION agent_credentials_require_external_principal",
      "'spawn_grant','rotation','key_upgrade','binding_recovery','recovery_grant'",
    ]) {
      expect(sql, `missing hand-written object: ${needle}`).toContain(needle);
    }
  });
});
