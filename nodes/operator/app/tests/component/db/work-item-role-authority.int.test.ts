// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/work-item-role-authority`
 * Purpose: Exercise the released HTTP and offered-tool grant reads against operator migrations.
 * Scope: Throwaway testcontainers PostgreSQL with the actual app/service roles; no live node I/O.
 * Invariants: LEGACY_NODE_ROLES_PRESERVED; REVOKE_IS_IMMEDIATE; APP_ROLE_DENIED.
 * Side-effects: IO (isolated test database).
 * Links: hub agent-run-authority, adopt-node-package-release, story.0085
 * @internal
 */
import { randomUUID } from "node:crypto";
import {
  authorizeCaller,
  createPostgresAgentGrantsStore,
  offeredToolIds,
} from "@cogni-dao/agent-grants";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("released node-role reads on the operator schema", () => {
  let service: Sql;
  let app: Sql;
  const principal = randomUUID();
  const approver = randomUUID();
  const scope = "work_item:transition";
  const requires = { scope, kind: "node", subject: "member" } as const;

  beforeAll(async () => {
    if (!process.env.DATABASE_SERVICE_URL || !process.env.DATABASE_URL)
      throw new Error("isolated component PostgreSQL required");
    service = postgres(process.env.DATABASE_SERVICE_URL, { max: 1 });
    app = postgres(process.env.DATABASE_URL, { max: 1 });
    await service`INSERT INTO users (id, name) VALUES (${principal}, 'role-agent'), (${approver}, 'role-approver')`;
    // The previous operator's writer omits resource. Its approved row must remain a node role.
    await service`INSERT INTO agent_roles (principal_user_id, scope, approved_by)
      VALUES (${principal}, ${scope}, ${approver})`;
  });

  afterAll(async () => {
    if (service) {
      await service`DELETE FROM agent_roles WHERE principal_user_id = ${principal}`;
      await service`DELETE FROM users WHERE id IN (${principal}, ${approver})`;
      await service.end({ timeout: 1 });
    }
    await app?.end({ timeout: 1 });
  });

  it("allows the same legacy grant through HTTP and offering, then immediately refuses its revocation", async () => {
    const store = createPostgresAgentGrantsStore(service);
    const adminCheck = async () => "denied" as const;
    const caller = () =>
      authorizeCaller(store, adminCheck, {
        userId: principal,
        via: "bearer",
        requires,
      });
    const offered = () =>
      offeredToolIds(
        [{ id: "update", effect: "state_change" }],
        { update: requires },
        { principalId: principal },
        { withStore: async (fn) => fn(store), adminCheck }
      );
    expect(await caller()).toEqual({ decision: "allow", basis: "role" });
    expect((await offered()).offered).toEqual(["update"]);
    // The app role must still see no node grants even when the service role can read them.
    expect(
      await createPostgresAgentGrantsStore(app).hasLiveRole(principal, scope)
    ).toBe(false);
    await service`UPDATE agent_roles SET revoked_at = now() WHERE principal_user_id = ${principal}`;
    expect(await caller()).toMatchObject({
      decision: "deny",
      code: "policy_denied",
    });
    expect((await offered()).offered).toEqual([]);
  });
});
