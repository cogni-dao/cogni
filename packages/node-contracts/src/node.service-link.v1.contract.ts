// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/node-contracts/node.service-link.v1`
 * Purpose: Zod contract for the operator-side service-link routes and the signed `service.enrollment.v1` token.
 * Scope: Wire shapes and constants only. Does not sign, store, call X or read a key.
 * Invariants:
 *   - CONTRACTS_ARE_TRUTH: wire shapes are owned here; the protocol is the hub entry
 *     `node-service-enrollment` (design commit 4).
 *   - OWN_TOKEN_TYPE: the enrollment token carries its own JOSE `typ` and claim `kind`; X's GitHub
 *     identity verifier rejects both, so the two token kinds cannot be mixed up.
 *   - AUDIENCE_IS_THE_NODE: `aud` is `urn:cogni:node:<X node uuid>`; the origin X is called at comes
 *     from the operator's node registry, never from a request body.
 *   - NO_SECRET_ON_THE_WIRE_BACK: the link answer carries a state and a connection id only; never a key.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/node-service-enrollment, story.0038,
 *   nodes/operator/app/src/app/api/v1/nodes/[id]/service-links/route.ts
 * @public
 */

import { z } from "zod";

/** `kind` claim of the enrollment token. */
export const SERVICE_ENROLLMENT_V1 = "service.enrollment.v1" as const;
/** JOSE `typ` header of the enrollment token (distinct from the identity attestation's `JWT`). */
export const SERVICE_ENROLLMENT_JWT_TYP =
  "cogni-service-enrollment+jwt" as const;
/** Audience prefix shared with the identity attestation. */
export const SERVICE_ENROLLMENT_AUDIENCE_PREFIX = "urn:cogni:node:" as const;
/** Token lifetime: at most 10 minutes. */
export const SERVICE_ENROLLMENT_TTL_SECONDS = 10 * 60;
/** The only scope a v0 service link asks for. */
export const SERVICE_ENROLLMENT_SCOPES = ["knowledge:read"] as const;

export const NODE_SERVICE_NAMES = ["git-review"] as const;
export const NodeServiceNameSchema = z.enum(NODE_SERVICE_NAMES);
export type NodeServiceName = z.infer<typeof NodeServiceNameSchema>;

export const NODE_SERVICE_LINK_STATE_VALUES = [
  "pending",
  "connected",
  "needs_reenroll",
  "failed",
  "superseded",
] as const;
export const NodeServiceLinkStateSchema = z.enum(
  NODE_SERVICE_LINK_STATE_VALUES
);
export type NodeServiceLinkStateValue = z.infer<
  typeof NodeServiceLinkStateSchema
>;

/** Public X25519 key the sealed key is encrypted to (RFC 7800 `cnf.jwk`). */
export const ServiceEnrollmentCnfJwkSchema = z
  .object({
    kty: z.literal("OKP"),
    crv: z.literal("X25519"),
    x: z.string().min(1),
  })
  .strict();

export const ServiceEnrollmentClaimsSchema = z
  .object({
    iss: z.string().url(),
    aud: z
      .string()
      .regex(
        /^urn:cogni:node:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      ),
    kind: z.literal(SERVICE_ENROLLMENT_V1),
    jti: z.string().uuid(),
    iat: z.number().int().positive(),
    exp: z.number().int().positive(),
    service: NodeServiceNameSchema,
    scopes: z.array(z.enum(SERVICE_ENROLLMENT_SCOPES)).min(1),
    cnf: z.object({ jwk: ServiceEnrollmentCnfJwkSchema }).strict(),
  })
  .strict()
  .refine((c) => c.exp - c.iat <= SERVICE_ENROLLMENT_TTL_SECONDS, {
    message: "enrollment token lifetime exceeds 10 minutes",
  });
export type ServiceEnrollmentClaims = z.infer<
  typeof ServiceEnrollmentClaimsSchema
>;

export function serviceEnrollmentAudience(nodeId: string): string {
  return `${SERVICE_ENROLLMENT_AUDIENCE_PREFIX}${z.string().uuid().parse(nodeId)}`;
}

export const startServiceLinkOperation = {
  input: z.object({ service: NodeServiceNameSchema }).strict(),
  output: z.object({
    linkId: z.string().uuid(),
    nodeId: z.string().uuid(),
    service: NodeServiceNameSchema,
    state: NodeServiceLinkStateSchema,
    /** True when the review App is installed on X's repository (a review can post its check). */
    githubReady: z.boolean(),
  }),
} as const;

export const serviceLinkOperation = {
  output: z.object({
    linkId: z.string().uuid(),
    nodeId: z.string().uuid(),
    service: NodeServiceNameSchema,
    state: NodeServiceLinkStateSchema,
    /** Operator `connections` row holding the X-issued key; set when `connected`. */
    connectionId: z.string().uuid().optional(),
    /** Stable code when the link is `failed` or `needs_reenroll`. */
    failureCode: z.string().optional(),
  }),
} as const;

export type StartServiceLinkInput = z.infer<
  typeof startServiceLinkOperation.input
>;
export type StartServiceLinkOutput = z.infer<
  typeof startServiceLinkOperation.output
>;
export type ServiceLinkOutput = z.infer<typeof serviceLinkOperation.output>;
