// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/ai.threads.v1.contract`
 * Purpose: Thread list/load/delete API contracts.
 * Scope: Wire format definitions for thread management endpoints. Does not contain business logic.
 * Invariants: Contract remains stable; breaking changes require new version. All consumers use z.infer types.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/thread-persistence-contract, src/ports/thread-persistence.port.ts
 * @public
 */

import { z } from "zod";

const MAX_STATE_KEY_CHARS = 128;
const STATE_KEY_SAFE_PATTERN = /^[a-zA-Z0-9_-]+$/;

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

const StateKeySchema = z
  .string()
  .min(1)
  .max(MAX_STATE_KEY_CHARS)
  .regex(STATE_KEY_SAFE_PATTERN, "stateKey must contain only safe characters");

const ThreadSummarySchema = z.object({
  stateKey: z.string(),
  title: z.string().optional(),
  updatedAt: z.string().datetime(),
  messageCount: z.number().int().nonnegative(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// ---------------------------------------------------------------------------
// List threads
// ---------------------------------------------------------------------------

export const listThreadsOperation = {
  id: "ai.threads.list.v1",
  summary: "List threads for the authenticated user, ordered by recency",
  input: z.object({
    limit: z.number().int().min(1).max(100).default(50),
    offset: z.number().int().min(0).default(0),
  }),
  output: z.object({
    threads: z.array(ThreadSummarySchema),
  }),
} as const;

// ---------------------------------------------------------------------------
// Load thread messages
// ---------------------------------------------------------------------------

export const loadThreadOperation = {
  id: "ai.threads.load.v1",
  summary: "Load full message history for a single thread",
  input: z.object({
    stateKey: StateKeySchema,
  }),
  output: z.object({
    stateKey: z.string(),
    messages: z.array(z.unknown()),
  }),
} as const;

// ---------------------------------------------------------------------------
// Delete thread (soft)
// ---------------------------------------------------------------------------

export const deleteThreadOperation = {
  id: "ai.threads.delete.v1",
  summary: "Soft-delete a thread",
  input: z.object({
    stateKey: StateKeySchema,
  }),
  output: z.object({
    ok: z.literal(true),
  }),
} as const;

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type ListThreadsInput = z.infer<typeof listThreadsOperation.input>;
export type ListThreadsOutput = z.infer<typeof listThreadsOperation.output>;
export type LoadThreadInput = z.infer<typeof loadThreadOperation.input>;
export type LoadThreadOutput = z.infer<typeof loadThreadOperation.output>;
export type DeleteThreadInput = z.infer<typeof deleteThreadOperation.input>;
export type DeleteThreadOutput = z.infer<typeof deleteThreadOperation.output>;
export type ThreadSummary = z.infer<typeof ThreadSummarySchema>;
