// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/governance/get-governance-status`
 * Purpose: Unit tests for governance status feature service.
 * Scope: Tests orchestration logic with mocked ports. Does not test database or HTTP.
 * Invariants: Validates BIGINT_SERIALIZATION, ISO date formatting, upcomingRuns shape.
 * Side-effects: none
 * Links: src/features/governance/services/get-governance-status.ts
 * @public
 */

import { describe, expect, it, vi } from "vitest";
import { getGovernanceStatus } from "@/features/governance/services/get-governance-status";
import type {
  AccountService,
  GovernanceStatusPort,
  UpcomingRun,
} from "@/ports";

function mockAccountService(balance: number): AccountService {
  return {
    getBalance: vi.fn().mockResolvedValue(balance),
  } as unknown as AccountService;
}

function mockGovernanceStatusPort(overrides?: {
  upcomingRuns?: UpcomingRun[];
  recentRuns?: Array<{
    id: string;
    title: string | null;
    startedAt: Date;
    lastActivity: Date;
  }>;
}): GovernanceStatusPort {
  return {
    getUpcomingRuns: vi.fn().mockResolvedValue(overrides?.upcomingRuns ?? []),
    getRecentRuns: vi.fn().mockResolvedValue(overrides?.recentRuns ?? []),
  };
}

describe("getGovernanceStatus", () => {
  it("returns balance as string (BIGINT_SERIALIZATION)", async () => {
    const result = await getGovernanceStatus({
      accountService: mockAccountService(42000),
      governanceStatusPort: mockGovernanceStatusPort(),
    });

    expect(result.systemCredits).toBe("42000");
    expect(typeof result.systemCredits).toBe("string");
  });

  it("returns empty upcomingRuns when no schedules exist", async () => {
    const result = await getGovernanceStatus({
      accountService: mockAccountService(100),
      governanceStatusPort: mockGovernanceStatusPort({ upcomingRuns: [] }),
    });

    expect(result.upcomingRuns).toEqual([]);
  });

  it("returns upcomingRuns with name and ISO nextRunAt", async () => {
    const date = new Date("2026-02-17T12:00:00Z");
    const result = await getGovernanceStatus({
      accountService: mockAccountService(100),
      governanceStatusPort: mockGovernanceStatusPort({
        upcomingRuns: [
          { name: "Community", nextRunAt: date },
          { name: "Engineering", nextRunAt: new Date("2026-02-17T12:15:00Z") },
        ],
      }),
    });

    expect(result.upcomingRuns).toHaveLength(2);
    expect(result.upcomingRuns[0]).toEqual({
      name: "Community",
      nextRunAt: "2026-02-17T12:00:00.000Z",
    });
    expect(result.upcomingRuns[1]?.name).toBe("Engineering");
  });

  it("maps recent runs with ISO date strings", async () => {
    const runs = [
      {
        id: "thread-1",
        title: "Governance Run #1",
        startedAt: new Date("2026-02-16T10:00:00Z"),
        lastActivity: new Date("2026-02-16T10:05:00Z"),
      },
      {
        id: "thread-2",
        title: null,
        startedAt: new Date("2026-02-15T10:00:00Z"),
        lastActivity: new Date("2026-02-15T10:03:00Z"),
      },
    ];

    const result = await getGovernanceStatus({
      accountService: mockAccountService(500),
      governanceStatusPort: mockGovernanceStatusPort({ recentRuns: runs }),
    });

    expect(result.recentRuns).toHaveLength(2);
    expect(result.recentRuns[0]).toEqual({
      id: "thread-1",
      title: "Governance Run #1",
      startedAt: "2026-02-16T10:00:00.000Z",
      lastActivity: "2026-02-16T10:05:00.000Z",
    });
    expect(result.recentRuns[1]?.title).toBeNull();
  });

  it("returns empty recentRuns array when no runs exist", async () => {
    const result = await getGovernanceStatus({
      accountService: mockAccountService(0),
      governanceStatusPort: mockGovernanceStatusPort({ recentRuns: [] }),
    });

    expect(result.recentRuns).toEqual([]);
  });
});
