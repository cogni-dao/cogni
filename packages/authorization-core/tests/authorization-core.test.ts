// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/authorization-core/tests/authorization-core`
 * Purpose: Contract tests for action mapping, fake authz decisions, and OpenFGA adapter fail-closed behavior.
 * Scope: Package-local unit tests with injected fake OpenFGA clients only. Does not call network services.
 * Invariants: Deny and unavailable remain distinct; OBO execution performs permission and delegation checks.
 * Side-effects: none
 * Links: docs/spec/rbac.md
 * @internal
 */

import { describe, expect, it } from "vitest";

import {
  type AuthzCheckParams,
  authzConnectionResource,
  authzGraphResource,
  authzNodeResource,
  authzToolResource,
  FakeAuthorizationAdapter,
  OpenFgaAuthorizationAdapter,
  type OpenFgaCheckClient,
  type OpenFgaCheckRequest,
  type OpenFgaStoreClient,
  type OpenFgaWriteClient,
  relationForAuthzAction,
} from "../src/index";

const baseCheck = {
  actorId: "user:alice",
  action: "tool.execute",
  resource: authzToolResource("core__clock"),
  context: { tenantId: "tenant:one", runId: "run-1" },
} satisfies AuthzCheckParams;

describe("relationForAuthzAction", () => {
  it("maps Cogni actions to OpenFGA relations", () => {
    expect(relationForAuthzAction("tool.execute")).toBe("can_execute");
    expect(relationForAuthzAction("connection.use")).toBe("can_use");
    expect(relationForAuthzAction("graph.invoke")).toBe("can_invoke");
    expect(relationForAuthzAction("user.act_as")).toBe("delegates");
    expect(relationForAuthzAction("node.flight")).toBe("can_flight");
    expect(relationForAuthzAction("node.manage_secrets")).toBe(
      "can_manage_secrets"
    );
  });

  it("formats resource references", () => {
    expect(authzToolResource("x")).toBe("tool:x");
    expect(authzConnectionResource("c")).toBe("connection:c");
    expect(authzGraphResource("g")).toBe("graph:g");
    expect(authzNodeResource("n")).toBe("node:n");
  });
});

describe("FakeAuthorizationAdapter", () => {
  it("defaults to deny", async () => {
    const authz = new FakeAuthorizationAdapter();

    await expect(authz.check(baseCheck)).resolves.toMatchObject({
      decision: "deny",
      code: "authz_denied",
    });
  });

  it("returns deterministic allow and unavailable decisions", async () => {
    const authz = new FakeAuthorizationAdapter();
    authz.allow(baseCheck);

    await expect(authz.check(baseCheck)).resolves.toMatchObject({
      decision: "allow",
      code: "authz_allowed",
    });

    authz.unavailable(baseCheck);

    await expect(authz.check(baseCheck)).resolves.toMatchObject({
      decision: "deny",
      code: "authz_unavailable",
    });
  });

  it("mirrors OBO permission and delegation checks", async () => {
    const authz = new FakeAuthorizationAdapter();
    const oboCheck = {
      ...baseCheck,
      actorId: "agent:chat-v1",
      subjectId: "user:alice",
    };
    authz.allow(oboCheck);

    await expect(authz.check(oboCheck)).resolves.toMatchObject({
      decision: "allow",
      checks: [
        { name: "permission", user: "user:alice", relation: "can_execute" },
        { name: "delegation", user: "agent:chat-v1", relation: "delegates" },
      ],
    });
  });

  it("records relation writes and deletes", async () => {
    const authz = new FakeAuthorizationAdapter();
    const tuple = {
      user: "user:agent-1",
      relation: "developer",
      object: "node:node-1",
    };

    await expect(authz.writeRelation(tuple)).resolves.toMatchObject({
      decision: "success",
      code: "authz_write_success",
    });
    expect(authz.hasRelation(tuple)).toBe(true);

    await expect(authz.deleteRelation(tuple)).resolves.toMatchObject({
      decision: "success",
      code: "authz_write_success",
    });
    expect(authz.hasRelation(tuple)).toBe(false);
  });
});

