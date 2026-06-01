// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/internal/extract-schedule-id.spec`
 * Purpose: Unit tests for extractScheduleId helper used by internal graph run route.
 * Scope: Pure function tests for schedule ID extraction. Does not test HTTP or DB paths.
 * Invariants: Schedule IDs with colons are preserved; ISO timestamp boundary is the split point.
 * Side-effects: none
 * Links: src/app/api/internal/graphs/[graphId]/runs/route.ts
 * @internal
 */

import { describe, expect, it } from "vitest";
import { extractScheduleId } from "@/app/api/internal/graphs/[graphId]/runs/route";

describe("extractScheduleId", () => {
  it("extracts schedule ID when it contains colons (governance format)", () => {
    const key = "governance:govern:2025-01-15T10:00:00.000Z";
    expect(extractScheduleId(key)).toBe("governance:govern");
  });

  it("extracts schedule ID when it contains multiple colons", () => {
    const key = "governance:community:health:2026-02-17T08:30:00.000Z";
    expect(extractScheduleId(key)).toBe("governance:community:health");
  });

  it("extracts UUID schedule ID (no colons in ID)", () => {
    const key = "00000000-0000-0000-0000-000000000001:2025-01-15T10:00:00.000Z";
    expect(extractScheduleId(key)).toBe("00000000-0000-0000-0000-000000000001");
  });

  it("extracts simple hyphenated schedule ID", () => {
    const key = "daily-health-brief:2026-02-17T06:00:00.000Z";
    expect(extractScheduleId(key)).toBe("daily-health-brief");
  });

  it("returns full key when no ISO timestamp found", () => {
    const key = "no-timestamp-here";
    expect(extractScheduleId(key)).toBe("no-timestamp-here");
  });

  it("same schedule ID across different timestamps yields same result", () => {
    const key1 = "governance:govern:2025-01-15T10:00:00.000Z";
    const key2 = "governance:govern:2025-01-16T10:00:00.000Z";
    expect(extractScheduleId(key1)).toBe(extractScheduleId(key2));
  });
});
