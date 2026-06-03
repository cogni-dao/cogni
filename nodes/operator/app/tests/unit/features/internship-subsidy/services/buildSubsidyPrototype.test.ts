// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { describe, expect, it } from "vitest";
import { buildSubsidyPrototype } from "@/features/internship-subsidy/public";
import type { SubsidyDistributionRailPort, SubsidyRailDraft } from "@/ports";

function fakeRail(
  rail: "allo" | "sablier-flow",
  fit: SubsidyRailDraft["fit"]
): SubsidyDistributionRailPort {
  return {
    rail,
    draftProgram: async () => ({
      rail,
      fit,
      status: "prototype",
      label: `${rail} rail`,
      ossProjectUrl:
        rail === "allo"
          ? "https://github.com/allo-protocol/allo-v2"
          : "https://github.com/sablier-labs/flow",
      contractSurface: [],
      cogniResponsibilities: [],
      avoidedResponsibilities: [],
      actions: [],
      riskNotes: [],
    }),
  };
}

describe("buildSubsidyPrototype", () => {
  it("selects the requested rail without changing the canonical program", async () => {
    const output = await buildSubsidyPrototype(
      { rail: "sablier-flow", cohortSize: 2, incrementsPerIntern: 2 },
      {
        now: () => "2026-05-31T00:00:00.000Z",
        rails: {
          allo: fakeRail("allo", "recommended"),
          "sablier-flow": fakeRail("sablier-flow", "viable"),
        },
      }
    );

    expect(output.generatedAt).toBe("2026-05-31T00:00:00.000Z");
    expect(output.selectedRail.rail).toBe("sablier-flow");
    expect(output.program.poolAmountUsdCents).toBe(80_000);
    expect(output.program.incrementUsdCents).toBe(20_000);
    expect(output.program.milestones.map((m) => m.gate)).toEqual([
      "interview_passed",
      "contributor_started",
    ]);
    expect(output.railOptions.map((option) => option.rail)).toEqual([
      "allo",
      "sablier-flow",
    ]);
  });
});
