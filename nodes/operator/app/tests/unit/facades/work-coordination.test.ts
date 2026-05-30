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

vi.mock("@/bootstrap/container", () => ({ getContainer: vi.fn() }));
vi.mock("@/app/_facades/work/items.server", () => ({
  getWorkItem: vi.fn(),
  patchWorkItem: vi.fn(),
}));

import {
  claimWorkItemSession,
  heartbeatWorkItemSession,
  linkWorkItemSessionPr,
  WorkItemSessionForbiddenError,
} from "@/app/_facades/work/coordination.server";
import { getWorkItem, patchWorkItem } from "@/app/_facades/work/items.server";
import { getContainer } from "@/bootstrap/container";

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
    repoFullName: null,
    ...overrides,
  } satisfies WorkItemSessionRecord;
}

function mockPort(): WorkItemSessionPort {
  return {
    claim: vi.fn(),
    heartbeat: vi.fn(),
    linkPr: vi.fn(),
    getCurrent: vi.fn(),
    lookupActiveByPr: vi.fn(),
  };
}

describe("app/_facades/work/coordination.server", () => {
  let port: WorkItemSessionPort;

  beforeEach(() => {
    vi.resetAllMocks();
    port = mockPort();
    vi.mocked(getContainer).mockReturnValue({
      workItemSessions: port,
    } as never);
    vi.mocked(getWorkItem).mockResolvedValue(WORK_ITEM);
    vi.mocked(patchWorkItem).mockResolvedValue(WORK_ITEM);
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
});
