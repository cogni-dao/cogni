// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/agent-credentials.hasroles`
 * Purpose: The operator-only `hasRoles` composition (task.5474 C5, BINDING_BEFORE_UPGRADE): agent_roles SQL first, then OpenFGA
 *   listRelations; an authz outage or a missing adapter is a store outage (503 class), never a silent "no roles".
 * Scope: `operatorHasRoles` alone with a fake sql tag and a mocked container; does not touch a database or OpenFGA.
 * Side-effects: none
 * Links: https://cognidao.org/work/items/story.5156
 */

import type { CredentialSql } from "@cogni-dao/agent-grants/credentials";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  sqlRows: [] as unknown[],
  sqlCalls: 0,
  authorization: undefined as
    | undefined
    | { listRelations: (user: string) => Promise<unknown> },
}));

vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({ authorization: fake.authorization }),
  resolveServiceDb: () => {
    throw new Error("not used in this test");
  },
}));

import { operatorHasRoles } from "@/bootstrap/agent-credentials";

const sqlTag = (async () => {
  fake.sqlCalls += 1;
  return fake.sqlRows;
}) as unknown as CredentialSql;

describe("operatorHasRoles — C5 roles read spans both planes, fail closed", () => {
  beforeEach(() => {
    fake.sqlRows = [];
    fake.sqlCalls = 0;
    fake.authorization = undefined;
  });

  it("a live agent_roles row answers true without consulting OpenFGA", async () => {
    fake.sqlRows = [{ has_roles: true }];
    const listRelations = vi.fn();
    fake.authorization = { listRelations };

    expect(await operatorHasRoles(sqlTag)("user-1")).toBe(true);
    expect(listRelations).not.toHaveBeenCalled();
  });

  it("no SQL row + OpenFGA tuples present answers true; no tuples answers false", async () => {
    fake.authorization = {
      listRelations: async () => ({
        decision: "success",
        tuples: [{ object: "node:x", relation: "developer" }],
      }),
    };
    expect(await operatorHasRoles(sqlTag)("user-2")).toBe(true);

    fake.authorization = {
      listRelations: async () => ({ decision: "success", tuples: [] }),
    };
    expect(await operatorHasRoles(sqlTag)("user-2")).toBe(false);
  });

  it("a missing authz adapter is a store outage (fail closed), never false", async () => {
    fake.authorization = undefined;
    await expect(operatorHasRoles(sqlTag)("user-3")).rejects.toMatchObject({
      name: "CredentialStoreUnavailableError",
    });
  });

  it("an OpenFGA non-success decision is a store outage (fail closed), never false", async () => {
    fake.authorization = {
      listRelations: async () => ({
        decision: "unavailable",
        code: "authz_list_unavailable",
      }),
    };
    await expect(operatorHasRoles(sqlTag)("user-4")).rejects.toMatchObject({
      name: "CredentialStoreUnavailableError",
    });
  });
});
