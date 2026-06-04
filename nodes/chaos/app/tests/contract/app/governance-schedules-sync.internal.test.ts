// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/governance-schedules-sync.internal`
 * Purpose: Contract tests for internal governance schedules sync endpoint.
 * Scope: Verifies bearer auth, disabled no-op behavior, and response contract shape. Does not test scheduler-core logic.
 * Invariants:
 *   - INTERNAL_OPS_AUTH: Missing/wrong bearer token -> 401
 *   - DISABLED_IS_NOOP: GOVERNANCE_SCHEDULES_ENABLED=false -> 204
 *   - RESPONSE_CONTRACT_STABLE: Success returns contract-valid summary
 * Side-effects: none
 * Links: src/app/api/internal/ops/governance/schedules/sync/route.ts
 * @internal
 */

import { GovernanceSchedulesSyncSummarySchema } from "@cogni/node-contracts";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TEST_INTERNAL_OPS_TOKEN = "x".repeat(32);

const serverEnvMock = vi.fn(() => ({
  INTERNAL_OPS_TOKEN: TEST_INTERNAL_OPS_TOKEN,
  GOVERNANCE_SCHEDULES_ENABLED: true,
}));

const runGovernanceSchedulesSyncJob = vi.fn();

vi.mock("@/shared/env", () => ({
  serverEnv: () => serverEnvMock(),
}));

vi.mock("@/bootstrap/jobs/syncGovernanceSchedules.job", () => ({
  runGovernanceSchedulesSyncJob: (...args: unknown[]) =>
    runGovernanceSchedulesSyncJob(...args),
}));

vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (
      _options: unknown,
      handler: (
        ctx: { log: { warn: () => void; error: () => void } },
        request: NextRequest
      ) => Promise<Response>
    ) =>
    async (request: NextRequest) =>
      handler(
        {
          reqId: "test-req-id",
          routeId: "governance.schedules.sync.internal",
          log: {
            warn: vi.fn(),
            error: vi.fn(),
            info: vi.fn(),
          },
        },
        request
      ),
}));

import { POST } from "@/app/api/internal/ops/governance/schedules/sync/route";

describe("POST /api/internal/ops/governance/schedules/sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serverEnvMock.mockReturnValue({
      INTERNAL_OPS_TOKEN: TEST_INTERNAL_OPS_TOKEN,
      GOVERNANCE_SCHEDULES_ENABLED: true,
    });
    runGovernanceSchedulesSyncJob.mockResolvedValue({
      created: 2,
      updated: 0,
      resumed: 1,
      skipped: 0,
      paused: 1,
    });
  });

  it("returns 401 when Authorization header is missing", async () => {
    const req = new NextRequest(
      "http://localhost:3000/api/internal/ops/governance/schedules/sync",
      { method: "POST" }
    );

    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(runGovernanceSchedulesSyncJob).not.toHaveBeenCalled();
  });

  it("returns 401 when token is invalid", async () => {
    const req = new NextRequest(
      "http://localhost:3000/api/internal/ops/governance/schedules/sync",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer wrong-token",
        },
      }
    );

    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(runGovernanceSchedulesSyncJob).not.toHaveBeenCalled();
  });

  it("returns 204 when governance schedules are disabled", async () => {
    serverEnvMock.mockReturnValue({
      INTERNAL_OPS_TOKEN: TEST_INTERNAL_OPS_TOKEN,
      GOVERNANCE_SCHEDULES_ENABLED: false,
    });

    const req = new NextRequest(
      "http://localhost:3000/api/internal/ops/governance/schedules/sync",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TEST_INTERNAL_OPS_TOKEN}`,
        },
      }
    );

    const res = await POST(req);
    expect(res.status).toBe(204);
    expect(runGovernanceSchedulesSyncJob).not.toHaveBeenCalled();
  });

  it("returns contract-valid summary on success", async () => {
    const req = new NextRequest(
      "http://localhost:3000/api/internal/ops/governance/schedules/sync",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TEST_INTERNAL_OPS_TOKEN}`,
        },
      }
    );

    const res = await POST(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    const parsed = GovernanceSchedulesSyncSummarySchema.parse(body);
    expect(parsed).toEqual({
      created: 2,
      updated: 0,
      resumed: 1,
      skipped: 0,
      paused: 1,
    });
    expect(runGovernanceSchedulesSyncJob).toHaveBeenCalledTimes(1);
  });
});
