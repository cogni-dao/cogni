// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/identity.attestation.v1`
 * Purpose: Shared relying-party contract for operator-signed fleet identity attestations.
 * Scope: Pure Zod wire schemas and deterministic audience construction. Does not sign or verify
 *   tokens, access environment/framework state, or persist nonces.
 * Invariants:
 *   - FROZEN_PROTOCOL_FINGERPRINT: request and claims carry the same pinned v1 descriptor hash.
 *   - NODE_ID_DERIVES_AUDIENCE: callers send a registered node UUID, never an arbitrary audience.
 *   - TARGET_ORIGIN_BOUND: the exact relying deployment origin is carried in the request and signed claims.
 *   - NONCE_IS_ONE_TIME_AT_RP: the opaque nonce is minted and consumed once by the relying node.
 *   - GITHUB_LOGIN_NULLABLE: GitHub's stable provider id is authoritative; login is display metadata.
 * Side-effects: none
 * Links: task.5024, docs/spec/decentralized-user-identity.md
 * @public
 */

import { z } from "zod";

export const IDENTITY_ATTESTATION_V1 = "identity.attestation.v1" as const;
export const IDENTITY_ATTESTATION_AUDIENCE_PREFIX = "urn:cogni:node:";
/** Shared issuer/verifier lifetime contract. RP nonces outlive this window. */
export const IDENTITY_ATTESTATION_TTL_SECONDS = 10 * 60;

/**
 * Frozen, cross-repository protocol descriptor. Operator and node-template CI
 * hash this JSON value and pin the digest below; semantic changes require a v2
 * contract instead of silently drifting one side of the trust boundary.
 */
export const IDENTITY_ATTESTATION_V1_PROTOCOL = {
  id: IDENTITY_ATTESTATION_V1,
  algorithm: "EdDSA",
  ttlSeconds: IDENTITY_ATTESTATION_TTL_SECONDS,
  audience: "urn:cogni:node:<node UUID>",
  request: ["protocol", "nodeId", "nonce", "targetOrigin"],
  claims: [
    "type",
    "protocol",
    "iss",
    "sub",
    "aud",
    "nodeId",
    "nonce",
    "targetOrigin",
    "wallet",
    "github",
    "iat",
    "exp",
    "jti",
  ],
  rules: [
    "strict objects",
    "protocol fingerprint is required in request and signed claims",
    "issuer and target are canonical HTTPS origins without credentials",
    "audience is derived from nodeId",
    "nonce is URL-safe and 32..256 characters",
    "wallet is lowercase 20-byte hex",
    "github id is authoritative and login is nullable",
    "expiration is later than issuance",
  ],
} as const;

export const IDENTITY_ATTESTATION_V1_PROTOCOL_SHA256 =
  "1ff565838f01cf0a2b87b69c93bcaea2fb9f767cd655d609782a4b27c7430a50" as const;

export const IdentityAttestationNodeIdSchema = z.string().uuid();

/** Canonical HTTPS origin with no path, query, fragment, or credentials. */
export const IdentityAttestationOriginSchema = z
  .string()
  .url()
  .refine(
    (value) => {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        url.origin === value &&
        url.pathname === "/" &&
        !url.search &&
        !url.hash &&
        !url.username &&
        !url.password
      );
    },
    { message: "must be a canonical HTTPS origin without credentials" }
  );

/** Canonical HTTPS origin of the exact relying-node deployment. */
export const IdentityAttestationTargetOriginSchema =
  IdentityAttestationOriginSchema;

/** Opaque, URL-safe challenge minted by the node RP and consumed exactly once there. */
export const IdentityAttestationNonceSchema = z
  .string()
  .min(32)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);

export function identityAttestationAudience(nodeId: string): string {
  return `${IDENTITY_ATTESTATION_AUDIENCE_PREFIX}${IdentityAttestationNodeIdSchema.parse(nodeId)}`;
}

export const IdentityAttestationAudienceSchema = z
  .string()
  .regex(
    /^urn:cogni:node:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  );

export const IdentityAttestationRequestSchema = z
  .object({
    protocol: z.literal(IDENTITY_ATTESTATION_V1_PROTOCOL_SHA256),
    nodeId: IdentityAttestationNodeIdSchema,
    nonce: IdentityAttestationNonceSchema,
    targetOrigin: IdentityAttestationTargetOriginSchema,
  })
  .strict();

export const IdentityAttestationGithubSchema = z
  .object({
    id: z.string().min(1),
    login: z.string().min(1).nullable(),
  })
  .strict();

export const IdentityAttestationClaimsSchema = z
  .object({
    type: z.literal(IDENTITY_ATTESTATION_V1),
    protocol: z.literal(IDENTITY_ATTESTATION_V1_PROTOCOL_SHA256),
    iss: IdentityAttestationOriginSchema,
    sub: z.string().uuid(),
    aud: IdentityAttestationAudienceSchema,
    nodeId: IdentityAttestationNodeIdSchema,
    nonce: IdentityAttestationNonceSchema,
    targetOrigin: IdentityAttestationTargetOriginSchema,
    wallet: z.string().regex(/^0x[0-9a-f]{40}$/),
    github: IdentityAttestationGithubSchema,
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
    jti: z.string().uuid(),
  })
  .strict()
  .superRefine((claims, ctx) => {
    if (claims.aud !== identityAttestationAudience(claims.nodeId)) {
      ctx.addIssue({
        code: "custom",
        path: ["aud"],
        message: "aud must be derived from nodeId",
      });
    }
    if (claims.exp <= claims.iat) {
      ctx.addIssue({
        code: "custom",
        path: ["exp"],
        message: "exp must be later than iat",
      });
    }
  });

export type IdentityAttestationRequest = z.infer<
  typeof IdentityAttestationRequestSchema
>;
export type IdentityAttestationClaims = z.infer<
  typeof IdentityAttestationClaimsSchema
>;
