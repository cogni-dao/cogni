// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/app/node-admin-gates.route`
 * Purpose: Prove the three DAO-goal privileges (task.5286, task.5294) are node-admin actions on the
 *   HTTP routes: (a) POST /api/v1/goals, (b) merging a contribution whose RAW changed rows touch a
 *   `goal-*` row, (c) setting any work-item priority <= 1 on create or patch.
 * Scope: Drives the real route handlers with the deterministic FakeAuthorizationAdapter behind a
 *   mocked container. (b) runs the REAL ContributionService + goal-merge authorizer over a fake
 *   contribution port; no network, OpenFGA or database.
 * Invariants:
 *   - GOAL_CHANGE_IS_NODE_ADMIN / P0P1_IS_NODE_ADMIN: a non-admin gets 403 `authz_denied`, the
 *     `admin` tuple holder succeeds.
 *   - CHECK_BEFORE_SIDE_EFFECT: on deny/unavailable the write (startGoal / merge / store) never runs.
 *   - FAIL_CLOSED_WITH_DISTINCTION: OpenFGA unavailable → 503 `authz_unavailable`, never 403.
 *   - UNCHANGED_OUTSIDE_THE_GATE: priority 2 and non-goal merges never consult authorization.
 *   - MERGE_AUTHORIZED_ON_RAW_ROWS: a goal change the display diff hides (tags-only) is still gated,
 *     a citation INTO a goal is not, and the merge is bound to the authorized head.
 *   - PRIORITY_RANGE: a negative priority from a non-admin is 403; out of 0..99 otherwise is 400.
 * Side-effects: none
 * Links: src/bootstrap/node-admin-gate.ts, task.5286
 * @internal
 */

import {
  type AuthorizationPort,
  FakeAuthorizationAdapter,
} from "@cogni/authorization-core";
import {
  type ContributionChangedRows,
  type ContributionService,
  createContributionService,
  defaultCanMergeKnowledge,
  type KnowledgeContributionPort,
} from "@cogni/knowledge-store";
import { TEST_SESSION_USER_1, TEST_SESSION_USER_2 } from "@tests/_fakes/ids";
import { testApiHandler } from "next-test-api-route-handler";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as session from "@/app/_lib/auth/session";
import * as goalsHandler from "@/app/api/v1/goals/route";
import * as mergeHandler from "@/app/api/v1/knowledge/contributions/[id]/merge/route";
import * as byIdHandler from "@/app/api/v1/work/items/[id]/route";
import * as createHandler from "@/app/api/v1/work/items/route";
import { createGoalMergeAuthorizer } from "@/bootstrap/node-admin-gate";
import { getNodeId } from "@/shared/config/repoSpec.server";

const h = vi.hoisted(() => ({
  authz: { current: undefined as unknown },
  createMock: vi.fn(),
  patchMock: vi.fn(),
  diffMock: vi.fn(),
  changedRowsMock: vi.fn(),
  mergeMock: vi.fn(),
  startGoalMock: vi.fn(),
  warnMock: vi.fn(),
  service: { current: undefined as unknown },
}));

