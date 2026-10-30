// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/** Private trusted-assertor envelope. H/N correlate; bearer+peer authenticate the process.
 * No independent DB attestation against a compromised bearer holder is claimed. */
import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  ComputeProofRegistration,
  ComputeReleaseProofInput,
} from "@/types/compute-release-proof";
import {
  COMPUTE_PROOF_BODY_BYTES,
  ComputeProofRequestSchema,
} from "./compute-release-proof.schema";
import { canonicalProofJson } from "./compute-release-proof-canonical";

const registrationSchema = z
  .object({
    nodeId: z.string().uuid(),
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    repository: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
      .max(128),
    environment: z.enum(["candidate-a", "preview", "production"]),
  })
  .strict();
const contextSchema = registrationSchema
  .extend({
    requestHash: z.string().regex(/^[0-9a-f]{64}$/),
    nonce: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
const envelopeSchema = z
  .object({ request: ComputeProofRequestSchema, registration: contextSchema })
  .strict();
export function computeProofRequestHash(
  input: ComputeReleaseProofInput
): string {
  return createHash("sha256")
    .update(canonicalProofJson(ComputeProofRequestSchema.parse(input)))
    .digest("hex");
}
export function validateComputeProofContext(
  input: ComputeReleaseProofInput,
  raw: unknown
) {
  const context = contextSchema.parse(raw);
  if (
    context.nodeId !== input.expected.nodeId ||
    context.repository !== input.expected.repository ||
    context.environment !== input.expected.environment ||
    context.nonce !== input.nonce ||
    context.requestHash !== computeProofRequestHash(input)
  )
    throw new Error("unavailable");
  return context;
}
export function serializePrivateComputeProof(
  input: ComputeReleaseProofInput,
  raw: ComputeProofRegistration | undefined
): string {
  const registration = registrationSchema.parse(raw);
  const context = validateComputeProofContext(input, {
    ...registration,
    requestHash: computeProofRequestHash(input),
    nonce: input.nonce,
  });
  const body = JSON.stringify({
    request: ComputeProofRequestSchema.parse(input),
    registration: context,
  });
  if (Buffer.byteLength(body, "utf8") > COMPUTE_PROOF_BODY_BYTES)
    throw new Error("unavailable");
  return body;
}
export function parsePrivateComputeProof(body: string) {
  if (Buffer.byteLength(body, "utf8") > COMPUTE_PROOF_BODY_BYTES)
    throw new Error("unavailable");
  const envelope = envelopeSchema.parse(JSON.parse(body));
  validateComputeProofContext(envelope.request, envelope.registration);
  return envelope;
}
