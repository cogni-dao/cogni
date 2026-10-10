// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Verifies a bearer against a lane-local, verifier-only SHA-256 ring projection.
 * Raw credentials never enter the operator verifier environment.
 */

import { createHash, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import type {
  AuthorizationFacadeCredentialVerification,
  AuthorizationFacadeCredentialVerifierPort,
} from "@/ports";

const MAP_KEY =
  /^(candidate-a|preview|production)\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const RingSchema = z.strictObject({
  activeSha256: DigestSchema,
  previousSha256: DigestSchema.nullable(),
});
const MapSchema = z
  .record(z.string(), RingSchema)
  .superRefine((value, ctx) => {
    for (const key of Object.keys(value)) {
      if (!MAP_KEY.test(key)) {
        ctx.addIssue({ code: "custom", path: [key], message: "invalid map key" });
      }
    }
  });

export class EnvAuthorizationFacadeCredentialVerifierAdapter
  implements AuthorizationFacadeCredentialVerifierPort
{
  private readonly rings: z.infer<typeof MapSchema>;

  constructor(encodedRings: string) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(encodedRings);
    } catch {
      throw new Error("authorization facade verifier map is invalid");
    }
    const parsed = MapSchema.safeParse(decoded);
    if (!parsed.success) {
      throw new Error("authorization facade verifier map is invalid");
    }
    this.rings = parsed.data;
  }

  async verify(input: {
    readonly lane: "candidate-a" | "preview" | "production";
    readonly nodeId: string;
    readonly presentedCredential: string;
  }): Promise<AuthorizationFacadeCredentialVerification> {
    const ring = this.rings[`${input.lane}/${input.nodeId.toLowerCase()}`];
    if (!ring) return { decision: "invalid" };
    const presented = createHash("sha256")
      .update(input.presentedCredential, "utf8")
      .digest();
    return digestMatches(presented, ring.activeSha256) ||
      digestMatches(presented, ring.previousSha256)
      ? { decision: "valid" }
      : { decision: "invalid" };
  }
}

function digestMatches(presented: Buffer, expected: string | null): boolean {
  if (expected === null) return false;
  const expectedBytes = Buffer.from(expected, "hex");
  return (
    presented.length === expectedBytes.length &&
    timingSafeEqual(presented, expectedBytes)
  );
}
