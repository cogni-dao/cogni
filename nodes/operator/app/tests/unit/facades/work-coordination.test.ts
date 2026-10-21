// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/facades/work-coordination`
 * Purpose: Unit tests for the work-item coordination facade.
 * Scope: Mocks container and work item facade; verifies port delegation,
 *   conflict output, ownership enforcement, and durable PR patching.
 * Invariants: PORT_VIA_CONTAINER, DURABLE_PR_LINK_ON_WORK_ITEM.
 * Side-effects: none
 * Links: src/app/_facades/work/coordination.server.ts, task.5007
 * @internal
 */

import type { WorkItemDto } from "@cogni/node-contracts";
import type { SessionUser } from "@cogni/node-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkItemSessionPort, WorkItemSessionRecord } from "@/ports";

vi.mock("@/bootstrap/container", () => ({
  getContainer: vi.fn(),
  getWorkItemSessionPort: vi.fn(),
}));
vi.mock("@/app/_facades/work/items.server", () => ({
  getWorkItem: vi.fn(),
  patchWorkItem: vi.fn(),
}));

import {
  CoordinationWorkItemNotFoundError,
  claimWorkItemAsPrincipal,
  claimWorkItemSession,
  getWorkItemCoordination,
  heartbeatWorkItemAsPrincipal,
  heartbeatWorkItemSession,
  linkWorkItemSessionPr,
  WorkItemSessionForbiddenError,
  WorkItemSessionNotFoundError,
} from "@/app/_facades/work/coordination.server";
import { getWorkItem, patchWorkItem } from "@/app/_facades/work/items.server";
import { getContainer, getWorkItemSessionPort } from "@/bootstrap/container";

const NOW = new Date("2026-05-02T12:00:00.000Z");
const USER: SessionUser = {
  id: "user-1",
  displayName: "agent-one",
  walletAddress: null,
  avatarColor: null,
};

const WORK_ITEM: WorkItemDto = {
  id: "task.5007",
  type: "task",
  title: "Operator work-item coordination foundation",
  status: "needs_implement",
  node: "operator",
  assignees: [],
  externalRefs: [],
  labels: [],
  specRefs: [],
  revision: 0,
  deployVerified: false,
  createdAt: "2026-05-02T00:00:00.000Z",
  updatedAt: "2026-05-02T00:00:00.000Z",
};

function session(overrides: Partial<WorkItemSessionRecord> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000005007",
    workItemId: "task.5007",
    claimedByUserId: "user-1",
    claimedByDisplayName: "agent-one",
    status: "active",
    claimedAt: new Date("2026-05-02T11:55:00.000Z"),
    lastHeartbeatAt: null,
    deadlineAt: new Date("2026-05-02T12:30:00.000Z"),
    closedAt: null,
    lastCommand: "/implement",
    branch: null,
    prNumber: null,
    ...overrides,
  } satisfies WorkItemSessionRecord;
}

function mockPort(): WorkItemSessionPort {
  return {
    claim: vi.fn(),
    heartbeat: vi.fn(),
    linkPr: vi.fn(),
    getCurrent: vi.fn(),
  };
}

