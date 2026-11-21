// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/scheduler-core/ledger-diagnostic`
 * Purpose: Strict public diagnostic contract and private admitted binding.
 * Scope: Pure types, projection policy and read-only port; does not perform SDK calls or I/O.
 * Invariants: No native identifiers, payloads, errors or arbitrary fields in public DTOs.
 * Side-effects: none
 * Links: https://cognidao.org/knowledge/node-temporal-health-contract
 * @public
 */
import { z } from "zod";
import { diagnosticEnvSchema } from "./epoch-worker-diagnostic";

const time = z.string().datetime().nullable();
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const duration = z
  .number()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
  .nullable();
export const ledgerDiagnosticReasonSchema = z.enum([
  "activity_elsewhere",
  "dispatch_not_declared",
  "unsupported_topology",
  "ownership_unproven",
  "scope_conflict",
  "schedule_missing",
  "bounds_exceeded",
  "invalid_native_shape",
  "selection_incomplete",
  "evidence_changed",
  "blocker_changed",
  "historical_ownership_unproven",
  "pollers_unknown",
  "no_execution_timeout",
  "no_run_timeout",
  "unbounded_blocker",
  "stranded_on_unpolled_legacy_queue",
  "no_running_reference",
]);
export type LedgerDiagnosticReason = z.infer<
  typeof ledgerDiagnosticReasonSchema
>;
const task = z
  .object({
    state: z.enum(["scheduled", "started", "unknown"]),
    scheduledAt: time,
    originalScheduledAt: time,
    startedAt: time,
    attempt: count.nullable(),
  })
  .strict();
const pollers = z
  .object({
    observedAt: z.string().datetime(),
    pollerCount: count.max(64),
    lastAccessAt: time,
    ageMs: duration,
    freshness: z.enum(["observed", "unknown"]),
  })
  .strict();
export const ledgerDiagnosticSchema = z
  .object({
    schemaVersion: z.literal(1),
    nodeId: z.string().uuid(),
    env: diagnosticEnvSchema,
    appBuildSha: z.string().max(64),
    observedAt: z.string().datetime(),
    mode: z.literal("compatibility"),
    capability: z.enum([
      "operator_ledger",
      "central_dispatch",
      "not_applicable",
      "unsupported",
    ]),
    state: z.enum(["observed", "partial", "unknown"]),
    reasonCodes: z.array(ledgerDiagnosticReasonSchema).max(24),
    schedule: z
      .object({
        ownership: z.enum(["owned", "unproven", "scope_conflict"]),
        observedAt: z.string().datetime(),
        state: z.enum(["active", "paused", "missing", "unknown"]),
        overlap: z.enum(["SKIP", "BUFFER_ONE", "ALLOW_ALL", "unknown"]),
        overlapSkipped: count.nullable(),
        actionCount: count.nullable(),
        missedCatchup: count.nullable(),
        nextActionAt: time,
        currentQueueRole: z.enum(["current", "other", "unknown"]),
        executionTimeoutMs: duration,
        runTimeoutMs: duration,
      })
      .strict()
      .nullable(),
    selection: z.enum([
      "oldest_running",
      "recent_action",
      "none",
      "incomplete",
    ]),
    blockingRunningCount: count.max(4),
    consistent: z.boolean(),
    blocker: z
      .object({
        ownership: z.enum(["owned", "unproven", "scope_conflict"]),
        evidenceScope: z.literal("environment-shared"),
        observedAt: z.string().datetime(),
        state: z.enum(["RUNNING", "changed", "unknown"]),
        startedAt: time,
        closedAt: time,
        pendingWorkflowTask: task.nullable(),
        executionTimeoutMs: duration,
        runTimeoutMs: duration,
        taskTimeoutMs: duration,
        runningQueueRole: z.enum(["current", "legacy", "other"]),
        queueChanged: z.boolean().nullable(),
      })
      .strict()
      .nullable(),
    queues: z
      .array(
        z
          .object({
            role: z.enum(["current", "legacy"]),
            evidenceScope: z.literal("environment-shared"),
            workflow: pollers.nullable(),
            activity: pollers.nullable(),
          })
          .strict()
      )
      .max(2),
    budgets: z.object({ calls: count.max(12), complete: z.boolean() }).strict(),
  })
  .strict();
