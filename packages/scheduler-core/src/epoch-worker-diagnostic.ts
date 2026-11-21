// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/scheduler-core/epoch-worker-diagnostic`
 * Purpose: Finite target-bound epoch event contract shared by writer and reader.
 * Scope: Pure projection; does not prove the target, which is the caller's responsibility.
 * Invariants: No payload, error, native identity or caller override survives projection.
 * Side-effects: none
 * Links: https://cognidao.org/knowledge/node-log-proxy-contract
 * @public
 */
import { z } from "zod";

export const diagnosticEnvSchema = z.enum([
  "candidate-a",
  "preview",
  "production",
]);
const targetSchema = z
  .object({ targetNodeId: z.string().uuid(), targetEnv: diagnosticEnvSchema })
  .strict();
export type EpochDiagnosticTarget = z.infer<typeof targetSchema>;
const common = {
  schemaVersion: z.literal(1),
  time: z.string().datetime(),
  targetNodeId: z.string().uuid(),
  node_id: z.string().uuid(),
  targetEnv: diagnosticEnvSchema,
};
export const epochWorkerDiagnosticSchema = z.discriminatedUnion("event", [
  z
    .object({
      ...common,
      event: z.literal("epoch.worker_started"),
      writerKind: z.literal("ledger"),
      kind: z.literal("ledger"),
      phase: z.literal("started"),
      queueRole: z.literal("current"),
      outcome: z.literal("success"),
    })
    .strict(),
  z
    .object({
      ...common,
      event: z.literal("epoch.ledger_activity_complete"),
      writerKind: z.literal("ledger"),
      phase: z.literal("ensure_epoch"),
      outcome: z.enum(["success", "error"]),
      reasonCode: z.enum(["ok", "internal_error"]),
      durationMs: z.number().int().min(0).max(86400000),
      attempt: z.number().int().min(1).max(1000000),
    })
    .strict(),
  z
    .object({
      ...common,
      event: z.literal("epoch.dispatch_authorized"),
      writerKind: z.literal("central_dispatch"),
      kind: z.literal("central_dispatch"),
      phase: z.literal("grant_validated"),
      outcome: z.literal("success"),
      attempt: z.number().int().min(1).max(1000000),
    })
    .strict(),
]);
export type EpochWorkerDiagnostic = z.infer<typeof epochWorkerDiagnosticSchema>;
export type EpochWorkerDiagnosticData =
  | { event: "epoch.worker_started" }
  | {
      event: "epoch.ledger_activity_complete";
      outcome: "success" | "error";
      durationMs: number;
      attempt: number;
    }
  | { event: "epoch.dispatch_authorized"; attempt: number };

/** Invalid namespace means no event; custody environment is deliberately not an input. */
export function diagnosticTarget(
  nodeId: string,
  namespace: string
): EpochDiagnosticTarget | null {
  const parsed = targetSchema.safeParse({
    targetNodeId: nodeId,
    targetEnv: namespace.startsWith("cogni-") ? namespace.slice(6) : "",
  });
  return parsed.success ? parsed.data : null;
}

/** Build anew. Never spread caller data or correlation over reserved fields. */
export function buildEpochWorkerDiagnostic(
  target: EpochDiagnosticTarget,
  data: EpochWorkerDiagnosticData,
  time: string
): EpochWorkerDiagnostic {
  const trusted = targetSchema.parse(target);
  const base = {
    schemaVersion: 1 as const,
    time,
    targetNodeId: trusted.targetNodeId,
    node_id: trusted.targetNodeId,
    targetEnv: trusted.targetEnv,
  };
  switch (data.event) {
    case "epoch.worker_started":
      return epochWorkerDiagnosticSchema.parse({
        ...base,
        event: data.event,
        writerKind: "ledger",
        kind: "ledger",
        phase: "started",
        queueRole: "current",
        outcome: "success",
      });
    case "epoch.ledger_activity_complete":
      return epochWorkerDiagnosticSchema.parse({
        ...base,
        event: data.event,
        writerKind: "ledger",
        phase: "ensure_epoch",
        outcome: data.outcome,
        reasonCode: data.outcome === "success" ? "ok" : "internal_error",
        durationMs: data.durationMs,
        attempt: data.attempt,
      });
    case "epoch.dispatch_authorized":
      return epochWorkerDiagnosticSchema.parse({
        ...base,
        event: data.event,
        writerKind: "central_dispatch",
        kind: "central_dispatch",
        phase: "grant_validated",
        outcome: "success",
        attempt: data.attempt,
      });
  }
}

/** Drop logger infrastructure and all unknown fields; validate event-specific shape anew. */
export function projectEpochWorkerDiagnostic(
  raw: unknown,
  target: EpochDiagnosticTarget
): EpochWorkerDiagnostic | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (
    r.targetNodeId !== target.targetNodeId ||
    r.node_id !== target.targetNodeId ||
    r.targetEnv !== target.targetEnv
  )
    return null;
  const fields = [
    "schemaVersion",
    "time",
    "event",
    "targetNodeId",
    "node_id",
    "targetEnv",
    "writerKind",
    "phase",
    "kind",
    "queueRole",
    "outcome",
    "reasonCode",
    "durationMs",
    "attempt",
  ];
  const projected: Record<string, unknown> = {};
  for (const field of fields)
    if (Object.getOwnPropertyDescriptor(r, field) !== undefined)
      projected[field] = r[field];
  const parsed = epochWorkerDiagnosticSchema.safeParse(projected);
  return parsed.success ? parsed.data : null;
}