describe("app/_facades/work/coordination.server", () => {
  let port: WorkItemSessionPort;
  let doltgresWorkItems: {
    get: ReturnType<typeof vi.fn>;
    claim: ReturnType<typeof vi.fn>;
    heartbeat: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.resetAllMocks();
    port = mockPort();
    doltgresWorkItems = {
      get: vi.fn(),
      claim: vi.fn(),
      heartbeat: vi.fn(),
    };
    vi.mocked(getWorkItemSessionPort).mockReturnValue(port);
    vi.mocked(getContainer).mockReturnValue({
      workItemSessions: port,
      doltgresWorkItems,
    } as never);
    vi.mocked(getWorkItem).mockResolvedValue(WORK_ITEM);
    vi.mocked(patchWorkItem).mockResolvedValue(WORK_ITEM);
  });

  it("claims and heartbeats using the exact durable agent principal", async () => {
    const principal = {
      kind: "agent" as const,
      principalId:
        "agent:operator/00000000-0000-4000-8000-000000005264" as const,
      actorId: "00000000-0000-4000-8000-000000005264",
      credentialId: "00000000-0000-4000-8000-000000005265",
      billingAccountId: "00000000-0000-4000-8000-000000005263",
      legacyUserId: null,
      displayName: "fresh-v2",
    };
    doltgresWorkItems.claim.mockResolvedValue({
      ...WORK_ITEM,
      id: "task.5007",
      claimedByRun: "00000000-0000-4000-8000-000000005264",
      claimedAt: NOW.toISOString(),
      lastCommand: "/implement",
    });

    const claimed = await claimWorkItemAsPrincipal({
      workItemId: "task.5007",
      body: { lastCommand: "/implement" },
      principal,
      statusUrl: "/status",
      now: NOW,
    });

    expect(doltgresWorkItems.claim).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "task.5007",
        principalId: principal.principalId,
      })
    );
    expect(claimed.session.claimedByPrincipalId).toBe(principal.principalId);

    const runId = claimed.session.coordinationId;
    doltgresWorkItems.get.mockResolvedValue({
      ...WORK_ITEM,
      claimedByRun: runId,
    });
    doltgresWorkItems.heartbeat.mockResolvedValue({
      ...WORK_ITEM,
      claimedByRun: runId,
      claimedAt: NOW.toISOString(),
      lastCommand: "/review-implementation",
    });

    await heartbeatWorkItemAsPrincipal({
      workItemId: "task.5007",
      body: { lastCommand: "/review-implementation" },
      principal,
      statusUrl: "/status",
      now: NOW,
    });

    expect(doltgresWorkItems.heartbeat).toHaveBeenCalledWith({
      id: "task.5007",
      runId,
      command: "/review-implementation",
      principalId: principal.principalId,
    });
    expect(port.claim).not.toHaveBeenCalled();
    expect(port.heartbeat).not.toHaveBeenCalled();
  });

  it("claims a session for the authenticated user", async () => {
    vi.mocked(port.claim).mockResolvedValue({
      kind: "claimed",
      session: session(),
    });

    const result = await claimWorkItemSession({
      workItemId: "task.5007",
      body: { lastCommand: "/implement", ttlSeconds: 120 },
      sessionUser: USER,
      statusUrl: "/status",
      now: NOW,
    });

    expect(result.claimed).toBe(true);
    expect(result.session.deadlineAt).toBe("2026-05-02T12:30:00.000Z");
    expect(port.claim).toHaveBeenCalledWith({
      workItemId: "task.5007",
      claimedByUserId: "user-1",
      claimedByDisplayName: "agent-one",
      deadlineAt: new Date("2026-05-02T12:02:00.000Z"),
      lastCommand: "/implement",
    });
  });

  it("returns conflict details instead of hiding the active session", async () => {
    vi.mocked(port.claim).mockResolvedValue({
      kind: "conflict",
      session: session({ claimedByUserId: "user-2" }),
    });

    const result = await claimWorkItemSession({
      workItemId: "task.5007",
      body: {},
      sessionUser: USER,
      statusUrl: "/status",
      now: NOW,
    });

    expect(result).toMatchObject({
      claimed: false,
      conflict: true,
      session: { claimedByUserId: "user-2" },
    });
    expect(result.nextAction).toContain("already claimed");
  });

  it("rejects heartbeat attempts by a non-owner", async () => {
    vi.mocked(port.heartbeat).mockResolvedValue(null);
    vi.mocked(port.getCurrent).mockResolvedValue(
      session({ claimedByUserId: "user-2" })
    );

    await expect(
      heartbeatWorkItemSession({
        workItemId: "task.5007",
        body: {},
        sessionUser: USER,
        statusUrl: "/status",
        now: NOW,
      })
    ).rejects.toBeInstanceOf(WorkItemSessionForbiddenError);
  });

  it("links PR metadata to both session state and the durable work item", async () => {
    vi.mocked(port.linkPr).mockResolvedValue(
      session({ branch: "feat/session", prNumber: 1201 })
    );

    const result = await linkWorkItemSessionPr({
      workItemId: "task.5007",
      body: { branch: "feat/session", prNumber: 1201 },
      sessionUser: USER,
      statusUrl: "/status",
      now: NOW,
    });

    expect(result.session).toMatchObject({
      branch: "feat/session",
      prNumber: 1201,
    });
    expect(patchWorkItem).toHaveBeenCalledWith(
      {
        id: "task.5007",
        set: { branch: "feat/session", pr: "1201" },
      },
      { id: "user-1", displayName: "agent-one" }
    );
  });
  function failUnrelatedProviders() {
    vi.mocked(getContainer).mockImplementation(() => {
      throw new Error("full container must not be constructed");
    });
    vi.mocked(getWorkItem).mockImplementation(async () => {
      throw new Error("Dolt must not be called");
    });
  }

  it("renews the existing v1 session using only PostgreSQL while Dolt and the full container fail", async () => {
    failUnrelatedProviders();
    vi.mocked(port.heartbeat).mockResolvedValue(session());
    const output = await heartbeatWorkItemSession({
      workItemId: "task.5007",
      body: { ttlSeconds: 120 },
      sessionUser: USER,
      statusUrl: "/status",
      now: NOW,
    });
    expect(output.session.coordinationId).toBe(session().id);
    expect(output.nextAction).toContain("GET /api/v1/work/items/task.5007");
    expect(port.heartbeat).toHaveBeenCalledWith({
      workItemId: "task.5007",
      claimedByUserId: USER.id,
      deadlineAt: new Date("2026-05-02T12:02:00.000Z"),
    });
    expect(getContainer).not.toHaveBeenCalled();
    expect(getWorkItem).not.toHaveBeenCalled();
  });

  it.each([
    "active",
    "closed",
  ] as const)("recovers a persisted %s session without reading content or constructing providers", async (status) => {
    failUnrelatedProviders();
    vi.mocked(port.getCurrent).mockResolvedValue(session({ status }));
    const output = await getWorkItemCoordination({
      workItemId: "task.5007",
      statusUrl: "/status",
      now: NOW,
    });
    expect(output.session?.coordinationId).toBe(session().id);
    expect(output.session?.status).toBe(status);
    expect(output.nextAction).not.toContain("POST /claims");
    expect(getContainer).not.toHaveBeenCalled();
    expect(getWorkItem).not.toHaveBeenCalled();
  });

  it("retains the content existence check when no PostgreSQL session exists", async () => {
    vi.mocked(port.getCurrent).mockResolvedValue(null);
    const output = await getWorkItemCoordination({
      workItemId: "task.5007",
      statusUrl: "/status",
      now: NOW,
    });
    expect(output.session).toBeNull();
    expect(output.nextAction).toContain("Claim task.5007");
    expect(getWorkItem).toHaveBeenCalledWith("task.5007");
    vi.mocked(getWorkItem).mockResolvedValue(null);
    await expect(
      getWorkItemCoordination({
        workItemId: "missing",
        statusUrl: "/status",
        now: NOW,
      })
    ).rejects.toBeInstanceOf(CoordinationWorkItemNotFoundError);
  });

  it("keeps missing-session and non-owner heartbeat errors in PostgreSQL", async () => {
    failUnrelatedProviders();
    vi.mocked(port.heartbeat).mockResolvedValue(null);
    vi.mocked(port.getCurrent).mockResolvedValue(null);
    await expect(
      heartbeatWorkItemSession({
        workItemId: "missing",
        body: {},
        sessionUser: USER,
        statusUrl: "/status",
        now: NOW,
      })
    ).rejects.toBeInstanceOf(WorkItemSessionNotFoundError);
    vi.mocked(port.getCurrent).mockResolvedValue(
      session({ claimedByUserId: "someone-else" })
    );
    await expect(
      heartbeatWorkItemSession({
        workItemId: "task.5007",
        body: {},
        sessionUser: USER,
        statusUrl: "/status",
        now: NOW,
      })
    ).rejects.toBeInstanceOf(WorkItemSessionForbiddenError);
    expect(getContainer).not.toHaveBeenCalled();
    expect(getWorkItem).not.toHaveBeenCalled();
  });
});
