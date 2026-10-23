// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/db/work-item-session.adapter`
 * Purpose: Prove the session adapter's claimant matching for human users and durable agent principals.
 * Scope: Drives DrizzleWorkItemSessionAdapter against a recording Drizzle fake; no database.
 * Invariants: EXACTLY_ONE_CLAIMANT, ONE_ACTIVE_CLAIM_DB_ENFORCED.
 * Side-effects: none
 * Links: src/adapters/server/db/work-item-session.adapter.ts, story.5075
 * @internal
 */

import type { Database } from "@cogni/db-client";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it } from "vitest";

import { DrizzleWorkItemSessionAdapter } from "@/adapters/server/db/work-item-session.adapter";

const PRINCIPAL = "agent:operator/00000000-0000-4000-8000-000000005264";
const USER = "00000000-0000-4000-a000-000000000001";

type Row = Record<string, unknown>;

function row(overrides: Row = {}): Row {
  return {
    id: "00000000-0000-4000-8000-000000005007",
    workItemId: "task.5007",
    claimedByUserId: null,
    claimedByPrincipalId: null,
    claimedByDisplayName: null,
    status: "active",
    claimedAt: new Date("2026-10-22T00:00:00.000Z"),
    lastHeartbeatAt: null,
    deadlineAt: new Date("2026-10-22T01:00:00.000Z"),
    closedAt: null,
    lastCommand: null,
    branch: null,
    prNumber: null,
    createdAt: new Date("2026-10-22T00:00:00.000Z"),
    updatedAt: new Date("2026-10-22T00:00:00.000Z"),
    ...overrides,
  };
}

/** Records writes and serves a fixed open session to `getOpen`. */
function fakeDb(state: {
  open: Row | null;
  inserted: Row[];
  updates: { set: Row; where: { sql: string; params: unknown[] } }[];
}): Database {
  const dialect = new PgDialect();
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => (state.open ? [state.open] : []),
          }),
        }),
      }),
    }),
    insert: () => ({
      values: (values: Row) => ({
        returning: async () => {
          state.inserted.push(values);
          return [row(values)];
        },
      }),
    }),
    update: () => ({
      set: (set: Row) => ({
        where: (condition: SQL) => ({
          returning: async () => {
            state.updates.push({
              set,
              where: dialect.sqlToQuery(condition),
            });
            return state.open ? [{ ...state.open, ...set }] : [];
          },
        }),
      }),
    }),
  } as unknown as Database;
}

describe("DrizzleWorkItemSessionAdapter claimant matching", () => {
  let state: Parameters<typeof fakeDb>[0];
  let adapter: DrizzleWorkItemSessionAdapter;

  beforeEach(() => {
    state = { open: null, inserted: [], updates: [] };
    adapter = new DrizzleWorkItemSessionAdapter(fakeDb(state));
  });

  it("reports a conflict when an agent claims over an open user claim", async () => {
    state.open = row({ claimedByUserId: USER });

    const result = await adapter.claim({
      workItemId: "task.5007",
      claimedByPrincipalId: PRINCIPAL,
      claimedByDisplayName: "fresh-v2",
      deadlineAt: new Date("2026-10-22T02:00:00.000Z"),
    });

    expect(result.kind).toBe("conflict");
    expect(result.session.claimedByUserId).toBe(USER);
    expect(state.inserted).toEqual([]);
    expect(state.updates).toEqual([]);
  });

  it("refreshes the agent's own open session on re-claim", async () => {
    state.open = row({ claimedByPrincipalId: PRINCIPAL });

    const result = await adapter.claim({
      workItemId: "task.5007",
      claimedByPrincipalId: PRINCIPAL,
      claimedByDisplayName: "fresh-v2",
      deadlineAt: new Date("2026-10-22T02:00:00.000Z"),
      lastCommand: "/implement",
    });

    expect(result.kind).toBe("claimed");
    expect(result.session.claimedByPrincipalId).toBe(PRINCIPAL);
    expect(state.inserted).toEqual([]);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]?.set).toMatchObject({
      status: "active",
      lastCommand: "/implement",
    });
  });

  it("writes exactly one claimant column for a new agent claim", async () => {
    await adapter.claim({
      workItemId: "task.5007",
      claimedByPrincipalId: PRINCIPAL,
      claimedByDisplayName: "fresh-v2",
      deadlineAt: new Date("2026-10-22T02:00:00.000Z"),
    });

    expect(state.inserted).toHaveLength(1);
    expect(state.inserted[0]).toMatchObject({
      claimedByUserId: null,
      claimedByPrincipalId: PRINCIPAL,
    });
  });

  it("does not treat a user claim as the same claimant as an agent", async () => {
    state.open = row({ claimedByPrincipalId: PRINCIPAL });

    const result = await adapter.claim({
      workItemId: "task.5007",
      claimedByUserId: USER,
      claimedByDisplayName: null,
      deadlineAt: new Date("2026-10-22T02:00:00.000Z"),
    });

    expect(result.kind).toBe("conflict");
  });

  it("scopes heartbeat to the principal column, never the user column", async () => {
    state.open = row({ claimedByPrincipalId: PRINCIPAL });

    await adapter.heartbeat({
      workItemId: "task.5007",
      claimedByPrincipalId: PRINCIPAL,
      deadlineAt: new Date("2026-10-22T02:00:00.000Z"),
    });

    const where = state.updates[0]?.where;
    expect(where?.sql).toContain('"claimed_by_principal_id"');
    expect(where?.sql).not.toContain('"claimed_by_user_id"');
    expect(where?.params).toContain(PRINCIPAL);
  });
});