describe("OpenFgaAuthorizationAdapter", () => {
  it("returns allow when direct OpenFGA check is allowed", async () => {
    const client = {
      async check(): Promise<{ allowed: boolean }> {
        return { allowed: true };
      },
    } satisfies OpenFgaCheckClient;

    const authz = new OpenFgaAuthorizationAdapter({
      apiUrl: "http://openfga.test",
      storeId: "store",
      client,
    });

    await expect(authz.check(baseCheck)).resolves.toMatchObject({
      decision: "allow",
      code: "authz_allowed",
      checks: [{ relation: "can_execute", user: "user:alice" }],
    });
  });

  it("keeps deny distinct from unavailable", async () => {
    const denyClient = {
      async check(): Promise<{ allowed: boolean }> {
        return { allowed: false };
      },
    } satisfies OpenFgaCheckClient;
    const unavailableClient = {
      async check(): Promise<{ allowed: boolean }> {
        throw new Error("network down");
      },
    } satisfies OpenFgaCheckClient;

    await expect(
      new OpenFgaAuthorizationAdapter({
        apiUrl: "http://openfga.test",
        storeId: "store",
        client: denyClient,
      }).check(baseCheck)
    ).resolves.toMatchObject({ decision: "deny", code: "authz_denied" });

    await expect(
      new OpenFgaAuthorizationAdapter({
        apiUrl: "http://openfga.test",
        storeId: "store",
        client: unavailableClient,
      }).check(baseCheck)
    ).resolves.toMatchObject({
      decision: "deny",
      code: "authz_unavailable",
    });
  });

  it("performs subject permission and actor delegation checks for OBO", async () => {
    const seen: OpenFgaCheckRequest[] = [];
    const client = {
      async check(request: OpenFgaCheckRequest): Promise<{ allowed: boolean }> {
        seen.push(request);
        return { allowed: true };
      },
    } satisfies OpenFgaCheckClient;

    const authz = new OpenFgaAuthorizationAdapter({
      apiUrl: "http://openfga.test",
      storeId: "store",
      client,
    });

    await expect(
      authz.check({
        ...baseCheck,
        actorId: "agent:chat-v1",
        subjectId: "user:alice",
      })
    ).resolves.toMatchObject({ decision: "allow" });

    expect(seen).toEqual([
      {
        user: "user:alice",
        relation: "can_execute",
        object: "tool:core__clock",
      },
      {
        user: "agent:chat-v1",
        relation: "delegates",
        object: "user:alice",
      },
    ]);
  });

  it("resolves a stable store name before checking", async () => {
    const seen: OpenFgaCheckRequest[] = [];
    const client = {
      async listStores(): Promise<{
        stores: readonly { id: string; name: string }[];
      }> {
        return { stores: [{ id: "store-1", name: "cogni-rbac" }] };
      },
      async createStore(): Promise<{ id: string }> {
        throw new Error("store should already exist");
      },
      async check(request: OpenFgaCheckRequest): Promise<{ allowed: boolean }> {
        seen.push(request);
        return { allowed: true };
      },
    } satisfies OpenFgaStoreClient;

    const authz = new OpenFgaAuthorizationAdapter({
      apiUrl: "http://openfga.test",
      storeName: "cogni-rbac",
      storeClient: client,
    });

    await expect(authz.check(baseCheck)).resolves.toMatchObject({
      decision: "allow",
      code: "authz_allowed",
    });
    expect(seen).toEqual([
      {
        user: "user:alice",
        relation: "can_execute",
        object: "tool:core__clock",
      },
    ]);
  });

  it("writes and deletes relation tuples through OpenFGA", async () => {
    const written: unknown[] = [];
    const deleted: unknown[] = [];
    const client = {
      async check(): Promise<{ allowed: boolean }> {
        return { allowed: true };
      },
      async writeTuples(tuples: unknown[]): Promise<void> {
        written.push(...tuples);
      },
      async deleteTuples(tuples: unknown[]): Promise<void> {
        deleted.push(...tuples);
      },
    } satisfies OpenFgaWriteClient;

    const authz = new OpenFgaAuthorizationAdapter({
      apiUrl: "http://openfga.test",
      storeId: "store",
      client,
    });
    const tuple = {
      user: "user:agent-1",
      relation: "developer",
      object: "node:node-1",
    };

    await expect(authz.writeRelation(tuple)).resolves.toMatchObject({
      decision: "success",
      code: "authz_write_success",
    });
    await expect(authz.deleteRelation(tuple)).resolves.toMatchObject({
      decision: "success",
      code: "authz_write_success",
    });
    expect(written).toEqual([tuple]);
    expect(deleted).toEqual([tuple]);
  });
});
