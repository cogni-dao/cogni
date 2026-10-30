// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/app/node-admin-gates.route`
 * Purpose: Prove the two DAO-goal privileges (task.5286) are node-admin actions on the HTTP routes:
 *   (a) POST /api/v1/goals, (b) merging a contribution that touches a `goal-*` row; and (c) that
 *   work-item priority 0/1 is NOT gated on create or patch (task.5306).
 * Scope: Drives the real route handlers with the deterministic FakeAuthorizationAdapter behind a
 *   mocked container; no network, OpenFGA or database.
 * Invariants:
 *   - GOAL_CHANGE_IS_NODE_ADMIN: a non-admin gets 403 `authz_denied`, the `admin` tuple holder
 *     succeeds.
 *   - CHECK_BEFORE_SIDE_EFFECT: on deny/unavailable the write (startGoal / merge / store) never runs.
 *   - FAIL_CLOSED_WITH_DISTINCTION: OpenFGA unavailable → 503 `authz_unavailable`, never 403.
 *   - UNCHANGED_OUTSIDE_THE_GATE: non-goal merges and every work-item priority never consult
 *     authorization (task.5306 removed the bespoke p0/p1 guard).
 * Side-effects: none
 * Links: src/bootstrap/node-admin-gate.ts, task.5286, task.5306
 * @internal
 */

import { FakeAuthorizationAdapter } from "@cogni/authorization-core";
import { TEST_SESSION_USER_1, TEST_SESSION_USER_2 } from "@tests/_fakes/ids";
import { testApiHandler } from "next-test-api-route-handler";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as session from "@/app/_lib/auth/session";
import * as goalsHandler from "@/app/api/v1/goals/route";
import * as mergeHandler from "@/app/api/v1/knowledge/contributions/[id]/merge/route";
import * as byIdHandler from "@/app/api/v1/work/items/[id]/route";
import * as createHandler from "@/app/api/v1/work/items/route";
import { getNodeId } from "@/shared/config/repoSpec.server";

const h = vi.hoisted(() => ({
  authz: { current: undefined as unknown },
  createMock: vi.fn(),
  patchMock: vi.fn(),
  diffMock: vi.fn(),
  mergeMock: vi.fn(),
  startGoalMock: vi.fn(),
}));

vi.mock("@/bootstrap/container", () => {
  const log = {
    child: vi.fn(() => log),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };
  return {
    getContainer: vi.fn(() => ({
      log,
      clock: { now: vi.fn(() => new Date("2026-10-21T00:00:00Z")) },
      config: { unhandledErrorPolicy: "respond_500" },
      authorization: h.authz.current,
      edoCapability: {},
      workItemQuery: { list: vi.fn(), get: vi.fn() },
      doltgresWorkItems: {
        list: vi.fn(),
        get: vi.fn(),
        create: h.createMock,
        patch: h.patchMock,
        delete: vi.fn(),
      },
      knowledgeContributionService: {
        diff: h.diffMock,
        merge: h.mergeMock,
      },
    })),
    getTemporalWorkflowClient: vi.fn(async () => ({
      client: {},
      taskQueue: "test-queue",
    })),
  };
});

vi.mock("@/app/_facades/goal-loop/start.server", () => ({
  startGoal: h.startGoalMock,
}));

vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: vi.fn(),
}));

vi.mock("@/shared/config/repoSpec.server", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getNodeId: () => "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d",
}));

const ADMIN = TEST_SESSION_USER_1;
const NON_ADMIN = TEST_SESSION_USER_2;

function checkParams(userId: string) {
  const nodeId = getNodeId();
  return {
    actorId: `user:${userId}`,
    action: "node.administer" as const,
    resource: `node:${nodeId}`,
    context: { tenantId: nodeId, nodeId },
  };
}

function storedItem(priority: number) {
  return {
    id: "task.5286",
    type: "task",
    title: "gated",
    status: "needs_implement",
    priority,
    node: "operator",
    assignees: [],
    externalRefs: [],
    actor: "either",
    labels: [],
    specRefs: [],
    revision: 2,
    deployVerified: false,
    createdAt: "2026-10-21T00:00:00.000Z",
    updatedAt: "2026-10-21T00:00:00.000Z",
  };
}

const GOAL_BODY = JSON.stringify({
  statement: "Ship the goal gate",
  criterion: "403 for non-admins",
  domain: "strategy",
});

beforeEach(async () => {
  for (const m of [
    h.createMock,
    h.patchMock,
    h.diffMock,
    h.mergeMock,
    h.startGoalMock,
  ])
    m.mockReset();
  const authz = new FakeAuthorizationAdapter();
  await authz.writeRelation({
    user: `user:${ADMIN.id}`,
    relation: "admin",
    object: `node:${getNodeId()}`,
  });
  h.authz.current = authz;
  h.startGoalMock.mockResolvedValue({ goalId: "hyp-1", workflowId: "wf-1" });
  h.mergeMock.mockResolvedValue({ commitHash: "abc123" });
  h.createMock.mockResolvedValue(storedItem(0));
  h.patchMock.mockResolvedValue(storedItem(0));
});

function as(user: typeof ADMIN) {
  vi.mocked(session.getSessionUser).mockResolvedValue(user);
}

