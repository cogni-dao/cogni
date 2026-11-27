// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import {
  bindEdoToolCapability,
  type createEdoCapability,
} from "@cogni/knowledge-store";
import {
  initializeConfidence,
  stripDangerousControlChars,
} from "@cogni/operator-knowledge-store";

/** Bind host attribution and retain operator policy before released replay/write logic. */
export function createOperatorEdoTools(
  edo: ReturnType<typeof createEdoCapability>,
  attribution: Parameters<typeof bindEdoToolCapability>[1]
): ReturnType<typeof bindEdoToolCapability> {
  return bindEdoToolCapability(
    {
      ...edo,
      hypothesize: (params, attribution) =>
        edo.hypothesize(
          {
            ...params,
            title: stripDangerousControlChars(params.title),
            content: stripDangerousControlChars(params.content),
            confidencePct: initializeConfidence({
              sourceType: params.sourceType,
            }).confidencePct,
          },
          attribution
        ),
      decide: (params, attribution) =>
        edo.decide(
          {
            ...params,
            title: stripDangerousControlChars(params.title),
            content: stripDangerousControlChars(params.content),
            confidencePct: initializeConfidence({
              sourceType: params.sourceType,
            }).confidencePct,
          },
          attribution
        ),
      recordOutcome: (params, attribution) =>
        edo.recordOutcome(
          {
            ...params,
            title: stripDangerousControlChars(params.title),
            content: stripDangerousControlChars(params.content),
          },
          attribution
        ),
    },
    attribution
  );
}
