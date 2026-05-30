// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/work-item-sessions/session-policy`
 * Purpose: Unit tests for pure work-item coordination session policy.
 * Scope: No I/O. Verifies deadline math, effective status, DTO mapping, and
 *   next-action text.
 * Invariants: TESTS_PROVE_WORK, DOLT_IS_SOURCE_OF_TRUTH.
 * Side-effects: none
 * Links: src/features/work-item-sessions/session-policy.ts, task.5007
 * @internal
 */

import type { WorkItemDto } from "@cogni/node-contracts";
import { describe, expect, it } from "vitest";

import {
  deadlineFromNow,
  effectiveSessionStatus,
  nextActionForWorkItem,
  toWorkItemSessionDto,
} from "@/features/work-item-sessions/session-policy";
import type { WorkItemSessionRecord } from "@/ports";

const NOW = new Date("2026-05-02T12:00:00.000Z");

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

describe("work-item session policy", () => {
  it("calculates deadlines from now", () => {
    expect(deadlineFromNow(NOW, 90).toISOString()).toBe(
      "2026-05-02T12:01:30.000Z"
    );
  });

  it("reports active sessions as idle after their deadline passes", () => {
    expect(
      effectiveSessionStatus(
        session({ deadlineAt: new Date("2026-05-02T11:59:59.000Z") }),
        NOW
      )
    ).toBe("idle");
  });

  it("maps records to contract DTOs with effective status", () => {
    const dto = toWorkItemSessionDto(
      session({ deadlineAt: new Date("2026-05-02T11:59:59.000Z") }),
      NOW
    );

    expect(dto).toMatchObject({
      coordinationId: "00000000-0000-4000-8000-000000005007",
      workItemId: "task.5007",
      status: "idle",
      claimedByUserId: "user-1",
      claimedByDisplayName: "agent-one",
      lastCommand: "/implement",
    });
  });

  it("asks unlinked implementation sessions to link branch or PR", () => {
    expect(
      nextActionForWorkItem({
        workItem: WORK_ITEM,
        session: session(),
        now: NOW,
      })
    ).toContain("link the branch or PR");
  });

  it("returns conflict guidance with the active claimant", () => {
    expect(
      nextActionForWorkItem({
        workItem: WORK_ITEM,
        session: session(),
        now: NOW,
        conflict: true,
      })
    ).toContain("already claimed by agent-one");
  });

  it("demands /validate-candidate for needs_merge items without deployVerified", () => {
    const text = nextActionForWorkItem({
      workItem: { ...WORK_ITEM, status: "needs_merge", deployVerified: false },
      session: session({ prNumber: 1204 }),
      now: NOW,
    });
    expect(text).toContain("/validate-candidate");
    expect(text).toContain("PR #1204");
    expect(text).toContain("deployVerified");
  });

  it("clears to /review-implementation once deployVerified is true", () => {
    const text = nextActionForWorkItem({
      workItem: { ...WORK_ITEM, status: "needs_merge", deployVerified: true },
      session: session({ prNumber: 1204 }),
      now: NOW,
    });
    expect(text).toContain("/review-implementation");
    expect(text).not.toContain("/validate-candidate");
  });

  it("flags done work items still missing deployVerified", () => {
    const text = nextActionForWorkItem({
      workItem: {
        ...WORK_ITEM,
        status: "done",
        deployVerified: false,
        pr: "1204",
      },
      session: session({ prNumber: 1204 }),
      now: NOW,
    });
    expect(text).toContain("deployVerified is false");
    expect(text).toContain("/validate-candidate");
  });
});