describe("(a) POST /api/v1/goals is node-admin", () => {
  it("denies a non-admin with 403 authz_denied before starting anything", async () => {
    as(NON_ADMIN);
    await testApiHandler({
      appHandler: goalsHandler,
      async test({ fetch }) {
        const res = await fetch({ method: "POST", body: GOAL_BODY });
        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({ errorCode: "authz_denied" });
      },
    });
    expect(h.startGoalMock).not.toHaveBeenCalled();
  });

  it("lets the node admin start a goal", async () => {
    as(ADMIN);
    await testApiHandler({
      appHandler: goalsHandler,
      async test({ fetch }) {
        const res = await fetch({ method: "POST", body: GOAL_BODY });
        expect(res.status).toBe(201);
      },
    });
    expect(h.startGoalMock).toHaveBeenCalledTimes(1);
  });

  it("answers 503 authz_unavailable when OpenFGA is unavailable or unconfigured", async () => {
    as(ADMIN);
    (h.authz.current as FakeAuthorizationAdapter).unavailable(
      checkParams(ADMIN.id)
    );
    await testApiHandler({
      appHandler: goalsHandler,
      async test({ fetch }) {
        const res = await fetch({ method: "POST", body: GOAL_BODY });
        expect(res.status).toBe(503);
        expect(await res.json()).toMatchObject({
          errorCode: "authz_unavailable",
        });
      },
    });
    h.authz.current = undefined;
    await testApiHandler({
      appHandler: goalsHandler,
      async test({ fetch }) {
        const res = await fetch({ method: "POST", body: GOAL_BODY });
        expect(res.status).toBe(503);
      },
    });
    expect(h.startGoalMock).not.toHaveBeenCalled();
  });
});

describe("(b) merging a goal-* change is node-admin", () => {
  const goalDiff = [
    { changeType: "added", rowId: "goal-authz-probe", before: null, after: {} },
  ];
  const plainDiff = [
    { changeType: "added", rowId: "some-guide", before: null, after: {} },
  ];

  async function merge(): Promise<{ status: number; json: unknown }> {
    let out = { status: 0, json: {} as unknown };
    await testApiHandler({
      appHandler: mergeHandler,
      params: { id: "contrib-x" },
      async test({ fetch }) {
        const res = await fetch({ method: "POST", body: "{}" });
        out = { status: res.status, json: await res.json() };
      },
    });
    return out;
  }

  it("denies a non-admin session with 403 authz_denied and never merges", async () => {
    as(NON_ADMIN);
    h.diffMock.mockResolvedValue(goalDiff);
    const res = await merge();
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ errorCode: "authz_denied" });
    expect(h.mergeMock).not.toHaveBeenCalled();
  });

  it("gates a citation edge leaving a goal row too", async () => {
    as(NON_ADMIN);
    h.diffMock.mockResolvedValue([
      {
        changeType: "citation_added",
        rowId: "cite-1",
        before: null,
        after: { citingId: "goal-x", citedId: "y", citationType: "extends" },
      },
    ]);
    expect((await merge()).status).toBe(403);
    expect(h.mergeMock).not.toHaveBeenCalled();
  });

  it("lets the node admin merge a goal change", async () => {
    as(ADMIN);
    h.diffMock.mockResolvedValue(goalDiff);
    const res = await merge();
    expect(res.status).toBe(200);
    expect(h.mergeMock).toHaveBeenCalledTimes(1);
  });

  it("leaves non-goal merges unchanged (no authorization consulted)", async () => {
    as(NON_ADMIN);
    h.authz.current = undefined;
    h.diffMock.mockResolvedValue(plainDiff);
    const res = await merge();
    expect(res.status).toBe(200);
    expect(h.mergeMock).toHaveBeenCalledTimes(1);
  });

  it("answers 503 authz_unavailable for a goal merge when OpenFGA is unconfigured", async () => {
    as(ADMIN);
    h.authz.current = undefined;
    h.diffMock.mockResolvedValue(goalDiff);
    const res = await merge();
    expect(res.status).toBe(503);
    expect(res.json).toMatchObject({ errorCode: "authz_unavailable" });
    expect(h.mergeMock).not.toHaveBeenCalled();
  });
});

describe("(c) work-item priority is not node-admin (task.5306)", () => {
  async function patch(priority: number) {
    let status = 0;
    let json: unknown;
    await testApiHandler({
      appHandler: byIdHandler,
      params: { id: "task.5286" },
      async test({ fetch }) {
        const res = await fetch({
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ set: { priority } }),
        });
        status = res.status;
        json = await res.json();
      },
    });
    return { status, json };
  }

  async function create(priority: number) {
    let status = 0;
    let json: unknown;
    await testApiHandler({
      appHandler: createHandler,
      async test({ fetch }) {
        const res = await fetch({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "task", title: "ungated", priority }),
        });
        status = res.status;
        json = await res.json();
      },
    });
    return { status, json };
  }

  it.each([
    0, 1,
  ])("lets a non-admin set priority %i on patch and create without consulting authorization", async (priority) => {
    as(NON_ADMIN);
    h.authz.current = undefined;
    h.patchMock.mockResolvedValue(storedItem(priority));
    h.createMock.mockResolvedValue(storedItem(priority));
    const p = await patch(priority);
    const c = await create(priority);
    expect(p.status).toBe(200);
    expect(p.json).toMatchObject({ priority });
    expect(c.status).toBe(201);
    expect(h.patchMock).toHaveBeenCalledTimes(1);
    expect(h.createMock).toHaveBeenCalledTimes(1);
  });
});
