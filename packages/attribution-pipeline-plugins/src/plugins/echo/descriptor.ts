// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/attribution-pipeline-plugins/plugins/echo/descriptor`
 * Purpose: Echo enricher descriptor — constants and pure payload builder.
 * Scope: Pure data and functions. Does not perform I/O or access any store.
 * Invariants:
 * - ENRICHER_DESCRIPTOR_PURE: constants and pure functions only.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/attribution-plugin-pipeline
 * @public
 */

import type { SelectedReceiptWithMetadata } from "@cogni/attribution-ledger";
import type { EnricherDescriptor } from "@cogni/attribution-pipeline-contracts";
import { z } from "zod";

/** Namespaced evaluation ref for the echo enricher. */
export const ECHO_EVALUATION_REF = "cogni.echo.v0";

/** Algorithm ref for the echo enricher. */
export const ECHO_ALGO_REF = "echo-v0";

/** Schema ref for the echo enricher payload shape. */
export const ECHO_SCHEMA_REF = "cogni.echo.v0/1.0.0";

/** Runtime schema for the echo enricher payload. */
export const EchoPayloadSchema = z.object({
  totalEvents: z.number().int().nonnegative(),
  byEventType: z.record(z.string(), z.number().int().nonnegative()),
  byUserId: z.record(z.string(), z.number().int().nonnegative()),
});

/** Echo enricher descriptor — pure data. */
export const ECHO_DESCRIPTOR: EnricherDescriptor = {
  evaluationRef: ECHO_EVALUATION_REF,
  algoRef: ECHO_ALGO_REF,
  schemaRef: ECHO_SCHEMA_REF,
  outputSchema: EchoPayloadSchema,
};

/**
 * Build the echo payload from selected receipts.
 * Pure computation — same receipts always produce same payload.
 */
export function buildEchoPayload(
  receipts: readonly SelectedReceiptWithMetadata[]
): Record<string, unknown> {
  const byEventType: Record<string, number> = {};
  const byUserId: Record<string, number> = {};

  for (const r of receipts) {
    byEventType[r.eventType] = (byEventType[r.eventType] ?? 0) + 1;
    if (r.userId) {
      byUserId[r.userId] = (byUserId[r.userId] ?? 0) + 1;
    }
  }

  return {
    totalEvents: receipts.length,
    byEventType,
    byUserId,
  };
}
