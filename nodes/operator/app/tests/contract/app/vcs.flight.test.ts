// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/vcs.flight`
 * Purpose: Contract tests for POST /api/v1/vcs/flight — audit decoration, CI gate, dispatch.
 * Scope: Verifies session-context attachment, unmediated-flight logging, CI gate,
 *   202 success shape, 401 auth. Uses mocked VcsCapability + workItemSessions port.
 * Invariants:
 *   - OPERATOR_FLIGHT_AUDITABLE: dispatch logs always emit; mediated when session
 *     exists, unmediated otherwise. Missing session never returns 412.
 *   - CI_GATE: 422 when allGreen=false or pending=true
 *   - AUTH_REQUIRED: 401 when no authenticated session
 *   - CONTRACTS_ARE_TRUTH: 202 response matches flightOperation.output schema
 * Side-effects: none
 * Links: design.operator-dev-lifecycle-coordinator, task.0361,
 *   nodes/operator/app/src/app/api/v1/vcs/flight/route.ts,
 *   packages/node-contracts/src/vcs.flight.v1.contract.ts
 * @internal
 */

import type {
  CiStatusResult,
  DispatchCandidateFlightResult,
} from "@cogni/ai-tools";
import { flightOperation } from "@cogni/node-contracts";
import { TEST_SESSION_USER_1 } from "@tests/_fakes/ids";
import { testApiHandler } from "next-test-api-route-handler";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as session from "@/app/_lib/auth/session";
import * as appHandler from "@/app/api/v1/vcs/flight/route";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGetCiStatus = vi.fn<() => Promise<CiStatusResult>>();
const mockDispatchCandidateFlight =
  vi.fn<() => Promise<DispatchCandidateFlightResult>>();
const mockLookupActiveByPr = vi.fn();

const ACTIVE_SESSION = {
  id: "00000000-0000-4000-8000-000000005007",
  workItemId: "task.5007",
  claimedByUserId: "user-1",
  claimedByDisplayName: "agent-one",
  status: "active" as const,
  claimedAt: new Date("2026-05-02T11:55:00.000Z"),
  lastHeartbeatAt: null,
  deadlineAt: new Date("2026-05-02T12:30:00.000Z"),
  closedAt: null,
  lastCommand: "/implement",
  branch: "feat/x",
  prNumber: 42,
  repoFullName: "test-owner/test-repo",
};

