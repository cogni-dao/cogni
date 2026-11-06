// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/node-deploy/qualification`
 * Purpose: Sign release qualification challenges and validate fresh evidence for every selected companion.
 * Scope: Wire v1 challenge/evidence policy; does not dispatch requests or perform product operations.
 * Invariants: Purpose-separated credentials; exact release/attempt/allocation identity; readiness and boots match the selected set.
 *   BOUNDED_DIAGNOSTIC: a failure names its stage and an allowlisted code, never a token, header, body or raw message.
 * Side-effects: randomness (challenge nonce)
 * Links: sequencer.ts, ports/node-deploy.port.ts, bug.5568
 * @internal
 */
import { hkdfSync, randomUUID } from "node:crypto";
import { nodeWorkloadSpecSchema } from "@cogni/repo-spec";
import { SignJWT } from "jose";
import { z } from "zod";
import type { AttemptRow, ReleaseRow } from "@/ports";

// Declaration admission and its exact readiness observation share one path contract.
const companionReadyPathSchema = nodeWorkloadSpecSchema
  .innerType()
  .shape.companions.unwrap().element.shape.ready;

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
    companions: z
      .record(
        z.string().min(1).max(63),
        z
          .object({
            buildSha: z.string().regex(/^[0-9a-f]{40}$/),
            bootId: z.string().min(1).max(256),
            ready: z
              .object({
                port: z.number().int().min(1).max(65535),
                path: z
                  .string()
                  .refine(
                    (path) => companionReadyPathSchema.safeParse(path).success,
                    "companion readiness path refused"
                  ),
                status: z.literal(200),
                observedAt: z.string().datetime(),
              })
              .strict(),
          })
          .strict()
      )
      .refine((c) => Object.keys(c).length <= 7),
    evidenceId: z.string().min(1).max(512).optional(),
    observedAt: z.string().datetime(),
    nonce: z.string().min(1).max(128),
  })
  .strict();
export type QualificationEvidence = z.infer<typeof evidenceSchema>;

/** Where a qualification stopped. The failure decision is the same for every stage. */
export type QualificationStage =
  | "precondition"
  | "reserve"
  | "transport"
  | "http"
  | "validate"
  | "persist"
  | "deadline"
  | "internal";

/**
 * A qualification failure that is safe to log and persist: its stage, an allowlisted code, and the
 * HTTP status and elapsed time when a request was made. The message is built from these fields only.
 */
export class QualificationFailure extends Error {
  readonly stage: QualificationStage;
  readonly code: string;
  readonly status: number | undefined;
  readonly ms: number | undefined;
  constructor(
    stage: QualificationStage,
    code: string,
    detail: { readonly status?: number; readonly ms?: number } = {}
  ) {
    const safe = safeCode(code);
    super(
      `qualification ${stage} ${safe}${detail.status ? ` http=${detail.status}` : ""}`
    );
    this.name = "QualificationFailure";
    this.stage = stage;
    this.code = safe;
    this.status = detail.status;
    this.ms = detail.ms;
  }
}

/** Keep a code to the allowlisted shape; anything else becomes `unexpected`. */
function safeCode(code: string): string {
  return /^[A-Za-z0-9_]{1,64}$/.test(code) ? code : "unexpected";
}

/**
 * The bounded validation code of an evidence check failure. A JSON or schema error message can quote
 * the response body, so only its class is kept; our own fixed messages become snake_case codes.
 */
export function validationCode(error: unknown): string {
  if (error instanceof z.ZodError) return "evidence_schema";
  if (error instanceof SyntaxError) return "evidence_json";
  if (error instanceof Error && /^[a-z][a-z -]{0,62}$/.test(error.message))
    return error.message.replace(/[ -]+/g, "_");
  return "evidence_invalid";
}

/** Any thrown value as a QualificationFailure; an unknown error keeps no text. */
export function asQualificationFailure(error: unknown): QualificationFailure {
  return error instanceof QualificationFailure
    ? error
    : new QualificationFailure("internal", "unexpected");
}

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
  if (input.mode === "readback" && !input.prior)
    throw new Error("qualification readback needs prior evidence");
  const companionReadiness = Object.fromEntries(
    (input.release.spec.companions ?? []).map((c) => [
      c.name,
      { port: c.port, path: c.ready },
    ])
  );
  const companionBootIds =
    input.mode === "qualify"
      ? null
      : Object.fromEntries(
          Object.entries(input.prior?.companions ?? {}).map(([name, c]) => [
            name,
            c.bootId,
          ])
        );
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
    companionReadiness,
    companionBootIds,
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
  if (
    JSON.stringify(Object.keys(e.companions).sort()) !==
    JSON.stringify(companions.map((c) => c.name).sort())
  )
    throw new Error("qualification companion coverage mismatch");
  for (const c of companions) {
    const observed = e.companions[c.name];
    if (
      !observed ||
      observed.buildSha !== input.release.sourceSha ||
      observed.ready.port !== c.port ||
      observed.ready.path !== c.ready
    )
      throw new Error("qualification companion identity or readiness mismatch");
    const readyAt = Date.parse(observed.ready.observedAt);
    if (readyAt < input.startedAt - 1000 || readyAt > input.now + 1000)
      throw new Error("qualification companion readiness stale");
    if (
      input.prior &&
      observed.bootId !== input.prior.companions[c.name]?.bootId
    )
      throw new Error("qualification companion boot changed");
  }
  if (companions.length) {
    const helper = e.helper && e.companions[e.helper.service];
    if (
      e.status !== "qualified" ||
      !e.evidenceId ||
      !e.helper ||
      !helper ||
      e.helper.buildSha !== helper.buildSha ||
      e.helper.bootId !== helper.bootId
    )
      throw new Error("companion useful-work proof missing or inconsistent");
  } else if (e.status !== "not_declared" || e.helper || e.evidenceId)
    throw new Error("qualification falsely declared a companion");
  if (
    input.prior &&
    (e.evidenceId !== input.prior.evidenceId ||
      e.helper?.service !== input.prior.helper?.service ||
      e.helper?.buildSha !== input.prior.helper?.buildSha ||
      e.helper?.bootId !== input.prior.helper?.bootId)
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
