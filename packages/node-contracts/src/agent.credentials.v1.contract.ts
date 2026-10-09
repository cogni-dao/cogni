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

function nodeQualifiedPrincipalSchema(kind: "agent" | "user") {
  return z.string().superRefine((value, ctx) => {
    const match = new RegExp(`^${kind}:([^:/]+)/([^:/]+)$`).exec(value);
    if (
      !match ||
      !z.string().uuid().safeParse(match[1]).success ||
      !z.string().uuid().safeParse(match[2]).success
    ) {
      ctx.addIssue({
        code: "custom",
        message: `${kind} principal must be ${kind}:{node_uuid}/{local_uuid}`,
      });
    }
  });
}

function principalLocalId(principalId: string): string {
  return principalId.slice(principalId.lastIndexOf("/") + 1).toLowerCase();
}

function principalNodeId(principalId: string): string {
  return principalId
    .slice(principalId.indexOf(":") + 1, principalId.lastIndexOf("/"))
    .toLowerCase();
}

export const userPrincipalIdSchema = nodeQualifiedPrincipalSchema("user");
export const agentPrincipalIdSchema = nodeQualifiedPrincipalSchema("agent");

export const humanRequestPrincipalSchema = z
  .object({
    kind: z.literal("human"),
    principalId: userPrincipalIdSchema,
    userId: z.string().uuid(),
    walletAddress: z.string().nullable(),
    displayName: z.string().nullable(),
    avatarColor: z.string().nullable(),
  })
  .superRefine((value, ctx) => {
    if (principalLocalId(value.principalId) !== value.userId.toLowerCase()) {
      ctx.addIssue({
        code: "custom",
        message: "user principal suffix must equal userId",
        path: ["principalId"],
      });
    }
  });

export const agentRequestPrincipalSchema = z
  .object({
    kind: z.literal("agent"),
    principalId: agentPrincipalIdSchema,
    actorId: z.string().uuid(),
    credentialId: z.string().uuid(),
    billingAccountId: z.string().uuid(),
    displayName: z.string().nullable(),
    legacyUserId: z.string().uuid().nullable(),
  })
  .superRefine((value, ctx) => {
    if (principalLocalId(value.principalId) !== value.actorId.toLowerCase()) {
      ctx.addIssue({
        code: "custom",
        message: "agent principal suffix must equal actorId",
        path: ["principalId"],
      });
    }
  });

export const requestPrincipalSchema = z.union([
  humanRequestPrincipalSchema,
  agentRequestPrincipalSchema,
]);

export type HumanRequestPrincipal = z.infer<typeof humanRequestPrincipalSchema>;
export type AgentRequestPrincipal = z.infer<typeof agentRequestPrincipalSchema>;
export type RequestPrincipal = z.infer<typeof requestPrincipalSchema>;

export const executionIdentitySchema = z
  .object({
    actorPrincipal: agentPrincipalIdSchema,
    subjectPrincipal: userPrincipalIdSchema.nullable(),
    billingAccountId: z.string().uuid(),
    grantId: z.string().min(1).nullable(),
  })
  .superRefine((value, ctx) => {
    if (
      value.subjectPrincipal &&
      principalNodeId(value.actorPrincipal) !==
        principalNodeId(value.subjectPrincipal)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "actor and subject principals must belong to the same node",
        path: ["subjectPrincipal"],
      });
    }
  });
export type ExecutionIdentity = z.infer<typeof executionIdentitySchema>;

export const agentCredentialOutputSchema = z
  .object({
    actorId: z.string().uuid(),
    principalId: agentPrincipalIdSchema,
    credentialId: z.string().uuid(),
    apiKey: z.string().min(32),
    billingAccountId: z.string().uuid(),
    authenticateUntil: z.string().datetime(),
    renewUntil: z.string().datetime(),
  })
  .superRefine((value, ctx) => {
    if (principalLocalId(value.principalId) !== value.actorId.toLowerCase()) {
      ctx.addIssue({
        code: "custom",
        message: "agent principal suffix must equal actorId",
        path: ["principalId"],
      });
    }
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
  output: z
    .object({
      actorId: z.string().uuid(),
      principalId: agentPrincipalIdSchema,
      credentialId: z.string().uuid(),
      status: z.enum(["active", "renew_only"]),
      authenticateUntil: z.string().datetime(),
      renewUntil: z.string().datetime(),
    })
    .superRefine((value, ctx) => {
      if (principalLocalId(value.principalId) !== value.actorId.toLowerCase()) {
        ctx.addIssue({
          code: "custom",
          message: "agent principal suffix must equal actorId",
          path: ["principalId"],
        });
      }
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
  output: agentCredentialOutputSchema,
} as const;

export const upgradeLegacyAgentCredentialOperation = {
  id: "agent.credentials.legacy-upgrade.v1",
  input: z.object({
    idempotencyKey: z.string().min(8).max(128),
  }),
  output: agentCredentialOutputSchema,
} as const;
