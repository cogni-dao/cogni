// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/agent-principals-backfill.int.test`
 * Purpose: Migration 0067's selection rule against real Postgres: only an outside agent (bare, or one that linked GitHub) gets an
 *   external `agent_principals` row; a SIWE human and a GitHub first-sign-in (OAuth) human never do (story.5167).
 * Scope: Reads the INSERT statement out of the 0067 file and runs it through the BYPASSRLS service role, narrowed to the fixture user
 *   ids so no other test's users are touched. The FORCE RLS lift and restore around it need table ownership and are asserted on the file text.
 *   Fixtures use the exact rows the operator's own code writes: register route (users only), auth.ts:430 link (`user_bindings` + `identity_events`
 *   method `oauth_link`), auth.ts:459-495 OAuth first sign-in (users, binding, event method `oauth`, profile), auth.ts:225-260 SIWE.
 * Invariants:
 *   - PRECISION_OVER_COVERAGE: a human is never given an agent row.
 *   - IDEMPOTENT: a second run inserts nothing new.
 * Side-effects: IO (testcontainers Postgres). `identity_events` is append-only, so fixture rows are left in the throwaway database.
 * Links: nodes/operator/app/src/adapters/server/db/migrations/0067_backfill_agent_principals.sql
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MIGRATION = join(
  __dirname,
  "../../../src/adapters/server/db/migrations/0067_backfill_agent_principals.sql"
);

describe("0067 backfill_agent_principals selection (real Postgres)", () => {
  let service: Sql;
  const ids = {
    bareAgent: randomUUID(),
    githubLinkedAgent: randomUUID(),
    oauthHuman: randomUUID(),
    siweHuman: randomUUID(),
  };

  const makeUser = async (id: string, wallet: string | null) => {
    await service`INSERT INTO users (id, name, wallet_address) VALUES (${id}, ${`backfill-${id.slice(0, 6)}`}, ${wallet})`;
  };
  const bind = async (
    userId: string,
    provider: string,
    method: string
  ): Promise<void> => {
    const externalId = `${provider}-${randomUUID()}`;
    await service`INSERT INTO user_bindings (id, user_id, provider, external_id) VALUES (${randomUUID()}, ${userId}, ${provider}, ${externalId})`;
    await service`INSERT INTO identity_events (id, user_id, event_type, payload)
      VALUES (${randomUUID()}, ${userId}, 'bind', ${service.json({ provider, external_id: externalId, method })})`;
  };
  const profile = async (userId: string) => {
    await service`INSERT INTO user_profiles (user_id) VALUES (${userId})`;
  };
  const principalsOf = async (userId: string) =>
    (
      await service`SELECT kind FROM agent_principals WHERE user_id = ${userId}`
    ).map((r) => r.kind);

  /** The migration's INSERT, narrowed to the fixture ids so concurrent tests' users are never touched. */
  const backfillStatement = () => {
    const sql = readFileSync(MIGRATION, "utf8");
    const insert = sql
      .split("--> statement-breakpoint")
      .map((part) => part.trim())
      .find((part) => part.includes('INSERT INTO "agent_principals"'));
    if (!insert) throw new Error("0067 has no agent_principals INSERT");
    const narrowed = insert.replace(
      '\nON CONFLICT ("user_id")',
      '\n  AND u."id" = ANY($1)\nON CONFLICT ("user_id")'
    );
    if (narrowed === insert) throw new Error("0067 ON CONFLICT shape changed");
    return narrowed.replace(/;$/, "");
  };
  const run = () =>
    service.unsafe(backfillStatement(), [Object.values(ids)] as never[]);

  beforeAll(async () => {
    if (!process.env.DATABASE_SERVICE_URL)
      throw new Error("component PostgreSQL required");
    service = postgres(process.env.DATABASE_SERVICE_URL, { max: 2 });

    // Bare agent: what POST /api/v1/agent/register wrote before it wrote a principal row.
    await makeUser(ids.bareAgent, null);

    // GitHub-linked agent: users row, then createBinding (auth.ts:430): binding + event method oauth_link, no profile.
    await makeUser(ids.githubLinkedAgent, null);
    await bind(ids.githubLinkedAgent, "github", "oauth_link");

    // OAuth (GitHub) human: auth.ts:459-495 one transaction: users (wallet null), binding, event method oauth, profile.
    await makeUser(ids.oauthHuman, null);
    await bind(ids.oauthHuman, "github", "oauth");
    await profile(ids.oauthHuman);

    // SIWE human: auth.ts:225-260: users with wallet, profile, wallet binding + event method siwe.
    await makeUser(
      ids.siweHuman,
      `0x${randomUUID().replaceAll("-", "").padEnd(40, "0").slice(0, 40)}`
    );
    await profile(ids.siweHuman);
    await bind(ids.siweHuman, "wallet", "siwe");
  });

  afterAll(async () => {
    await service?.end({ timeout: 1 });
  });

  it("gives an external principal row to the bare agent and the GitHub-linked agent only", async () => {
    await run();
    expect(await principalsOf(ids.bareAgent)).toEqual(["external"]);
    expect(await principalsOf(ids.githubLinkedAgent)).toEqual(["external"]);
    expect(await principalsOf(ids.oauthHuman)).toEqual([]);
    expect(await principalsOf(ids.siweHuman)).toEqual([]);
  });

  it("is idempotent: a second run changes nothing", async () => {
    await run();
    await run();
    expect(await principalsOf(ids.bareAgent)).toEqual(["external"]);
    expect(await principalsOf(ids.githubLinkedAgent)).toEqual(["external"]);
    expect(await principalsOf(ids.oauthHuman)).toEqual([]);
    expect(await principalsOf(ids.siweHuman)).toEqual([]);
  });

  it("lifts FORCE RLS only around the statement and restores it for every table it lifted", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    for (const table of [
      "users",
      "user_bindings",
      "user_profiles",
      "identity_events",
      "agent_principals",
    ]) {
      expect(sql).toContain(
        `ALTER TABLE "${table}" NO FORCE ROW LEVEL SECURITY`
      );
      expect(sql).toMatch(
        new RegExp(
          `ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY(;|\\s*$)`,
          "m"
        )
      );
    }
  });
});
