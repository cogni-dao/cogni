// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/_facades/internship-subsidy/prototype.server`
 * Purpose: App-layer facade for the public intern subsidy prototype.
 * Scope: Resolves prototype rail adapters from the container and delegates composition to the feature service.
 * Invariants: no chain IO; no transaction signing; output parsed by route contract.
 * Side-effects: structured logging only.
 * Links: features/internship-subsidy/services/buildSubsidyPrototype.ts
 * @public
 */

import { getContainer } from "@/bootstrap/container";
import type {
  InternshipSubsidyPrototypeInput,
  InternshipSubsidyPrototypeOutput,
} from "@/contracts/internship.subsidy-prototype.v1.contract";
import { buildSubsidyPrototype } from "@/features/internship-subsidy/public";
import type { RequestContext } from "@/shared/observability";

export async function getInternshipSubsidyPrototypeFacade(
  input: InternshipSubsidyPrototypeInput,
  ctx: RequestContext
): Promise<InternshipSubsidyPrototypeOutput> {
  const container = getContainer();
  const output = await buildSubsidyPrototype(input, {
    rails: container.subsidyDistributionRails,
    now: () => container.clock.now(),
  });

  ctx.log.info(
    {
      event: "internship.subsidy_prototype_built",
      rail: output.selectedRail.rail,
      cohortSize: output.program.cohortSize,
      poolAmountUsdCents: output.program.poolAmountUsdCents,
    },
    "internship subsidy prototype built"
  );

  return output;
}
