// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/attribution-pipeline-plugins/plugins/echo/adapter`
 * Purpose: Echo enricher adapter — reads receipts from store, builds echo payload, computes hashes.
 * Scope: Implements EnricherAdapter port. Does not directly perform I/O — delegates to injected store.
 * Invariants:
 * - ENRICHER_IDEMPOTENT: same receipts produce same hashes and payload.
 * - EVALUATION_WRITE_VALIDATED: result includes evaluationRef, algoRef, inputsHash, schemaRef, payloadHash.
 * Side-effects: IO (reads from attributionStore via context)
 * Links: https://node-template.cognidao.org/knowledge/attribution-plugin-pipeline
 * @public
 */

import {
  computeEnricherInputsHash,
  sha256OfCanonicalJson,
} from "@cogni/attribution-ledger";
import type {
  EnricherAdapter,
  EnricherContext,
  EnricherEvaluationResult,
} from "@cogni/attribution-pipeline-contracts";

import { buildEchoPayload, ECHO_DESCRIPTOR } from "./descriptor";

async function evaluate(
  ctx: EnricherContext,
  status: "draft" | "locked"
): Promise<EnricherEvaluationResult> {
  const receipts = await ctx.attributionStore.getSelectedReceiptsWithMetadata(
    ctx.epochId
  );

  const payload = buildEchoPayload(receipts);
  const payloadHash = await sha256OfCanonicalJson(payload);
  const inputsHash = await computeEnricherInputsHash({
    epochId: ctx.epochId,
    receipts: receipts.map((r) => ({
      receiptId: r.receiptId,
      receiptPayloadHash: r.payloadHash,
    })),
  });

  return {
    nodeId: ctx.nodeId,
    epochId: ctx.epochId,
    evaluationRef: ECHO_DESCRIPTOR.evaluationRef,
    status,
    algoRef: ECHO_DESCRIPTOR.algoRef,
    schemaRef: ECHO_DESCRIPTOR.schemaRef,
    inputsHash,
    payloadHash,
    payloadJson: payload,
  };
}

/**
 * Create an echo enricher adapter.
 * Returns an EnricherAdapter that reads receipts and builds echo payloads.
 */
export function createEchoAdapter(): EnricherAdapter {
  return {
    descriptor: ECHO_DESCRIPTOR,
    evaluateDraft: (ctx) => evaluate(ctx, "draft"),
    buildLocked: (ctx) => evaluate(ctx, "locked"),
  };
}
