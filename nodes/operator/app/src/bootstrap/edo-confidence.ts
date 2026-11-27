// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import type { createEdoCapability } from "@cogni/knowledge-store";
import { initializeConfidence } from "@cogni/operator-knowledge-store";

/** Preserve the operator's source-based policy at the published writer boundary. */
export function withOperatorEdoConfidence(
  edo: ReturnType<typeof createEdoCapability>
): ReturnType<typeof createEdoCapability> {
  return {
    ...edo,
    hypothesize: (params, attribution) =>
      edo.hypothesize(
        {
          ...params,
          confidencePct: initializeConfidence({ sourceType: params.sourceType })
            .confidencePct,
        },
        attribution
      ),
    decide: (params, attribution) =>
      edo.decide(
        {
          ...params,
          confidencePct: initializeConfidence({ sourceType: params.sourceType })
            .confidencePct,
        },
        attribution
      ),
  };
}
