// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { describe, expect, it } from "vitest";
import {
  AlloPrototypeSubsidyRailAdapter,
  SablierFlowPrototypeSubsidyRailAdapter,
} from "@/adapters/server";
import type { SubsidyProgram } from "@/ports";

describe("prototype subsidy rail adapters", () => {
  const program: SubsidyProgram = {
    id: "intern-ai-subscription-subsidy",
    name: "Intern AI Subscription Subsidy",
    purpose: "test",
    managerLegalActor: "Cogni DAO",
    asset: {
      symbol: "USDC",
      chainId: 8453,
      decimals: 6,
    },
    cohortSize: 1,
    incrementsPerIntern: 1,
    incrementUsdCents: 20_000,
    poolAmountUsdCents: 20_000,
    milestones: [],
  };

  it("keeps Allo as the recommended OSS grant-pool rail", async () => {
    const draft = await new AlloPrototypeSubsidyRailAdapter().draftProgram(
      program
    );

    expect(draft.rail).toBe("allo");
    expect(draft.fit).toBe("recommended");
    expect(draft.contractSurface).toContain("Allo.sol pool management");
    expect(draft.avoidedResponsibilities).toContain(
      "No Cogni-owned subsidy smart contract"
    );
  });

  it("keeps Sablier Flow as a swappable stream rail", async () => {
    const draft =
      await new SablierFlowPrototypeSubsidyRailAdapter().draftProgram(program);

    expect(draft.rail).toBe("sablier-flow");
    expect(draft.fit).toBe("viable");
    expect(draft.contractSurface).toContain("Sablier Flow stream");
    expect(draft.actions.map((a) => a.id)).toContain("sablier-top-up");
  });
});
