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
  AUTHZ_GRANT_NOT_EXPIRED_CONDITION,
  type AuthzCheckParams,
  type AuthzRelationTuple,
  authzBillingAccountResource,
  authzConnectionResource,
  authzGrantExpiresAt,
  authzGraphResource,
  authzNodeAgentPrincipal,
  authzNodeResource,
  authzNodeUserPrincipal,
  authzToolResource,
  FakeAuthorizationAdapter,
  relationForAuthzAction,
} from "../src/index";
import {
  OpenFgaAuthorizationAdapter,
  type OpenFgaCheckClient,
  type OpenFgaCheckOptions,
  type OpenFgaCheckRequest,
  type OpenFgaStoreClient,
  type OpenFgaWriteClient,
} from "../src/operator";

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
    expect(relationForAuthzAction("billing_account.read")).toBe("can_read");
    expect(relationForAuthzAction("billing_account.grant")).toBe("can_grant");
    expect(relationForAuthzAction("billing_account.act_as")).toBe("can_act_as");
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
    expect(authzNodeUserPrincipal("node-1", "alice")).toBe("user:node-1/alice");
    expect(authzNodeAgentPrincipal("node-1", "agent-1")).toBe(
      "agent:node-1/agent-1"
    );
    expect(authzNodeAgentPrincipal("node-1", "agent:node-1/agent-1")).toBe(
      "agent:node-1/agent-1"
    );
    expect(authzBillingAccountResource("node-1", "b")).toBe(
      "billing_account:node-1/b"
    );
    expect(
      authzBillingAccountResource("node-1", "billing_account:node-1/b")
    ).toBe("billing_account:node-1/b");
    expect(authzBillingAccountResource("node-2", "b")).not.toBe(
      authzBillingAccountResource("node-1", "b")
    );
    expect(() =>
      authzNodeAgentPrincipal("node-1", "agent:node-2/agent-1")
    ).toThrow("different node namespace");
    expect(() => authzNodeAgentPrincipal("node-1", "agent/1")).toThrow(
      "node-local identifier"
    );
    expect(() => authzNodeUserPrincipal("node-1", "user:alice")).toThrow(
      "different node namespace"
    );
    expect(() => authzBillingAccountResource("node/1", "b")).toThrow(
      "node-local identifier"
    );
    expect(authzGrantExpiresAt("2026-11-01T00:00:00.000Z")).toEqual({
      name: AUTHZ_GRANT_NOT_EXPIRED_CONDITION,
      context: { expires_at: "2026-11-01T00:00:00.000Z" },
    });
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

  it("mirrors exact-account OBO delegation without changing legacy OBO", async () => {
    const authz = new FakeAuthorizationAdapter();
    const account = authzBillingAccountResource("node-1", "acct-1");
    const oboCheck = {
      actorId: authzNodeAgentPrincipal("node-1", "poly-brain"),
      subjectId: authzNodeUserPrincipal("node-1", "alice"),
      action: "billing_account.read",
      resource: account,
      context: { tenantId: "tenant:one" },
    } satisfies AuthzCheckParams;
    authz.allow(oboCheck);

    await expect(authz.check(oboCheck)).resolves.toMatchObject({
      decision: "allow",
      checks: [
        {
          name: "permission",
          user: "user:node-1/alice",
          relation: "can_read",
          object: account,
        },
        {
          name: "delegation",
          user: "agent:node-1/poly-brain",
          relation: "delegates",
          object: "user:node-1/alice",
        },
        {
          name: "delegation",
          user: "agent:node-1/poly-brain",
          relation: "can_act_as",
          object: account,
        },
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

  it("passes higher consistency through authority-bearing checks", async () => {
    const seen: Array<OpenFgaCheckOptions | undefined> = [];
    const client = {
      async check(
        _request: OpenFgaCheckRequest,
        options?: OpenFgaCheckOptions
      ): Promise<{ allowed: boolean }> {
        seen.push(options);
        return { allowed: true };
      },
    } satisfies OpenFgaCheckClient;
    const authz = new OpenFgaAuthorizationAdapter({
      apiUrl: "http://openfga.test",
      storeId: "store",
      client,
    });

    await authz.check(baseCheck, { consistency: "higher_consistency" });
    expect(seen).toEqual([{ consistency: "HIGHER_CONSISTENCY" }]);
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

  it("checks direct agent reads and human grant authority on the exact account", async () => {
    const seen: OpenFgaCheckRequest[] = [];
    const client = {
      async check(request: OpenFgaCheckRequest): Promise<{ allowed: boolean }> {
        seen.push(request);
        return { allowed: true };
      },
    } satisfies OpenFgaCheckClient;
    const now = new Date("2026-10-09T22:00:00.000Z");
    const authz = new OpenFgaAuthorizationAdapter({
      apiUrl: "http://openfga.test",
      storeId: "store",
      client,
      now: () => now,
    });
    const account = authzBillingAccountResource("node-1", "acct-1");

    await expect(
      authz.check({
        actorId: authzNodeAgentPrincipal("node-1", "reader"),
        action: "billing_account.read",
        resource: account,
        context: { tenantId: "tenant:one" },
      })
    ).resolves.toMatchObject({ decision: "allow" });
    await expect(
      authz.check({
        actorId: authzNodeUserPrincipal("node-1", "alice"),
        action: "billing_account.grant",
        resource: account,
        context: { tenantId: "tenant:one" },
      })
    ).resolves.toMatchObject({ decision: "allow" });

    expect(seen).toEqual([
      {
        user: "agent:node-1/reader",
        relation: "can_read",
        object: account,
        context: { current_time: now.toISOString() },
      },
      {
        user: "user:node-1/alice",
        relation: "can_grant",
        object: account,
      },
    ]);
  });

  it("scopes billing-account OBO delegation to the same exact resource", async () => {
    const seen: OpenFgaCheckRequest[] = [];
    const client = {
      async check(request: OpenFgaCheckRequest): Promise<{ allowed: boolean }> {
        seen.push(request);
        return { allowed: true };
      },
    } satisfies OpenFgaCheckClient;
    const now = new Date("2026-10-09T22:00:00.000Z");
    const authz = new OpenFgaAuthorizationAdapter({
      apiUrl: "http://openfga.test",
      storeId: "store",
      client,
      now: () => now,
    });
    const account = authzBillingAccountResource("node-1", "acct-1");

    await expect(
      authz.check({
        actorId: authzNodeAgentPrincipal("node-1", "poly-brain"),
        subjectId: authzNodeUserPrincipal("node-1", "alice"),
        action: "billing_account.read",
        resource: account,
        context: { tenantId: "tenant:one" },
      })
    ).resolves.toMatchObject({ decision: "allow" });

    expect(seen).toEqual([
      {
        user: "user:node-1/alice",
        relation: "can_read",
        object: account,
        context: { current_time: now.toISOString() },
      },
      {
        user: "agent:node-1/poly-brain",
        relation: "delegates",
        object: "user:node-1/alice",
      },
      {
        user: "agent:node-1/poly-brain",
        relation: "can_act_as",
        object: account,
        context: { current_time: now.toISOString() },
      },
    ]);
  });

  it("requires both subject and exact-account delegation for OBO reads", async () => {
    const client = {
      async check(request: OpenFgaCheckRequest): Promise<{ allowed: boolean }> {
        return { allowed: request.relation !== "delegates" };
      },
    } satisfies OpenFgaCheckClient;
    const authz = new OpenFgaAuthorizationAdapter({
      apiUrl: "http://openfga.test",
      storeId: "store",
      client,
    });

    await expect(
      authz.check({
        actorId: authzNodeAgentPrincipal("node-1", "poly-brain"),
        subjectId: authzNodeUserPrincipal("node-1", "alice"),
        action: "billing_account.read",
        resource: authzBillingAccountResource("node-1", "acct-1"),
        context: { tenantId: "tenant:one" },
      })
    ).resolves.toMatchObject({
      decision: "deny",
      code: "authz_denied",
      checks: [
        { relation: "can_read", decision: "allow" },
        { relation: "delegates", decision: "deny" },
        { relation: "can_act_as", decision: "allow" },
      ],
    });
  });

  it("fails closed when OpenFGA evaluates a conditional grant as expired", async () => {
    const expiresAt = "2026-10-09T21:59:59.000Z";
    const client = {
      async check(request: OpenFgaCheckRequest): Promise<{ allowed: boolean }> {
        const currentTime = request.context?.current_time;
        return {
          allowed: typeof currentTime === "string" && currentTime < expiresAt,
        };
      },
    } satisfies OpenFgaCheckClient;
    const authz = new OpenFgaAuthorizationAdapter({
      apiUrl: "http://openfga.test",
      storeId: "store",
      client,
      now: () => new Date("2026-10-09T22:00:00.000Z"),
    });

    await expect(
      authz.check({
        actorId: authzNodeAgentPrincipal("node-1", "reader"),
        action: "billing_account.read",
        resource: authzBillingAccountResource("node-1", "acct-1"),
        context: { tenantId: "tenant:one" },
      })
    ).resolves.toMatchObject({
      decision: "deny",
      code: "authz_denied",
    });
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

  it("writes a semantic bundle atomically and confirms every tuple at higher consistency", async () => {
    const writeCalls: AuthzRelationTuple[][] = [];
    const checks: Array<{
      request: OpenFgaCheckRequest;
      options: OpenFgaCheckOptions | undefined;
    }> = [];
    const client = {
      async check(
        request: OpenFgaCheckRequest,
        options?: OpenFgaCheckOptions
      ): Promise<{ allowed: boolean }> {
        checks.push({ request, options });
        return { allowed: true };
      },
      async writeTuples(tuples: AuthzRelationTuple[]): Promise<void> {
        writeCalls.push(tuples);
      },
      async deleteTuples(): Promise<void> {},
    } satisfies OpenFgaWriteClient;
    const authz = new OpenFgaAuthorizationAdapter({
      apiUrl: "http://openfga.test",
      storeId: "store",
      client,
    });
    const tuples = [
      {
        user: "user:node-1/alice",
        relation: "reader",
        object: "billing_account:node-1/account-1",
      },
      {
        user: "agent:node-1/coder",
        relation: "delegate",
        object: "billing_account:node-1/account-1",
      },
    ] satisfies AuthzRelationTuple[];

    await expect(
      authz.writeRelations(tuples, { confirm: "higher_consistency" })
    ).resolves.toEqual({
      decision: "success",
      code: "authz_write_success",
    });
    expect(writeCalls).toEqual([tuples]);
    expect(checks).toEqual(
      tuples.map((tuple) => ({
        request: tuple,
        options: { consistency: "HIGHER_CONSISTENCY" },
      }))
    );
  });

  it("atomically replaces a conditioned tuple key, including a shorter expiry", async () => {
    const replacements: unknown[] = [];
    const client = {
      async check(): Promise<{ allowed: boolean }> {
        return { allowed: true };
      },
      async write(body: unknown, options: unknown): Promise<void> {
        replacements.push({ body, options });
      },
      async writeTuples(): Promise<void> {},
      async deleteTuples(): Promise<void> {},
    } satisfies OpenFgaWriteClient;
    const authz = new OpenFgaAuthorizationAdapter({
      apiUrl: "http://openfga.test",
      storeId: "store",
      client,
    });
    const originalTuple = {
      user: authzNodeAgentPrincipal("node-1", "reader"),
      relation: "reader",
      object: authzBillingAccountResource("node-1", "acct-1"),
      condition: authzGrantExpiresAt("2026-11-01T00:00:00.000Z"),
    } satisfies AuthzRelationTuple;
    const shorterTuple = {
      user: originalTuple.user,
      relation: originalTuple.relation,
      object: originalTuple.object,
      condition: authzGrantExpiresAt("2026-10-10T00:00:00.000Z"),
    } satisfies AuthzRelationTuple;

    await expect(
      authz.replaceRelation(originalTuple, { confirm: "higher_consistency" })
    ).resolves.toEqual({
      decision: "success",
      code: "authz_write_success",
    });
    await expect(
      authz.replaceRelation(shorterTuple, { confirm: "higher_consistency" })
    ).resolves.toEqual({
      decision: "success",
      code: "authz_write_success",
    });
    expect(replacements).toEqual([
      {
        body: {
          deletes: [
            {
              user: originalTuple.user,
              relation: originalTuple.relation,
              object: originalTuple.object,
            },
          ],
          writes: [originalTuple],
        },
        options: {
          conflict: {
            onDuplicateWrites: "error",
            onMissingDeletes: "ignore",
          },
        },
      },
      {
        body: {
          deletes: [
            {
              user: shorterTuple.user,
              relation: shorterTuple.relation,
              object: shorterTuple.object,
            },
          ],
          writes: [shorterTuple],
        },
        options: {
          conflict: {
            onDuplicateWrites: "error",
            onMissingDeletes: "ignore",
          },
        },
      },
    ]);
  });

  it("confirms writes and revokes through higher-consistency checks", async () => {
    let relationPresent = false;
    const checks: Array<{
      request: OpenFgaCheckRequest;
      options: OpenFgaCheckOptions | undefined;
    }> = [];
    const written: AuthzRelationTuple[] = [];
    const deleted: Array<
      Pick<AuthzRelationTuple, "user" | "relation" | "object">
    > = [];
    const client = {
      async check(
        request: OpenFgaCheckRequest,
        options?: OpenFgaCheckOptions
      ): Promise<{ allowed: boolean }> {
        checks.push({ request, options });
        return { allowed: relationPresent };
      },
      async writeTuples(tuples: AuthzRelationTuple[]): Promise<void> {
        written.push(...tuples);
        relationPresent = true;
      },
      async deleteTuples(
        tuples: Array<Pick<AuthzRelationTuple, "user" | "relation" | "object">>
      ): Promise<void> {
        deleted.push(...tuples);
        relationPresent = false;
      },
    } satisfies OpenFgaWriteClient;
    const now = new Date("2026-10-09T22:00:00.000Z");
    const authz = new OpenFgaAuthorizationAdapter({
      apiUrl: "http://openfga.test",
      storeId: "store",
      client,
      now: () => now,
    });
    const tuple = {
      user: authzNodeAgentPrincipal("node-1", "reader"),
      relation: "reader",
      object: authzBillingAccountResource("node-1", "acct-1"),
      condition: authzGrantExpiresAt("2026-11-01T00:00:00.000Z"),
    } satisfies AuthzRelationTuple;

    await expect(
      authz.writeRelation(tuple, { confirm: "higher_consistency" })
    ).resolves.toMatchObject({
      decision: "success",
      code: "authz_write_success",
    });
    await expect(
      authz.deleteRelation(tuple, { confirm: "higher_consistency" })
    ).resolves.toMatchObject({
      decision: "success",
      code: "authz_write_success",
    });

    expect(written).toEqual([tuple]);
    expect(deleted).toEqual([
      {
        user: tuple.user,
        relation: tuple.relation,
        object: tuple.object,
      },
    ]);
    expect(checks).toEqual([
      {
        request: {
          user: tuple.user,
          relation: tuple.relation,
          object: tuple.object,
          context: { current_time: now.toISOString() },
        },
        options: { consistency: "HIGHER_CONSISTENCY" },
      },
      {
        request: {
          user: tuple.user,
          relation: tuple.relation,
          object: tuple.object,
          context: { current_time: now.toISOString() },
        },
        options: { consistency: "HIGHER_CONSISTENCY" },
      },
    ]);
  });

  it("fails closed when higher-consistency confirmation disagrees", async () => {
    const client = {
      async check(): Promise<{ allowed: boolean }> {
        return { allowed: false };
      },
      async writeTuples(): Promise<void> {},
      async deleteTuples(): Promise<void> {},
    } satisfies OpenFgaWriteClient;
    const authz = new OpenFgaAuthorizationAdapter({
      apiUrl: "http://openfga.test",
      storeId: "store",
      client,
    });
    const tuple = {
      user: authzNodeAgentPrincipal("node-1", "reader"),
      relation: "reader",
      object: authzBillingAccountResource("node-1", "acct-1"),
    };

    await expect(
      authz.writeRelation(tuple, { confirm: "higher_consistency" })
    ).resolves.toMatchObject({
      decision: "failure",
      code: "authz_write_unavailable",
      reason: expect.stringContaining("confirmation mismatch"),
    });
  });

  const retryTuple = {
    user: "user:agent-1",
    relation: "developer",
    object: "node:node-1",
  };

  it("retries a transient transport failure (no HTTP status) and succeeds", async () => {
    let attempts = 0;
    const client = {
      async check(): Promise<{ allowed: boolean }> {
        return { allowed: true };
      },
      async writeTuples(): Promise<void> {
        attempts += 1;
        if (attempts === 1) throw new Error("ECONNRESET"); // no status → transient
      },
      async deleteTuples(): Promise<void> {},
    } satisfies OpenFgaWriteClient;

    const authz = new OpenFgaAuthorizationAdapter({
      apiUrl: "http://openfga.test",
      storeId: "store",
      client,
      writeMaxRetries: 2,
      writeRetryBackoffMs: 0,
    });

    await expect(authz.writeRelation(retryTuple)).resolves.toMatchObject({
      decision: "success",
      code: "authz_write_success",
    });
    expect(attempts).toBe(2);
  });

  it("does NOT retry its own timeout — a timed-out write is still in flight, retry would race it (bug.5082)", async () => {
    let attempts = 0;
    const client = {
      async check(): Promise<{ allowed: boolean }> {
        return { allowed: true };
      },
      async writeTuples(): Promise<void> {
        attempts += 1;
        // The write exceeds the 10ms deadline. `withTimeout` abandons — never cancels — this
        // request, so a retry would issue the identical tuple concurrently → 409. Fail closed
        // instead; the cure for cold-path latency is a generous deadline, not a racing retry.
        await new Promise((r) => setTimeout(r, 40));
      },
      async deleteTuples(): Promise<void> {},
    } satisfies OpenFgaWriteClient;

    const authz = new OpenFgaAuthorizationAdapter({
      apiUrl: "http://openfga.test",
      storeId: "store",
      client,
      writeTimeoutMs: 10,
      writeMaxRetries: 2,
      writeRetryBackoffMs: 0,
    });

    await expect(authz.writeRelation(retryTuple)).resolves.toMatchObject({
      decision: "failure",
      code: "authz_write_unavailable",
    });
    expect(attempts).toBe(1); // no racing retry
  });

  it("retries a 409 serialization conflict and succeeds on the clean retry — never assumes the end-state (bug.5082)", async () => {
    let attempts = 0;
    const client = {
      async check(): Promise<{ allowed: boolean }> {
        return { allowed: true };
      },
      async writeTuples(): Promise<void> {
        attempts += 1;
        // The self-race conflict; the retry runs cleanly (the racing writer has committed →
        // onDuplicateWrites:ignore no-ops it here).
        if (attempts === 1)
          throw Object.assign(new Error("write conflict"), { statusCode: 409 });
      },
      async deleteTuples(): Promise<void> {},
    } satisfies OpenFgaWriteClient;

    const authz = new OpenFgaAuthorizationAdapter({
      apiUrl: "http://openfga.test",
      storeId: "store",
      client,
      writeMaxRetries: 2,
      writeRetryBackoffMs: 0,
    });

    await expect(authz.writeRelation(retryTuple)).resolves.toMatchObject({
      decision: "success",
      code: "authz_write_success",
    });
    expect(attempts).toBe(2); // 409 retried, not assumed-success
  });

  it("a persistent 409 delete fails CLOSED — a revoke never reports a false success (bug.5082)", async () => {
    let attempts = 0;
    const client = {
      async check(): Promise<{ allowed: boolean }> {
        return { allowed: true };
      },
      async writeTuples(): Promise<void> {},
      async deleteTuples(): Promise<void> {
        attempts += 1;
        throw Object.assign(new Error("write conflict"), { statusCode: 409 });
      },
    } satisfies OpenFgaWriteClient;

    const authz = new OpenFgaAuthorizationAdapter({
      apiUrl: "http://openfga.test",
      storeId: "store",
      client,
      writeMaxRetries: 2,
      writeRetryBackoffMs: 0,
    });

    // Assuming a 409-delete converged to "absent" would fail OPEN (privilege retained while the
    // UI says revoked). Exhausted retries must surface unavailable, not a fabricated success.
    await expect(authz.deleteRelation(retryTuple)).resolves.toMatchObject({
      decision: "failure",
      code: "authz_write_unavailable",
    });
    expect(attempts).toBe(3); // initial + 2 retries, then fail closed
  });

  it("retries the delete path too", async () => {
    let attempts = 0;
    const client = {
      async check(): Promise<{ allowed: boolean }> {
        return { allowed: true };
      },
      async writeTuples(): Promise<void> {},
      async deleteTuples(): Promise<void> {
        attempts += 1;
        if (attempts === 1)
          throw Object.assign(new Error("upstream"), { status: 502 });
      },
    } satisfies OpenFgaWriteClient;

    const authz = new OpenFgaAuthorizationAdapter({
      apiUrl: "http://openfga.test",
      storeId: "store",
      client,
      writeMaxRetries: 2,
      writeRetryBackoffMs: 0,
    });

    await expect(authz.deleteRelation(retryTuple)).resolves.toMatchObject({
      decision: "success",
      code: "authz_write_success",
    });
    expect(attempts).toBe(2);
  });

  it("does NOT retry checks (reads stay fail-closed-fast) — guards the writes-only design", async () => {
    let checks = 0;
    const client = {
      async check(): Promise<{ allowed: boolean }> {
        checks += 1;
        throw Object.assign(new Error("upstream"), { status: 503 });
      },
    } satisfies OpenFgaCheckClient;

    const authz = new OpenFgaAuthorizationAdapter({
      apiUrl: "http://openfga.test",
      storeId: "store",
      client,
      writeMaxRetries: 2,
      writeRetryBackoffMs: 0,
    });

    await expect(authz.check(baseCheck)).resolves.toMatchObject({
      decision: "deny",
      code: "authz_unavailable",
    });
    expect(checks).toBe(1); // no retry on the hot path
  });

  it("does NOT retry a deterministic 4xx (fails fast)", async () => {
    let attempts = 0;
    const client = {
      async check(): Promise<{ allowed: boolean }> {
        return { allowed: true };
      },
      async writeTuples(): Promise<void> {
        attempts += 1;
        throw Object.assign(new Error("validation_error"), { status: 400 });
      },
      async deleteTuples(): Promise<void> {},
    } satisfies OpenFgaWriteClient;

    const authz = new OpenFgaAuthorizationAdapter({
      apiUrl: "http://openfga.test",
      storeId: "store",
      client,
      writeMaxRetries: 2,
      writeRetryBackoffMs: 0,
    });

    await expect(authz.writeRelation(retryTuple)).resolves.toMatchObject({
      decision: "failure",
      code: "authz_write_unavailable",
    });
    expect(attempts).toBe(1);
  });

  it("exhausts retries on a persistent transient failure", async () => {
    let attempts = 0;
    const client = {
      async check(): Promise<{ allowed: boolean }> {
        return { allowed: true };
      },
      async writeTuples(): Promise<void> {
        attempts += 1;
        throw Object.assign(new Error("upstream"), { status: 503 });
      },
      async deleteTuples(): Promise<void> {},
    } satisfies OpenFgaWriteClient;

    const authz = new OpenFgaAuthorizationAdapter({
      apiUrl: "http://openfga.test",
      storeId: "store",
      client,
      writeMaxRetries: 2,
      writeRetryBackoffMs: 0,
    });

    await expect(authz.writeRelation(retryTuple)).resolves.toMatchObject({
      decision: "failure",
      code: "authz_write_unavailable",
    });
    expect(attempts).toBe(3); // initial + 2 retries
  });
});

describe("OpenFGA write deadline", () => {
  // bug: approving a developer on a freshly spawned node returned
  // authz_write_unavailable because all three write attempts shared the 1500ms
  // deadline tuned for the hot-path check. The write is cold-path and must not fail
  // a human's one-and-only click; the check must stay fast. Pin both halves.
  const tuple = {
    user: "user:u1",
    relation: "developer",
    object: "node:n1",
  } as never;

  it("gives writes a longer deadline than checks by default", async () => {
    const adapter = new OpenFgaAuthorizationAdapter({
      writeMaxRetries: 0,
      client: {
        async check(): Promise<{ allowed: boolean }> {
          return { allowed: true };
        },
        // Settles after the 1500ms CHECK deadline but inside the 5000ms WRITE one.
        writeTuples: () =>
          new Promise((_resolve, reject) => {
            setTimeout(() => reject(new Error("late")), 2_500);
          }),
        async deleteTuples(): Promise<void> {},
      } as never,
    });
    const decision = await adapter.writeRelation(tuple);
    // It must have been allowed to run past 1500ms rather than being cut at it.
    expect(decision.code).toBe("authz_write_unavailable");
    expect(decision.reason).toContain("late");
    expect(decision.reason).not.toContain("timed out after 1500ms");
  });

  it("honours an explicit writeTimeoutMs", async () => {
    const adapter = new OpenFgaAuthorizationAdapter({
      writeMaxRetries: 0,
      writeTimeoutMs: 50,
      client: {
        async check(): Promise<{ allowed: boolean }> {
          return { allowed: true };
        },
        writeTuples: () => new Promise(() => {}),
        async deleteTuples(): Promise<void> {},
      } as never,
    });
    const decision = await adapter.writeRelation(tuple);
    expect(decision.code).toBe("authz_write_unavailable");
    expect(decision.reason).toContain("timed out after 50ms");
  });
});
