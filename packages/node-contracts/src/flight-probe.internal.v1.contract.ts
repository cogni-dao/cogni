// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/node-contracts/flight-probe.internal.v1`
 * Purpose: Frozen wire contract for the bounded operator-to-node run-carries probe.
 * Scope: Schemas only. Credential verification and workflow execution stay in the node app.
 * Invariants:
 *   - FIXED_OPERATION: the caller cannot choose graph, prompt, model, billing account, or actor.
 *   - SERVICE_NOT_CONTRIBUTOR: principalId is the stable `service:{nodeId}/flight-prober` subject.
 *   - RUN_LEDGER_PROOF: every successful response names the run created by GraphRunWorkflow.
 * Side-effects: none
 * Links: task.5218, POST /api/internal/flight-probe
 * @internal
 */

import { z } from "zod";

export const InternalFlightProbeOutputSchema = z.strictObject({
  ok: z.boolean(),
  runId: z.string().uuid(),
  principalId: z.string().min(1),
});

export type InternalFlightProbeOutput = z.infer<
  typeof InternalFlightProbeOutputSchema
>;
