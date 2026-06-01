// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/governance/signal-types`
 * Purpose: Zod schemas and types for on-chain CogniAction signals and action execution results.
 * Scope: Pure type definitions with runtime validation. Does not perform I/O.
 * Invariants: Signal schema matches CogniSignal contract ABI event structure.
 * Side-effects: none
 * Links: docs/spec/governance-signal-execution.md
 * @public
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Signal — parsed CogniAction event from blockchain
// ---------------------------------------------------------------------------

export const VCS_VALUES = ["github", "gitlab", "radicle"] as const;
export const ACTION_VALUES = ["merge", "grant", "revoke"] as const;
export const TARGET_VALUES = ["change", "collaborator"] as const;

export const signalSchema = z.object({
  dao: z.string().min(1),
  chainId: z.bigint(),
  vcs: z.enum(VCS_VALUES),
  repoUrl: z.string().url(),
  action: z.enum(ACTION_VALUES),
  target: z.enum(TARGET_VALUES),
  resource: z.string().min(1),
  nonce: z.bigint(),
  deadline: z.number().int(),
  paramsJson: z.string(),
  executor: z.string().min(1),
});

export type Signal = z.infer<typeof signalSchema>;
export type Vcs = (typeof VCS_VALUES)[number];
export type Action = (typeof ACTION_VALUES)[number];
export type Target = (typeof TARGET_VALUES)[number];

// ---------------------------------------------------------------------------
// ActionResult — outcome of executing a governance action
// ---------------------------------------------------------------------------

export const actionResultSchema = z.object({
  success: z.boolean(),
  action: z.string(),
  error: z.string().optional(),
  sha: z.string().optional(),
  username: z.string().optional(),
  repoUrl: z.string().optional(),
  changeNumber: z.number().optional(),
});

export type ActionResult = z.infer<typeof actionResultSchema>;

// ---------------------------------------------------------------------------
// RepoRef — parsed repository reference from repoUrl
// ---------------------------------------------------------------------------

export interface RepoRef {
  host: string;
  owner: string;
  repo: string;
  url: string;
}
