// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/attribution.receipts.internal.v1.contract`
 * Purpose: Wire format for internal attribution receipt delivery (operator gateway -> owning node app).
 * Scope: The operator's GitHub App observes git for all node repos, resolves repo -> owning
 *   node_id (source_refs profile, #1924), normalizes the webhook to receipts, and DELIVERS them
 *   to that node's `POST /api/internal/attribution/receipts`. The node persists them in its OWN
 *   ledger. Mirrors graph-runs.create.internal.v1 (scheduler-worker -> node). This module is the
 *   wire contract only; it does not implement the route, the delivery client, or business logic.
 * Invariants:
 *   - Bearer SCHEDULER_API_TOKEN required (MVP dispatch identity, same as graph dispatch;
 *     the per-node dispatch principal is the hardening — task.5033).
 *   - NODE_WRITES_OWN_LEDGER: the envelope `nodeId` MUST equal the receiving node's own node_id;
 *     receipt rows carry no node_id on the wire — the node stamps its own. A node never persists
 *     a foreign ledger.
 *   - RECEIPT_IDEMPOTENT: persistence is ON CONFLICT DO NOTHING keyed by (node_id, receipt_id);
 *     repeat delivery (Temporal-style retry / Idempotency-Key) is a no-op.
 *   - All consumers use z.infer types; Date fields are ISO-8601 strings on the wire.
 * Side-effects: none
 * Links: /api/internal/attribution/receipts route,
 *   nodes/operator/app/src/features/ingestion/services/webhook-receiver.ts,
 *   docs/design/attribution-operator-gateway.md, task.0280, story.5023
 * @internal
 */

import { z } from "zod";

/**
 * One ingestion receipt on the wire — mirrors `InsertReceiptParams`
 * (`@cogni/attribution-ledger`) with `Date` fields as ISO strings and WITHOUT
 * `nodeId` (NODE_WRITES_OWN_LEDGER: the receiving node stamps its own node_id).
 */
export const InternalReceiptSchema = z.object({
  receiptId: z.string().min(1),
  source: z.string().min(1),
  eventType: z.string().min(1),
  platformUserId: z.string(),
  platformLogin: z.string().nullish(),
  artifactUrl: z.string().nullish(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
  payloadHash: z.string().min(1),
  producer: z.string().min(1),
  producerVersion: z.string().min(1),
  /** ISO-8601 */
  eventTime: z.string().datetime(),
  /** ISO-8601 */
  retrievedAt: z.string().datetime(),
});

export const InternalDeliverReceiptsInputSchema = z.object({
  /** The owning node's node_id — the receiving node asserts this equals its own. */
  nodeId: z.string().uuid(),
  /** Source key (e.g. "github") — the source these receipts were normalized from. */
  source: z.string().min(1),
  receipts: z.array(InternalReceiptSchema).min(1).max(500),
});

export const InternalDeliverReceiptsOutputSchema = z.object({
  ok: z.literal(true),
  nodeId: z.string().uuid(),
  /** Number of receipts accepted (idempotent inserts; may be < receipts.length on repeat). */
  received: z.number().int().nonnegative(),
});

export const internalDeliverReceiptsOperation = {
  id: "attribution.receipts.internal.v1",
  summary: "Deliver ingestion receipts (operator gateway -> owning node app)",
  description:
    "Internal endpoint the operator calls to persist normalized activity receipts in the owning node's OWN ledger. Bearer SCHEDULER_API_TOKEN. Idempotent per receiptId.",
  input: InternalDeliverReceiptsInputSchema,
  output: InternalDeliverReceiptsOutputSchema,
} as const;

export type InternalReceipt = z.infer<typeof InternalReceiptSchema>;
export type InternalDeliverReceiptsInput = z.infer<
  typeof InternalDeliverReceiptsInputSchema
>;
export type InternalDeliverReceiptsOutput = z.infer<
  typeof InternalDeliverReceiptsOutputSchema
>;
