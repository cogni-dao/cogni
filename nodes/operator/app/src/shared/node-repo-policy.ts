// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@shared/node-repo-policy`
 * Purpose: Parse the versioned repository-protection policy owned by node-template.
 * Scope: Pure JSON validation only; GitHub reads and ruleset writes remain in the VCS adapter.
 * Invariants: TEMPLATE_POLICY_IS_SSOT, NO_BYPASS_ACTORS, REQUIRED_CHECKS_NONEMPTY.
 * Side-effects: none
 * Links: task.5028, Cogni-DAO/node-template:.cogni/repo-policy.json
 * @internal
 */

import { z } from "zod";

export const NODE_REPO_POLICY_PATH = ".cogni/repo-policy.json";

const PullRequestPolicySchema = z
  .object({
    allowedMergeMethods: z.array(z.enum(["merge", "squash", "rebase"])).min(1),
    dismissStaleReviewsOnPush: z.boolean(),
    requireCodeOwnerReview: z.boolean(),
    requireLastPushApproval: z.boolean(),
    requiredApprovingReviewCount: z.number().int().min(0).max(6),
    requiredReviewThreadResolution: z.boolean(),
  })
  .strict();

const RequiredStatusChecksPolicySchema = z
  .object({
    doNotEnforceOnCreate: z.boolean(),
    strict: z.boolean(),
    contexts: z
      .array(z.string().min(1))
      .min(1)
      .refine((contexts) => new Set(contexts).size === contexts.length, {
        message: "required status-check contexts must be unique",
      }),
  })
  .strict();

export const NodeRepoPolicySchema = z
  .object({
    schemaVersion: z.literal("cogni.node-repo-policy.v1"),
    ruleset: z
      .object({
        name: z.string().min(1),
        target: z.literal("default_branch"),
        enforcement: z.literal("active"),
        pullRequest: PullRequestPolicySchema,
        requiredStatusChecks: RequiredStatusChecksPolicySchema,
        bypassActors: z.array(z.never()).max(0),
      })
      .strict(),
  })
  .strict();

export type NodeRepoPolicy = z.infer<typeof NodeRepoPolicySchema>;

export function parseNodeRepoPolicy(text: string): NodeRepoPolicy {
  return NodeRepoPolicySchema.parse(JSON.parse(text));
}