export type LedgerDiagnosticV1 = z.infer<typeof ledgerDiagnosticSchema>;
const admission = Symbol("admitted-ledger-binding");
export interface LedgerDiagnosticBinding {
  readonly [admission]: true;
  readonly nodeId: string;
  readonly env: "candidate-a" | "preview" | "production";
  readonly appBuildSha: string;
  readonly capability: "operator_ledger" | "central_dispatch";
  readonly namespace: string;
  readonly scheduleId: string;
  readonly currentQueue: string;
  readonly legacyQueue: string;
  readonly workflowType: "CollectEpochWorkflow" | "NodeTaskWorkflow";
  readonly expectedEnvelope: Readonly<Record<string, unknown>>;
}
/** Bootstrap calls only after exact system row, current live grant and declaration validation. */
export function admitLedgerBinding(
  input: Omit<LedgerDiagnosticBinding, typeof admission>
): LedgerDiagnosticBinding {
  z.string().uuid().parse(input.nodeId);
  diagnosticEnvSchema.parse(input.env);
  if (
    input.namespace !== `cogni-${input.env}` ||
    input.expectedEnvelope.nodeId !== input.nodeId
  )
    throw new Error("scope_conflict");
  return Object.freeze({
    ...input,
    [admission]: true as const,
    expectedEnvelope: Object.freeze(input.expectedEnvelope),
  });
}
export function emptyLedgerDiagnostic(
  input: {
    nodeId: string;
    env: "candidate-a" | "preview" | "production";
    appBuildSha: string;
    capability: LedgerDiagnosticV1["capability"];
  },
  reason?: LedgerDiagnosticReason
): LedgerDiagnosticV1 {
  return {
    schemaVersion: 1,
    nodeId: input.nodeId,
    env: input.env,
    appBuildSha: input.appBuildSha,
    observedAt: new Date().toISOString(),
    mode: "compatibility",
    capability: input.capability,
    state: "unknown",
    reasonCodes: reason ? [reason] : [],
    schedule: null,
    selection: "none",
    blockingRunningCount: 0,
    consistent: false,
    blocker: null,
    queues: [],
    budgets: { calls: 0, complete: false },
  };
}
/** Exact keys, bounded JSON depth and value equality. No codec, coercion or arbitrary prototype. */
export function equalDiagnosticEnvelope(
  actual: unknown,
  expected: unknown,
  depth = 0
): boolean {
  if (depth > 8) return false;
  if (actual === expected) return true;
  if (
    !actual ||
    !expected ||
    typeof actual !== "object" ||
    typeof expected !== "object"
  )
    return false;
  if (Array.isArray(actual) !== Array.isArray(expected)) return false;
  const a = Object.keys(actual).sort();
  const b = Object.keys(expected).sort();
  return (
    a.length === b.length &&
    a.every(
      (key, i) =>
        key === b[i] &&
        equalDiagnosticEnvelope(
          (actual as Record<string, unknown>)[key],
          (expected as Record<string, unknown>)[key],
          depth + 1
        )
    )
  );
}

/** Private local ownership fact. Timestamp numbers are milliseconds, not native protobufs. */
export function verifyCurrentLedgerOwnership(input: {
  readonly expectedInput: unknown;
  readonly expectedGraphId: string;
  readonly systemUserId: string;
  readonly requiredScope: string;
  readonly nowMs: number;
  readonly schedule: {
    readonly ownerUserId: string;
    readonly graphId: string;
    readonly executionGrantId: string;
    readonly input: unknown;
  };
  readonly grant: {
    readonly id: string;
    readonly userId: string;
    readonly scopes: readonly string[];
    readonly revoked: boolean;
    readonly expiresAtMs: number | null;
  } | null;
}): "ownership_unproven" | "scope_conflict" | null {
  const { schedule, grant } = input;
  if (
    schedule.ownerUserId !== input.systemUserId ||
    !grant ||
    grant.id !== schedule.executionGrantId ||
    grant.userId !== input.systemUserId ||
    grant.revoked ||
    (grant.expiresAtMs !== null &&
      (!Number.isFinite(grant.expiresAtMs) ||
        grant.expiresAtMs <= input.nowMs)) ||
    !grant.scopes.includes(input.requiredScope)
  )
    return "ownership_unproven";
  if (
    schedule.graphId !== input.expectedGraphId ||
    !equalDiagnosticEnvelope(schedule.input, input.expectedInput)
  )
    return "scope_conflict";
  return null;
}
