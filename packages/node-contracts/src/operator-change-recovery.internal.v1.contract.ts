// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/operator-change-recovery.internal.v1.contract`
 * Purpose: Strict wire contract for durable recovery of one verified operator-generated change.
 * Scope: Serializable intent/request/result schemas only. Does not contain GitHub, Temporal, or application logic.
 * Invariants:
 *   - One typed intent represents the original signed semantic verb, never stale derived file bytes.
 *   - At depth zero the recovery root is the exact losing head; later depths preserve that root.
 *   - Recovery depth counts fresh-main regenerations only and is capped at three.
 *   - The scheduler-worker delegates with Bearer SCHEDULER_API_TOKEN and holds no GitHub credential.
 *   - Every object is strict so unknown or misspelled recovery fields fail closed.
 * Side-effects: none
 * Links: task.5188, docs/spec/temporal-patterns.md
 * @internal
 */

import { z } from "zod";

const GitShaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const RepoPartSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_.-]+$/);
const NodeSlugSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9][a-z0-9-]*$/);
const EnvironmentSchema = z.enum(["candidate-a", "preview", "production"]);

const RecoveryIdentitySchema = z
  .object({
    node: NodeSlugSchema,
    /** Exact initial losing head. Inferred for depth zero; signed on regenerated heads. */
    recoveryRootSha: GitShaSchema,
    /** Fresh-main regeneration count. Same-CAS transport retries do not increment it. */
    recoveryDepth: z.number().int().min(0).max(3),
  })
  .strict();

export const OperatorChangeIntentSchema = z.discriminatedUnion("operation", [
  RecoveryIdentitySchema.extend({
    operation: z.literal("env.membership"),
    environment: EnvironmentSchema,
    action: z.enum(["add", "remove"]),
    leaseGeneration: z.number().int().nonnegative(),
  }).strict(),
  RecoveryIdentitySchema.extend({
    operation: z.literal("env.placement"),
    environment: EnvironmentSchema,
    provider: z.enum(["k3s", "akash"]),
  }).strict(),
  RecoveryIdentitySchema.extend({
    operation: z.literal("env.region"),
    environment: EnvironmentSchema,
    countries: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1),
    leaseGeneration: z.number().int().nonnegative(),
  }).strict(),
  RecoveryIdentitySchema.extend({
    operation: z.literal("node.register"),
    nodeId: z.string().uuid(),
    sourceRepo: z.string().url(),
    sourceSha: GitShaSchema,
    ownerWallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  }).strict(),
  RecoveryIdentitySchema.extend({
    operation: z.literal("deployment.declare"),
  }).strict(),
]);

/** Stable input to both the Temporal workflow and the operator-internal route. */
export const OperatorChangeRecoveryRequestSchema = z
  .object({
    owner: RepoPartSchema,
    repo: RepoPartSchema,
    prNumber: z.number().int().positive(),
    signedBaseSha: GitShaSchema,
    losingHeadSha: GitShaSchema,
    intent: OperatorChangeIntentSchema,
  })
  .strict()
  .superRefine((request, context) => {
    if (
      request.intent.recoveryDepth === 0 &&
      request.intent.recoveryRootSha !== request.losingHeadSha
    ) {
      context.addIssue({
        code: "custom",
        path: ["intent", "recoveryRootSha"],
        message: "depth-zero recovery root must equal the losing head",
      });
    }
  });

/**
 * Semantic outcomes are HTTP 200. Transport/availability failures use HTTP
 * status and Temporal retry semantics instead of being encoded here.
 */
export const OperatorChangeRecoveryResultSchema = z.discriminatedUnion(
  "status",
  [
    z
      .object({
        status: z.literal("satisfied"),
        reason: z.enum([
          "main_equals_losing_head",
          "exact_pr_merged",
          "intent_already_satisfied",
        ]),
        mainSha: GitShaSchema,
      })
      .strict(),
    z
      .object({
        status: z.literal("landed"),
        mainSha: GitShaSchema,
      })
      .strict(),
    z
      .object({
        status: z.literal("regenerated"),
        baseSha: GitShaSchema,
        headSha: GitShaSchema,
        prNumber: z.number().int().positive(),
        prUrl: z.string().url(),
        recoveryDepth: z.number().int().min(1).max(3),
      })
      .strict(),
    z
      .object({
        status: z.literal("terminal"),
        reason: z.string().min(1),
      })
      .strict(),
  ]
);

export const operatorChangeRecoveryOperation = {
  id: "operator-change.recover.internal.v1",
  summary: "Recover one verified operator-generated change",
  description:
    "Internal scheduler-worker to operator delegation. Re-reads fresh GitHub state before retrying the same CAS, closing an already-satisfied change, or regenerating the original semantic intent from fresh main.",
  input: OperatorChangeRecoveryRequestSchema,
  output: OperatorChangeRecoveryResultSchema,
} as const;

export type OperatorChangeIntent = z.infer<typeof OperatorChangeIntentSchema>;
export type OperatorChangeRecoveryRequest = z.infer<
  typeof OperatorChangeRecoveryRequestSchema
>;
export type OperatorChangeRecoveryResult = z.infer<
  typeof OperatorChangeRecoveryResultSchema
>;
