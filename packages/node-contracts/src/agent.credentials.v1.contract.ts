// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/agent.credentials.v1`
 * Purpose: Zod contracts for the v2 agent key routes under /api/v1/agent/credentials (task.0070, child of task.5474):
 *   upgrade (v1 key -> pending v2 key), rotate (pending successor), confirm (activate), revoke.
 * Scope: Wire shapes only. Does not decide authorization and does not touch the credential store.
 * Invariants: CONTRACTS_ARE_TRUTH. `apiKey` is returned once by upgrade and rotate and never again. `userId` never changes
 *   across upgrade, rotate and confirm.
 * Side-effects: none
 * Links: https://cognidao.org/work/items/task.5474
 * @public
 */

import { z } from "zod";

const pendingKey = z.object({
  userId: z.string().min(1),
  credentialId: z.string().min(1),
  apiKey: z.string().min(1),
  status: z.literal("pending"),
  pendingExpiresAt: z.string().min(1),
});

export const upgradeAgentCredentialOperation = {
  id: "agent.credentials.upgrade",
  output: pendingKey,
} as const;
export const rotateAgentCredentialOperation = {
  id: "agent.credentials.rotate",
  output: pendingKey,
} as const;

export const confirmAgentCredentialOperation = {
  id: "agent.credentials.confirm",
  output: z.object({
    userId: z.string().min(1),
    credentialId: z.string().min(1),
    status: z.literal("active"),
    /** True when the credential was already active (a replayed confirm). */
    replay: z.boolean(),
    expiresAt: z.string().min(1),
    renewUntil: z.string().min(1),
  }),
} as const;

export const revokeAgentCredentialOperation = {
  id: "agent.credentials.revoke",
  /** Omit `credentialId` to revoke the key that made the call. */
  input: z.object({ credentialId: z.string().uuid().optional() }),
  output: z.object({
    credentialId: z.string().min(1),
    revoked: z.literal(true),
  }),
} as const;
