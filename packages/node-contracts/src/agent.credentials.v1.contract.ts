// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/agent.credentials.v1`
 * Purpose: Shared principal and lifecycle wire contracts for durable node-local agent credentials.
 * Scope: Zod schemas only. No persistence, authorization, secret generation, or framework code.
 * Invariants: CREDENTIAL_NE_PRINCIPAL; NODE_LOCAL_BEARER; HUMAN_AND_AGENT_ARE_DISTINCT;
 *   SHARED_STORE_PRINCIPALS_ARE_NODE_QUALIFIED.
 * Side-effects: none
 * Links: task.5211, task.5217
 * @public
 */

import { z } from "zod";

export const humanRequestPrincipalSchema = z.object({
  kind: z.literal("human"),
  principalId: z.string().startsWith("user:"),
  userId: z.string().min(1),
  walletAddress: z.string().nullable(),
  displayName: z.string().nullable(),
  avatarColor: z.string().nullable(),
});

export const agentRequestPrincipalSchema = z.object({
  kind: z.literal("agent"),
  principalId: z.string().startsWith("agent:"),
  actorId: z.string().uuid(),
  credentialId: z.string().uuid(),
  billingAccountId: z.string().min(1),
  displayName: z.string().nullable(),
  legacyUserId: z.string().nullable(),
});

export const requestPrincipalSchema = z.discriminatedUnion("kind", [
  humanRequestPrincipalSchema,
  agentRequestPrincipalSchema,
]);

export type HumanRequestPrincipal = z.infer<typeof humanRequestPrincipalSchema>;
export type AgentRequestPrincipal = z.infer<typeof agentRequestPrincipalSchema>;
export type RequestPrincipal = z.infer<typeof requestPrincipalSchema>;

export const executionIdentitySchema = z.object({
  actorPrincipal: z.string().startsWith("agent:"),
  subjectPrincipal: z.string().startsWith("user:").nullable(),
  billingAccountId: z.string().min(1),
  grantId: z.string().min(1).nullable(),
});
export type ExecutionIdentity = z.infer<typeof executionIdentitySchema>;

const credentialOutputSchema = z.object({
  actorId: z.string().uuid(),
  principalId: z.string().startsWith("agent:"),
  credentialId: z.string().uuid(),
  apiKey: z.string().min(32),
  billingAccountId: z.string().min(1),
  authenticateUntil: z.string().datetime(),
  renewUntil: z.string().datetime(),
});

export const createAgentSpawnGrantOperation = {
  id: "agent.spawn-grants.create.v1",
  input: z.object({
    name: z.string().min(1).max(80),
    idempotencyKey: z.string().min(8).max(128),
  }),
  output: z.object({
    grantId: z.string().uuid(),
    spawnToken: z.string().min(32),
    expiresAt: z.string().datetime(),
  }),
} as const;

export const agentCredentialStatusOperation = {
  id: "agent.credentials.status.v1",
  output: z.object({
    actorId: z.string().uuid(),
    principalId: z.string().startsWith("agent:"),
    credentialId: z.string().uuid(),
    status: z.enum(["active", "renew_only"]),
    authenticateUntil: z.string().datetime(),
    renewUntil: z.string().datetime(),
  }),
} as const;

export const rotateAgentCredentialOperation = {
  id: "agent.credentials.rotate.v1",
  input: z.object({
    idempotencyKey: z.string().min(8).max(128),
  }),
  output: z.object({
    actorId: z.string().uuid(),
    predecessorCredentialId: z.string().uuid(),
    credentialId: z.string().uuid(),
    apiKey: z.string().min(32),
    pendingExpiresAt: z.string().datetime(),
    authenticateUntil: z.string().datetime(),
    renewUntil: z.string().datetime(),
  }),
} as const;

export const confirmAgentCredentialOperation = {
  id: "agent.credentials.confirm.v1",
  output: agentCredentialStatusOperation.output,
} as const;

export const createAgentRecoveryGrantOperation = {
  id: "agent.recovery-grants.create.v1",
  input: z.object({
    actorId: z.string().uuid(),
    idempotencyKey: z.string().min(8).max(128),
  }),
  output: z.object({
    grantId: z.string().uuid(),
    recoveryToken: z.string().min(32),
    expiresAt: z.string().datetime(),
  }),
} as const;

export const recoverAgentCredentialOperation = {
  id: "agent.credentials.recover.v1",
  input: z.object({ recoveryToken: z.string().min(32).max(512) }),
  output: credentialOutputSchema,
} as const;

export const upgradeLegacyAgentCredentialOperation = {
  id: "agent.credentials.legacy-upgrade.v1",
  input: z.object({
    idempotencyKey: z.string().min(8).max(128),
  }),
  output: credentialOutputSchema,
} as const;
