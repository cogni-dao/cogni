// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO
/**
 * Module: `@cogni/operator-gateway-activation`
 * Purpose: Sealed, value-free intent and recoverable gateway activation policy.
 * Scope: Pure contracts and injected host effects shared by the operator and its runner.
 * Invariants: One implementation across environments; unchanged operation identity;
 *   observe after transport loss; no credentials, environment or application imports.
 * Side-effects: Only through GatewayHostPort supplied by the consuming runtime.
 * Links: bug.5570, https://cognidao.org/knowledge/secrets-management
 * @public
 */
import { z } from "zod";

export const GATEWAY_ACTIVATION_TARGET = "litellm-provider-key" as const;
export const GatewayEnvironmentSchema = z.enum([
  "candidate-a",
  "preview",
  "production",
]);
export const GatewayOperationIdSchema = z.uuid().regex(/^[a-f0-9-]+$/);
export const GatewaySourceShaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const repoPart = z.string().regex(/^[A-Za-z0-9_.-]+$/);
export const GatewayIntentSchema = z
  .strictObject({
    version: z.literal(1),
    operationId: GatewayOperationIdSchema,
    target: z.literal(GATEWAY_ACTIVATION_TARGET),
    env: GatewayEnvironmentSchema,
    custodian: z.strictObject({
      owner: repoPart,
      repo: repoPart,
      controlEnv: z.literal("production"),
    }),
    implementationSha: GatewaySourceShaSchema,
    protocolVersion: z.literal(1),
    bindingRef: z.string(),
  })
  .superRefine((intent, ctx) => {
    if (
      intent.bindingRef !== `cogni/${intent.env}/operator/OPENROUTER_API_KEY`
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["bindingRef"],
        message: "gateway_binding_out_of_scope",
      });
    }
  });
export type GatewayIntent = z.infer<typeof GatewayIntentSchema>;
export type GatewayEnvironment = z.infer<typeof GatewayEnvironmentSchema>;
export const GatewayMaintenanceRequestSchema = z.strictObject({
  nodeId: z.uuid(),
  env: GatewayEnvironmentSchema,
  target: z.literal(GATEWAY_ACTIVATION_TARGET),
});
export const GatewayPhaseSchema = z.enum([
  "unstarted",
  "prepared",
  "render_installed",
  "recreate_started",
  "gateway_verified",
  "receipt_commit_started",
  "activated",
  "rollback_started",
  "rolled_back",
  "conflict",
]);
export const GatewayObservationSchema = z.strictObject({
  operationId: GatewayOperationIdSchema,
  phase: GatewayPhaseSchema,
  noChanges: z.boolean().optional(),
  failure: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,95}$/)
    .optional(),
  observedAt: z.string().optional(),
  currentQualified: z.boolean().optional(),
  evidence: z
    .strictObject({
      appSha: GatewaySourceShaSchema.optional(),
      appShaAfterRecovery: GatewaySourceShaSchema.optional(),
      appPreserved: z.boolean().optional(),
      gatewayImage: z.string().max(256).optional(),
      providerKeySha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      selectedProviderKeySha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      projectionUid: z.string().max(128).optional(),
      projectionResourceVersion: z.string().max(128).optional(),
      otherRuntimeCount: z.number().int().nonnegative().optional(),
      receiptSha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    })
    .optional(),
});
export type GatewayObservation = z.infer<typeof GatewayObservationSchema>;
export const GatewayOperationSchema = z.strictObject({
  target: z.literal(GATEWAY_ACTIVATION_TARGET),
  env: GatewayEnvironmentSchema,
  sourceSha: GatewaySourceShaSchema,
  operationId: GatewayOperationIdSchema,
  intent: GatewayIntentSchema,
  intentCreatedAt: z.iso.datetime({ offset: true }),
  status: z.enum([
    "submitted",
    "running",
    "activated",
    "rolled_back",
    "conflict",
    "unknown",
  ]),
  observedAt: z.iso.datetime({ offset: true }),
  // A runner receipt certifies its observed transaction, never later host liveness.
  historicalReceipt: GatewayObservationSchema.optional(),
  currentState: z.literal("unobserved"),
  runId: z.number().int().positive().optional(),
  runUrl: z.url().optional(),
  transportSha: GatewaySourceShaSchema.optional(),
});
export type GatewayOperation = z.infer<typeof GatewayOperationSchema>;
export type GatewayAction =
  | "observe"
  | "prepare"
  | "install_render"
  | "activate"
  | "commit_receipt"
  | "rollback";
export interface GatewayHostPort {
  /** Runtime holds one qualified host guard across the complete connection. */
  step(
    action: GatewayAction,
    intent: GatewayIntent
  ): Promise<GatewayObservation>;
}
export function gatewayIntentRef(operationId: string): string {
  return `tags/cogni-gateway-activation/${GatewayOperationIdSchema.parse(operationId)}`;
}
const nextAction: Partial<Record<GatewayObservation["phase"], GatewayAction>> =
  {
    unstarted: "prepare",
    prepared: "install_render",
    render_installed: "activate",
    recreate_started: "activate",
    gateway_verified: "commit_receipt",
    receipt_commit_started: "commit_receipt",
    rollback_started: "rollback",
  };
/** Never infer failure from a lost response. A retry starts by observing the same journal. */
export async function activateGateway(
  rawIntent: GatewayIntent,
  host: GatewayHostPort
): Promise<GatewayObservation> {
  const intent = GatewayIntentSchema.parse(rawIntent);
  let action: GatewayAction = "observe";
  for (let transitions = 0; transitions < 12; transitions++) {
    const state = GatewayObservationSchema.parse(
      await host.step(action, intent)
    );
    if (state.operationId !== intent.operationId)
      throw new Error("gateway_operation_identity_conflict");
    if (
      state.phase === "activated" ||
      state.phase === "rolled_back" ||
      state.phase === "conflict"
    )
      return state;
    // The journal authorizes continuation of an already selected compensation.
    // Its original diagnostic must not strand recovery after caller loss.
    if (state.phase === "rollback_started") {
      if (action === "rollback" && state.failure) return state;
      action = "rollback";
      continue;
    }
    if (state.failure) {
      if (action === "rollback") return state;
      if (state.failure !== "gateway_unhealthy") return state;
      action = "rollback";
    } else {
      const next = nextAction[state.phase];
      if (!next) throw new Error("gateway_phase_unhandled");
      action = next;
    }
  }
  throw new Error("gateway_transition_bound_exceeded");
}
