// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/runs.stream.v1`
 * Purpose: Zod contract for GET /api/v1/ai/runs/{runId}/stream SSE endpoint.
 * Scope: Path parameter validation. Response is SSE (not JSON), so no output schema.
 * Invariants: CONTRACTS_ARE_TRUTH — single source for path param shape
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/graph-run-launch-contract §4 (Reconnection)
 * @public
 */

import { z } from "zod";

/** Path parameters for the run stream endpoint. */
export const RunStreamParamsSchema = z.object({
  runId: z.string().uuid(),
});

export type RunStreamParams = z.infer<typeof RunStreamParamsSchema>;