vi.mock("@/bootstrap/container", () => ({
  getContainer: vi.fn(() => ({
    log: {
      child: vi.fn(() => ({
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      })),
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
    clock: { now: vi.fn(() => new Date("2025-01-01T00:00:00Z")) },
    config: { unhandledErrorPolicy: "rethrow" },
    vcsCapability: {
      getCiStatus: mockGetCiStatus,
      dispatchCandidateFlight: mockDispatchCandidateFlight,
      listPrs: vi.fn(),
      mergePr: vi.fn(),
      createBranch: vi.fn(),
    },
    workItemSessions: {
      lookupActiveByPr: mockLookupActiveByPr,
      claim: vi.fn(),
      heartbeat: vi.fn(),
      linkPr: vi.fn(),
      getCurrent: vi.fn(),
    },
  })),
}));

vi.mock("@/shared/config/repoSpec.server", () => ({
  getGithubRepo: vi.fn(() => ({ owner: "test-owner", repo: "test-repo" })),
}));

vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: vi.fn().mockResolvedValue(TEST_SESSION_USER_1),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeGreenCiStatus(
  overrides: Partial<CiStatusResult> = {}
): CiStatusResult {
  return {
    prNumber: 42,
    prTitle: "test PR",
    author: "test-user",
    baseBranch: "main",
    headSha: "abc123def456abc123def456abc123def456abc1",
    mergeable: true,
    reviewDecision: null,
    labels: [],
    draft: false,
    allGreen: true,
    pending: false,
    checks: [],
    ...overrides,
  };
}

const DISPATCH_RESULT: DispatchCandidateFlightResult = {
  dispatched: true,
  prNumber: 42,
  headSha: "abc123def456abc123def456abc123def456abc1",
  workflowUrl:
    "https://github.com/test-owner/test-repo/actions/workflows/candidate-flight.yml",
  message: "Flight dispatched for PR #42 @ abc123de.",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/v1/vcs/flight", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(session.getSessionUser).mockResolvedValue(TEST_SESSION_USER_1);
    // Default: an active session exists for the requested PR.
    mockLookupActiveByPr.mockResolvedValue(ACTIVE_SESSION);
  });

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(session.getSessionUser).mockResolvedValue(null);

    await testApiHandler({
      appHandler,
      async test({ fetch }) {
        const res = await fetch({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prNumber: 42 }),
        });
        expect(res.status).toBe(401);
      },
    });
  });

  it("dispatches (unmediated) when no active session is bound to the PR", async () => {
    mockLookupActiveByPr.mockResolvedValue(null);
    mockGetCiStatus.mockResolvedValue(makeGreenCiStatus());
    mockDispatchCandidateFlight.mockResolvedValue(DISPATCH_RESULT);

    await testApiHandler({
      appHandler,
      async test({ fetch }) {
        const res = await fetch({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prNumber: 42 }),
        });
        // Manual / human flights remain a first-class path.
        expect(res.status).toBe(202);
        expect(mockGetCiStatus).toHaveBeenCalled();
        expect(mockDispatchCandidateFlight).toHaveBeenCalled();
      },
    });
  });

  it("looks up session by (repoFullName, prNumber) derived from getGithubRepo", async () => {
    mockGetCiStatus.mockResolvedValue(makeGreenCiStatus());
    mockDispatchCandidateFlight.mockResolvedValue(DISPATCH_RESULT);

    await testApiHandler({
      appHandler,
      async test({ fetch }) {
        await fetch({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prNumber: 42 }),
        });
        expect(mockLookupActiveByPr).toHaveBeenCalledWith({
          repoFullName: "test-owner/test-repo",
          prNumber: 42,
        });
      },
    });
  });

  it("returns 422 when CI is not green (allGreen=false)", async () => {
    mockGetCiStatus.mockResolvedValue(makeGreenCiStatus({ allGreen: false }));

    await testApiHandler({
      appHandler,
      async test({ fetch }) {
        const res = await fetch({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prNumber: 42 }),
        });
        expect(res.status).toBe(422);
        const body = await res.json();
        expect(body.error).toMatch(/CI is not green/);
        expect(mockDispatchCandidateFlight).not.toHaveBeenCalled();
      },
    });
  });

  it("returns 422 when CI is pending", async () => {
    mockGetCiStatus.mockResolvedValue(
      makeGreenCiStatus({ allGreen: true, pending: true })
    );

    await testApiHandler({
      appHandler,
      async test({ fetch }) {
        const res = await fetch({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prNumber: 42 }),
        });
        expect(res.status).toBe(422);
        expect(mockDispatchCandidateFlight).not.toHaveBeenCalled();
      },
    });
  });

  it("returns 202 with correct output shape when session + CI both green", async () => {
    mockGetCiStatus.mockResolvedValue(makeGreenCiStatus());
    mockDispatchCandidateFlight.mockResolvedValue(DISPATCH_RESULT);

    await testApiHandler({
      appHandler,
      async test({ fetch }) {
        const res = await fetch({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prNumber: 42 }),
        });
        expect(res.status).toBe(202);
        const body = await res.json();
        const parsed = flightOperation.output.safeParse(body);
        expect(parsed.success).toBe(true);
        expect(body.slot).toBe("candidate-a");
        expect(body.dispatched).toBe(true);
        expect(body.prNumber).toBe(42);
      },
    });
  });

  it("passes owner/repo from getGithubRepo to getCiStatus — not from caller", async () => {
    mockGetCiStatus.mockResolvedValue(makeGreenCiStatus());
    mockDispatchCandidateFlight.mockResolvedValue(DISPATCH_RESULT);

    await testApiHandler({
      appHandler,
      async test({ fetch }) {
        await fetch({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prNumber: 42 }),
        });
        expect(mockGetCiStatus).toHaveBeenCalledWith({
          owner: "test-owner",
          repo: "test-repo",
          prNumber: 42,
        });
      },
    });
  });
});
