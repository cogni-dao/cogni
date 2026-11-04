// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Wire v1. Purpose-separated, bounded release capability; never a user/session credential. */
import { hkdfSync, randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { z } from "zod";
import type { AttemptRow, ReleaseRow } from "@/ports";

const evidenceSchema = z
  .object({
    status: z.enum(["qualified", "not_declared"]),
    nodeId: z.string().uuid(),
    env: z.string(),
    releaseId: z.string(),
    sourceSha: z.string().regex(/^[0-9a-f]{40}$/),
    bundleDigest: z.string().max(512),
    services: z.record(z.string(), z.string().max(512)),
    attemptId: z.string(),
    allocation: z.string(),
    helper: z
      .object({
        service: z.string().max(63),
        buildSha: z.string().regex(/^[0-9a-f]{40}$/),
        bootId: z.string().min(1).max(256),
      })
      .strict()
      .nullish(),
    evidenceId: z.string().min(1).max(512).optional(),
    observedAt: z.string().datetime(),
    nonce: z.string().min(1).max(128),
  })
  .strict();
export type QualificationEvidence = z.infer<typeof evidenceSchema>;

export function qualificationSubject(release: ReleaseRow, attempt: AttemptRow) {
  const plan = release.spec.artifactPlan;
  if (!attempt.externalName || !plan?.bundleDigest || !plan.selectedImages)
    throw new Error("qualification subject incomplete");
  return {
    nodeId: release.nodeId,
    env: release.env,
    releaseId: release.id,
    sourceSha: release.sourceSha,
    bundleDigest: plan.bundleDigest,
    services: plan.selectedImages,
    attemptId: attempt.id,
    allocation: attempt.externalName,
  };
}

export async function qualificationChallenge(input: {
  readonly release: ReleaseRow;
  readonly attempt: AttemptRow;
  readonly authSecret: string;
  readonly now: number;
  readonly mode: "qualify" | "readback";
  readonly prior?: QualificationEvidence;
}) {
  if (!input.authSecret)
    throw new Error("qualification auth prerequisite missing");
  const purpose = "cogni-release-qualification-v1";
  const key = new Uint8Array(
    hkdfSync("sha256", input.authSecret, purpose, purpose, 32)
  );
  const nonce = randomUUID();
  const iat = Math.floor(input.now / 1000);
  const token = await new SignJWT({
    ...qualificationSubject(input.release, input.attempt),
    mode: input.mode,
    helperBootId: input.prior?.helper?.bootId ?? null,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer("cogni-operator")
    .setAudience("cogni-release-qualification")
    .setIssuedAt(iat)
    .setExpirationTime(iat + 60)
    .setJti(nonce)
    .sign(key);
  return { token, nonce };
}

export function checkQualification(input: {
  readonly body: string;
  readonly release: ReleaseRow;
  readonly attempt: AttemptRow;
  readonly nonce: string;
  readonly startedAt: number;
  readonly now: number;
  readonly prior?: QualificationEvidence;
}): QualificationEvidence {
  const e = evidenceSchema.parse(JSON.parse(input.body));
  const subject = qualificationSubject(input.release, input.attempt);
  for (const key of [
    "nodeId",
    "env",
    "releaseId",
    "sourceSha",
    "bundleDigest",
    "attemptId",
    "allocation",
  ] as const)
    if (e[key] !== subject[key])
      throw new Error("qualification subject mismatch");
  const expected = Object.entries(subject.services).sort();
  if (
    JSON.stringify(Object.entries(e.services).sort()) !==
      JSON.stringify(expected) ||
    e.nonce !== input.nonce
  )
    throw new Error("qualification services or nonce mismatch");
  const at = Date.parse(e.observedAt);
  if (
    at < input.startedAt - 1000 ||
    at > input.now + 1000 ||
    input.now - input.startedAt > 20000
  )
    throw new Error("qualification evidence stale");
  const companions = input.release.spec.companions ?? [];
  if (companions.length) {
    if (
      e.status !== "qualified" ||
      !e.evidenceId ||
      !e.helper ||
      !companions.some((c) => c.name === e.helper?.service) ||
      e.helper.buildSha !== input.release.sourceSha
    )
      throw new Error("companion useful-work proof missing");
  } else if (e.status !== "not_declared" || e.helper)
    throw new Error("qualification falsely declared a companion");
  if (
    input.prior &&
    (e.evidenceId !== input.prior.evidenceId ||
      JSON.stringify(e.helper) !== JSON.stringify(input.prior.helper))
  )
    throw new Error("qualification helper boot or receipt changed");
  return e;
}

export function savedQualification(
  attempt: AttemptRow
): QualificationEvidence | undefined {
  const step = [...attempt.steps]
    .reverse()
    .find((s) => s.step === "qualification" && s.outcome === "ok");
  if (!step?.reason) return undefined;
  return evidenceSchema.parse(JSON.parse(step.reason));
}
