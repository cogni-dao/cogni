// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/work-item-role-authority`
 * Purpose: Qualify the released node grant host against operator migrations and RLS roles.
 * Scope: Isolated testcontainers PostgreSQL only; no account grants or live node I/O.
 * Invariants: NO_SELF_APPROVAL; LEGACY_NODE_ROLES_PRESERVED; APP_ROLE_DENIED.
 * Side-effects: IO (isolated test database).
 * Links: hub agent-run-authority, story.0085
 * @internal
 */
import { createHash, randomUUID } from "node:crypto";
import { createPostgresAgentGrantsStore } from "@cogni-dao/agent-grants";
import {
  type AgentAuthoritySql,
  createAgentToolAuthority,
} from "@cogni-dao/agent-grants/host";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const scope = "work_item:transition";
const toolId = "core__work_item_update";
const requires = {
  scope,
  kind: "node",
  subject: "member",
  label: "Change work items",
  description: "Change the state of work items.",
} as const;

function tokenOf(path: string | undefined): string {
  if (!path) throw new Error("pending request did not return a link");
  const token = new URLSearchParams(path.split("#")[1]).get("agent-request");
  if (!token) throw new Error("approval link did not contain a token");
  return token;
}

describe("released node-role host on the operator schema", () => {
  let service: Sql;
  let app: Sql;
  let host: ReturnType<typeof createAgentToolAuthority>;
  const principal = randomUUID();
  const internal = randomUUID();
  const legacy = randomUUID();
  const approver = randomUUID();
  const slug = `sql-${randomUUID()}`;
  const me = { userId: approver, admin: { userId: approver } };
  const ref = { principalUserId: principal, scope };
  const ids = [principal, internal, legacy, approver];

  beforeAll(async () => {
    if (!process.env.DATABASE_SERVICE_URL || !process.env.DATABASE_URL)
      throw new Error("isolated component PostgreSQL required");
    service = postgres(process.env.DATABASE_SERVICE_URL, { max: 1 });
    app = postgres(process.env.DATABASE_URL, { max: 1 });
    // Use the same Drizzle postgres.js client shape as the operator service DB.
    const client = drizzle(service).$client;
    host = createAgentToolAuthority({
      sql: client as unknown as AgentAuthoritySql,
      nodeAdmin: {
        check: async () => ({ ok: false, errorCode: "authz_denied" }),
      },
      log: { info() {}, warn() {}, error() {} },
      tools: [{ id: toolId, requires }],
      graphs: [{ principal: slug, toolIds: [toolId] }],
      systemUserIds: [],
    });
    await service`INSERT INTO users (id, name) VALUES
      (${principal}, ${`external-${principal}`}), (${internal}, ${`internal-${internal}`}),
      (${legacy}, ${`legacy-${legacy}`}), (${approver}, ${`admin-${approver}`})`;
    await service`INSERT INTO agent_principals (kind, slug, user_id) VALUES
      ('external', NULL, ${principal}), ('internal', ${slug}, ${internal})`;
    // Prior operator writers omit resource and all five new columns.
    await service`INSERT INTO agent_roles (principal_user_id, scope, approved_by)
      VALUES (${legacy}, ${scope}, ${approver})`;
  });

  afterAll(async () => {
    if (service) {
      await service`DELETE FROM agent_roles WHERE principal_user_id = ANY(${ids})`;
      await service`DELETE FROM agent_principals WHERE user_id = ANY(${ids})`;
      await service`DELETE FROM users WHERE id = ANY(${ids})`;
      await service.end({ timeout: 1 });
    }
    await app?.end({ timeout: 1 });
  });

  it("qualifies asks, decisions, links, legacy rows and the RLS boundary", async () => {
    const authorize = (userId: string) =>
      host.authorizeRoute({
        toolId,
        routeId: "work.items.patch",
        userId,
        via: "bearer",
      });
    const preview = (token: string) =>
      host.previewAsk({ token, resource: "node" });
    const rows = () =>
      service`SELECT * FROM agent_roles WHERE principal_user_id = ${principal} ORDER BY created_at, id`;

    expect(await authorize(legacy)).toMatchObject({
      decision: "allow",
      basis: "role",
    });
    const [old] =
      await service`SELECT resource, account_id, expires_at, link_hash, link_expires_at, link_consumed_at
      FROM agent_roles WHERE principal_user_id = ${legacy}`;
    expect(old).toMatchObject({
      resource: "node",
      account_id: null,
      expires_at: null,
      link_hash: null,
      link_expires_at: null,
      link_consumed_at: null,
    });
    expect(await authorize(principal)).toMatchObject({
      decision: "deny",
      code: "policy_denied",
    });

    const ask = await host.requestAccess(ref);
    expect(ask).toMatchObject({ state: "pending", created: true });
    const token = tokenOf(ask.approvalPath);
    const [pending] = await rows();
    expect(pending).toMatchObject({
      resource: "node",
      account_id: null,
      expires_at: null,
      approved_by: null,
      requested_by: principal,
      link_consumed_at: null,
      link_hash: createHash("sha256").update(token).digest("hex"),
    });
    expect(pending?.link_expires_at).toBeInstanceOf(Date);
    expect(await preview(token)).toMatchObject({
      principalUserId: principal,
      scope,
      section: "pending",
      on: false,
    });
    expect((await host.listNodeAi()).permissions).toContainEqual(
      expect.objectContaining({
        principalUserId: principal,
        scope,
        section: "pending",
      })
    );
    expect(await preview("bad")).toBeNull();
    expect(await host.previewAsk({ token, resource: "account" })).toBeNull();
    expect(await preview("a".repeat(43))).toBeNull();

    // The self decision must not consume the link or change any column.
    const before = await rows();
    await expect(
      host.grantRole({ ...ref, me: { userId: principal, admin: {} } })
    ).rejects.toMatchObject({ code: "self_approval" });
    expect(await rows()).toEqual(before);
    expect(await host.grantRole({ ...ref, me })).toMatchObject({
      created: true,
    });
    const [approved] = await rows();
    expect(approved).toMatchObject({ approved_by: approver, link_hash: null });
    expect(approved?.link_consumed_at).toBeInstanceOf(Date);
    expect(await preview(token)).toBeNull();
    expect(await authorize(principal)).toMatchObject({
      decision: "allow",
      basis: "role",
    });
    expect(
      await createPostgresAgentGrantsStore(app).hasLiveRole(principal, scope)
    ).toBe(false);
    await expect(
      app`INSERT INTO agent_roles (principal_user_id, scope) VALUES (${principal}, 'forbidden')`
    ).rejects.toThrow();
    const hidden =
      await app`UPDATE agent_roles SET revoked_at = now() WHERE principal_user_id = ${principal} RETURNING id`;
    expect(hidden).toHaveLength(0);
    expect(await host.revokeRole({ ...ref, me })).toMatchObject({
      revoked: true,
    });
    expect(await authorize(principal)).toMatchObject({
      decision: "deny",
      code: "policy_denied",
    });

    const dismissedToken = tokenOf(
      (await host.requestAccess(ref)).approvalPath
    );
    expect(await host.denyRequest({ ...ref, me })).toMatchObject({
      denied: true,
    });
    expect(await preview(dismissedToken)).toBeNull();
    expect(await host.listOwnAccess(principal)).toContainEqual(
      expect.objectContaining({ scope, state: "denied" })
    );
    const reask = tokenOf((await host.requestAccess(ref)).approvalPath);
    expect(await preview(reask)).not.toBeNull();
    await service`UPDATE agent_roles SET link_expires_at = now() - interval '1 second' WHERE principal_user_id = ${principal} AND revoked_at IS NULL`;
    expect(await preview(reask)).toBeNull();
    const rotated = tokenOf((await host.requestAccess(ref)).approvalPath);
    expect(await preview(rotated)).not.toBeNull();

    // SQL constraints reject duplicate live identities, duplicate hashes and bad references.
    const [live] = await rows().then((all) =>
      all.filter((row) => row.revoked_at === null)
    );
    await expect(
      service`INSERT INTO agent_roles (principal_user_id, scope) VALUES (${principal}, ${scope})`
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      service`INSERT INTO agent_roles (principal_user_id, scope, link_hash) VALUES (${internal}, 'other', ${live?.link_hash})`
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      service`INSERT INTO agent_roles (principal_user_id, scope, resource, account_id) VALUES (${internal}, 'fk', 'account', ${randomUUID()})`
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      service`INSERT INTO agent_roles (principal_user_id, scope, account_id) VALUES (${internal}, 'shape', ${randomUUID()})`
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      service`INSERT INTO agent_roles (principal_user_id, scope, link_hash, link_consumed_at) VALUES (${internal}, 'consumed', 'hash', now())`
    ).rejects.toMatchObject({ code: "23514" });

    expect(
      await host.grantRole({ principalSlug: slug, scope, me })
    ).toMatchObject({ principalUserId: internal, created: true });
    expect(await authorize(internal)).toMatchObject({
      decision: "allow",
      basis: "role",
    });
    expect(await authorize(legacy)).toMatchObject({
      decision: "allow",
      basis: "role",
    });
  });
});
