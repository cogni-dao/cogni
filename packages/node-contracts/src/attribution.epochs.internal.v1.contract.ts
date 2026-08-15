// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@contracts/attribution.epochs.internal.v1.contract`
 * Purpose: Wire format for the internal attribution-epochs READ (operator gateway -> owning node app).
 * Scope: Wire format only; does not implement the route or delivery client. For GET
 *   /api/internal/attribution/epochs?nodeId=…&limit=…&offset=… (operator gateway -> owning node): the
 *   operator resolves {id} -> owning node_id and proxies the read so the node returns epochs from its
 *   OWN ledger. The read twin of attribution.receipts.internal.v1 (which is the write direction).
 * Invariants:
 *   - OPERATOR_AGGREGATES_ARE_DERIVED: the operator holds no cross-node DB creds; it derives this
 *     aggregate by proxying over the node's internal HTTP API, never by querying a node DB.
 *   - Bearer SCHEDULER_API_TOKEN required (MVP dispatch identity, same as the receipts write plane).
 *   - NODE_READS_OWN_LEDGER: the query `nodeId` MUST equal the receiving node's own node_id; the node
 *     asserts this (like the receipts route asserts NODE_WRITES_OWN_LEDGER) and reads only its OWN
 *     ledger. A node never reads a foreign ledger.
 *   - Output mirrors the session-authed `attribution.list-epochs.v1` shape exactly (ALL_MATH_BIGINT:
 *     BigInt values serialized as strings) so the operator gateway can return it byte-for-byte.
 *   - All consumers use z.infer types.
 * Side-effects: none
 * Links: /api/internal/attribution/epochs route, attribution.list-epochs.v1.contract,
 *   attribution.receipts.internal.v1.contract (write twin),
 *   nodes/operator/app/src/app/api/v1/nodes/[id]/attribution/epochs/route.ts, bug.5008
 * @internal
 */

import { z } from "zod";
import { ListEpochsOutputSchema } from "./attribution.list-epochs.v1.contract";

export const InternalListEpochsInputSchema = z.object({
  /** The owning node's node_id — the receiving node asserts this equals its own. */
  nodeId: z.string().uuid(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Read output is identical to the session-authed list-epochs wire shape. */
export const InternalListEpochsOutputSchema = ListEpochsOutputSchema;

export const internalListEpochsOperation = {
  id: "attribution.epochs.internal.v1",
  summary: "List a node's ledger epochs (operator gateway -> owning node app)",
  description:
    "Internal endpoint the operator gateway proxies to so the owning node returns epochs from its OWN ledger. Bearer SCHEDULER_API_TOKEN. The read twin of attribution.receipts.internal.v1.",
  input: InternalListEpochsInputSchema,
  output: InternalListEpochsOutputSchema,
} as const;

export type InternalListEpochsInput = z.infer<
  typeof InternalListEpochsInputSchema
>;
export type InternalListEpochsOutput = z.infer<
  typeof InternalListEpochsOutputSchema
>;