vi.mock("@/bootstrap/container", () => {
  const log = {
    child: vi.fn(() => log),
    info: vi.fn(),
    error: vi.fn(),
    warn: h.warnMock,
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
      knowledgeContributionService: h.service.current,
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
    h.changedRowsMock,
    h.mergeMock,
    h.startGoalMock,
    h.warnMock,
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
  h.diffMock.mockResolvedValue([]);
  // The REAL service + REAL goal-merge authorizer over a fake contribution port.
  const port = {
    diff: h.diffMock,
    changedRows: h.changedRowsMock,
    merge: h.mergeMock,
  } as unknown as KnowledgeContributionPort;
  h.service.current = createContributionService({
    port,
    canMergeKnowledge: defaultCanMergeKnowledge,
    authorizeMerge: createGoalMergeAuthorizer({
      authorization: () => h.authz.current as AuthorizationPort | undefined,
      nodeId: getNodeId(),
      log: { warn: h.warnMock },
    }),
  }) satisfies ContributionService;
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

describe("(b) merging a goal-* change is node-admin (inside ContributionService.merge)", () => {
  const rows = (
    over: Partial<ContributionChangedRows> = {}
  ): ContributionChangedRows => ({
    headCommit: "head-authorized",
    knowledgeIds: [],
    citingIds: [],
    citedIds: [],
    ...over,
  });
  const goalRows = rows({ knowledgeIds: ["goal-authz-probe"] });

  async function merge(
    headers: Record<string, string> = {}
  ): Promise<{ status: number; json: unknown }> {
    let out = { status: 0, json: {} as unknown };
    await testApiHandler({
      appHandler: mergeHandler,
      params: { id: "contrib-x" },
      async test({ fetch }) {
        const res = await fetch({ method: "POST", body: "{}", headers });
        out = { status: res.status, json: await res.json() };
      },
    });
    return out;
  }

  it("denies a non-admin session with 403 authz_denied, logs it and never merges", async () => {
    as(NON_ADMIN);
    h.changedRowsMock.mockResolvedValue(goalRows);
    const res = await merge();
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({
      errorCode: "authz_denied",
      action: "knowledge.contributions.merge.goal",
    });
    expect(h.mergeMock).not.toHaveBeenCalled();
    expect(h.warnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "knowledge.contributions.merge.goal_denied",
        errorCode: "authz_denied",
        actor: NON_ADMIN.id,
        goalIds: ["goal-authz-probe"],
      }),
      "knowledge.contributions.merge.goal_denied"
    );
  });

  it("gates a tags-only goal update that the display diff hides (raw rows, not diff())", async () => {
    as(NON_ADMIN);
    h.diffMock.mockResolvedValue([]); // the bug.5004 filter drops it from the display
    h.changedRowsMock.mockResolvedValue(goalRows);
    expect((await merge()).status).toBe(403);
    expect(h.mergeMock).not.toHaveBeenCalled();
  });

  it("gates a citation edge leaving a goal row", async () => {
    as(NON_ADMIN);
    h.changedRowsMock.mockResolvedValue(
      rows({ citingIds: ["goal-x"], citedIds: ["y"] })
    );
    expect((await merge()).status).toBe(403);
    expect(h.mergeMock).not.toHaveBeenCalled();
  });

  it("does not gate a citation INTO a goal (a decision may derive from one)", async () => {
    as(NON_ADMIN);
    h.authz.current = undefined;
    h.changedRowsMock.mockResolvedValue(
      rows({
        knowledgeIds: ["decision-x"],
        citingIds: ["decision-x"],
        citedIds: ["goal-x"],
      })
    );
    expect((await merge()).status).toBe(200);
    expect(h.mergeMock).toHaveBeenCalledTimes(1);
  });

  it("denies a bearer agent's goal merge with 403 authz_denied before the session check", async () => {
    as(NON_ADMIN);
    h.changedRowsMock.mockResolvedValue(goalRows);
    const res = await merge({ authorization: "Bearer cogni_ag_sk_test" });
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ errorCode: "authz_denied" });
    expect(h.mergeMock).not.toHaveBeenCalled();
  });

  it("lets the node admin merge a goal change, bound to the authorized head", async () => {
    as(ADMIN);
    h.changedRowsMock.mockResolvedValue(goalRows);
    const res = await merge();
    expect(res.status).toBe(200);
    expect(h.mergeMock).toHaveBeenCalledTimes(1);
    expect(h.mergeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        contributionId: "contrib-x",
        expectedHeadCommit: "head-authorized",
      })
    );
  });

  it("leaves non-goal merges unchanged (no authorization consulted)", async () => {
    as(NON_ADMIN);
    h.authz.current = undefined;
    h.changedRowsMock.mockResolvedValue(rows({ knowledgeIds: ["some-guide"] }));
    const res = await merge();
    expect(res.status).toBe(200);
    expect(h.mergeMock).toHaveBeenCalledTimes(1);
  });

  it("answers 503 authz_unavailable for a goal merge when OpenFGA is unconfigured", async () => {
    as(ADMIN);
    h.authz.current = undefined;
    h.changedRowsMock.mockResolvedValue(goalRows);
    const res = await merge();
    expect(res.status).toBe(503);
    expect(res.json).toMatchObject({ errorCode: "authz_unavailable" });
    expect(h.mergeMock).not.toHaveBeenCalled();
  });
});

describe("(c) priority <= 1 is node-admin on create and patch", () => {
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
          body: JSON.stringify({ type: "task", title: "gated", priority }),
        });
        status = res.status;
        json = await res.json();
      },
    });
    return { status, json };
  }

  it.each([
    -1, 0, 1,
  ])("denies a non-admin priority %i patch and create with 403 authz_denied, writing nothing", async (priority) => {
    as(NON_ADMIN);
    const p = await patch(priority);
    const c = await create(priority);
    expect(p.status).toBe(403);
    expect(p.json).toMatchObject({ errorCode: "authz_denied" });
    expect(c.status).toBe(403);
    expect(c.json).toMatchObject({ errorCode: "authz_denied" });
    expect(h.patchMock).not.toHaveBeenCalled();
    expect(h.createMock).not.toHaveBeenCalled();
  });

  it("lets a non-admin set priority 2 without consulting authorization", async () => {
    as(NON_ADMIN);
    h.authz.current = undefined;
    h.patchMock.mockResolvedValue(storedItem(2));
    h.createMock.mockResolvedValue(storedItem(2));
    expect((await patch(2)).status).toBe(200);
    expect((await create(2)).status).toBe(201);
  });

  it("lets the node admin set priority 0 on patch and create", async () => {
    as(ADMIN);
    expect((await patch(0)).status).toBe(200);
    expect((await create(0)).status).toBe(201);
    expect(h.patchMock).toHaveBeenCalledTimes(1);
    expect(h.createMock).toHaveBeenCalledTimes(1);
  });

  it("answers 503 authz_unavailable (not 403) when OpenFGA is unavailable", async () => {
    as(ADMIN);
    (h.authz.current as FakeAuthorizationAdapter).unavailable(
      checkParams(ADMIN.id)
    );
    const p = await patch(1);
    expect(p.status).toBe(503);
    expect(p.json).toMatchObject({ errorCode: "authz_unavailable" });
    expect(h.patchMock).not.toHaveBeenCalled();
  });

  it("answers 400 for priority 100 (out of 0..99) without consulting authorization", async () => {
    as(NON_ADMIN);
    h.authz.current = undefined;
    expect((await patch(100)).status).toBe(400);
    expect((await create(100)).status).toBe(400);
    expect(h.patchMock).not.toHaveBeenCalled();
    expect(h.createMock).not.toHaveBeenCalled();
  });

  it("answers 400 (not a write) when the node admin sends a negative priority", async () => {
    as(ADMIN);
    expect((await patch(-1)).status).toBe(400);
    expect((await create(-1)).status).toBe(400);
    expect(h.patchMock).not.toHaveBeenCalled();
    expect(h.createMock).not.toHaveBeenCalled();
  });
});
