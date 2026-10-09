// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/node.action.v1`
 * Purpose: Frozen operator-to-node authorization assertion contract for one allowlisted action.
 * Scope: Pure Zod claims and deterministic audience construction. Does not sign, verify, store replay state, or perform I/O.
 * Invariants: SHORT_LIVED, ACTION_BOUND, BODY_BOUND, NODE_ENV_BOUND, ACTOR_ATTRIBUTED, STRICT_CLAIMS.
 * Side-effects: none
 * Links: task.5164, docs/spec/rbac.md
 * @public
 */

import { z } from "zod";

import { IdentityAttestationOriginSchema } from "./identity.attestation.v1.contract";

export const NODE_ACTION_V1 = "node.action.v1" as const;
export const NODE_ACTION_TTL_SECONDS = 60;
export const NODE_ACTION_AUDIENCE_PREFIX = "urn:cogni:node-action:";

export const NODE_ACTION_V1_PROTOCOL = {
  id: NODE_ACTION_V1,
  algorithm: "EdDSA",
  maxTtlSeconds: NODE_ACTION_TTL_SECONDS,
  audience: "urn:cogni:node-action:<node UUID>",
  claims: [
    "type",
    "protocol",
    "iss",
    "aud",
    "nodeId",
    "environment",
    "actorId",
    "action",
    "target",
    "bodyHash",
    "iat",
    "exp",
    "jti",
  ],
  rules: [
    "strict claims",
    "audience is derived from nodeId",
    "environment and actor are server-derived",
    "target is an internal node-action path from the operator allowlist",
    "bodyHash is lowercase sha256 of the exact forwarded bytes",
    "exp is at most 60 seconds after iat",
    "jti is consumed once before side effects",
  ],
} as const;

export const NODE_ACTION_V1_PROTOCOL_SHA256 =
  "65feeb796f44286d8d67d1c7e300ff3071eea7ee72b169dae135be447b56322b" as const;

export const NodeActionNodeIdSchema = z.string().uuid();
export const NodeActionEnvironmentSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const NodeActionActorIdSchema = z
  .string()
  .min(3)
  .max(200)
  .regex(/^(user|agent|service):[^\s]+$/);
export const NodeActionIdSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[a-z][a-z0-9]*(?:[._][a-z0-9]+)+$/);
export const NodeActionTargetSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^\/api\/internal\/node-actions\/[a-z0-9/_-]+$/);
export const NodeActionBodyHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const NodeActionAudienceSchema = z
  .string()
  .regex(
    /^urn:cogni:node-action:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  );

export function nodeActionAudience(nodeId: string): string {
  return `${NODE_ACTION_AUDIENCE_PREFIX}${NodeActionNodeIdSchema.parse(nodeId)}`;
}

export const NodeActionClaimsSchema = z
  .object({
    type: z.literal(NODE_ACTION_V1),
    protocol: z.literal(NODE_ACTION_V1_PROTOCOL_SHA256),
    iss: IdentityAttestationOriginSchema,
    aud: NodeActionAudienceSchema,
    nodeId: NodeActionNodeIdSchema,
    environment: NodeActionEnvironmentSchema,
    actorId: NodeActionActorIdSchema,
    action: NodeActionIdSchema,
    target: NodeActionTargetSchema,
    bodyHash: NodeActionBodyHashSchema,
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
    jti: z.string().uuid(),
  })
  .strict()
  .superRefine((claims, ctx) => {
    if (claims.aud !== nodeActionAudience(claims.nodeId)) {
      ctx.addIssue({
        code: "custom",
        path: ["aud"],
        message: "aud must be derived from nodeId",
      });
    }
    const ttl = claims.exp - claims.iat;
    if (ttl <= 0 || ttl > NODE_ACTION_TTL_SECONDS) {
      ctx.addIssue({
        code: "custom",
        path: ["exp"],
        message: `exp must be within ${NODE_ACTION_TTL_SECONDS}s after iat`,
      });
    }
  });

export type NodeActionClaims = z.infer<typeof NodeActionClaimsSchema>;

/** Public operator request. The registry, never the caller, selects capability + target. */
export const NodeActionDispatchRequestSchema = z
  .object({
    action: NodeActionIdSchema,
    input: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export type NodeActionDispatchRequest = z.infer<
  typeof NodeActionDispatchRequestSchema
>;
