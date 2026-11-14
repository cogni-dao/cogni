// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/run-stream.contract`
 * Purpose: Zod schemas for Redis Streams event serialization/deserialization.
 * Scope: Defines the wire format for AiEvent data stored in Redis stream entries. Does not contain business logic.
 * Invariants: Single source of truth for stream entry shape. All serialization uses these schemas.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/graph-run-launch-contract §7
 * @internal
 */

import { z } from "zod";

/**
 * Schema for the `data` field stored in each Redis stream entry.
 *
 * Events are stored as JSON strings in a single `data` field.
 * The AiEvent type union is validated at the TypeScript level;
 * Redis stores the raw JSON for maximum forward-compatibility.
 */
export const streamEntryDataSchema = z.object({
  /** JSON-serialized AiEvent payload. */
  data: z.string().min(1),
});

export type StreamEntryData = z.infer<typeof streamEntryDataSchema>;
