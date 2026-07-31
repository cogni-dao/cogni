// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/attribution-pipeline-plugins/plugins/promotion-selection/descriptor`
 * Purpose: Production-promotion selection policy — includes staging PRs only when promoted to main via release PRs.
 * Scope: Pure selection logic. Does not perform I/O or access the store.
 * Invariants:
 * - SELECTION_POLICY_PURE: receives context, returns decisions — no store writes.
 * - PRODUCTION_PROMOTION: staging PRs included only when their mergeCommitSha appears in a release PR's commitShas.
 *   Release PRs (baseBranch=main) are reference data only (included=false).
 *   Reviews on promoted PRs are included for visibility.
 * Side-effects: none
 * Links: packages/attribution-collect/src/activities/ledger.ts
 * @public
 */

import type { IngestionReceipt } from "@cogni/attribution-ledger";
import type {
  SelectionContext,
  SelectionDecision,
  SelectionPolicyDescriptor,
} from "@cogni/attribution-pipeline-contracts";

export const PROMOTION_SELECTION_POLICY_REF =
  "cogni.promotion-selection.v0" as const;

/**
 * Build the set of promoted merge commit SHAs from release PRs merged to main.
 * A release PR (baseBranch=main) contains staging squash commits in its commitShas.
 */
function buildPromotedShas(
  allReceipts: readonly IngestionReceipt[]
): Set<string> {
  const promotedShas = new Set<string>();
  for (const receipt of allReceipts) {
    if (receipt.eventType !== "pr_merged" || !receipt.metadata) continue;
    const meta = receipt.metadata as Record<string, unknown>;
    if (meta.baseBranch !== "main") continue;
    const commitShas = meta.commitShas as string[] | undefined;
    if (commitShas) {
      for (const sha of commitShas) {
        promotedShas.add(sha);
      }
    }
  }
  return promotedShas;
}

/**
 * Build set of promoted PR identifiers ("repo:prNumber") for review matching.
 */
function buildPromotedPrNumbers(
  allReceipts: readonly IngestionReceipt[],
  promotedShas: Set<string>
): Set<string> {
  const promotedPrNumbers = new Set<string>();
  for (const receipt of allReceipts) {
    if (receipt.eventType !== "pr_merged" || !receipt.metadata) continue;
    const meta = receipt.metadata as Record<string, unknown>;
    if (meta.baseBranch === "main") continue;
    if (
      meta.mergeCommitSha &&
      promotedShas.has(meta.mergeCommitSha as string)
    ) {
      const repo = meta.repo as string;
      const parts = receipt.receiptId.split(":");
      const prNum = parts[parts.length - 1];
      if (repo && prNum) {
        promotedPrNumbers.add(`${repo}:${prNum}`);
      }
    }
  }
  return promotedPrNumbers;
}

/**
 * Determine inclusion for a single receipt under the promotion policy.
 */
function decideInclusion(
  receipt: IngestionReceipt,
  promotedShas: Set<string>,
  promotedPrNumbers: Set<string>
): boolean {
  const meta = (receipt.metadata ?? {}) as Record<string, unknown>;

  if (receipt.eventType === "pr_merged") {
    if (meta.baseBranch === "main") {
      // Release PR itself — not included (reference data only)
      return false;
    }
    if (
      meta.mergeCommitSha &&
      promotedShas.has(meta.mergeCommitSha as string)
    ) {
      // Staging PR whose merge commit appears in a release PR → promoted
      return true;
    }
    return false;
  }

  if (receipt.eventType === "review_submitted") {
    // Include reviews on promoted staging PRs (for visibility)
    const repo = meta.repo as string | undefined;
    const prNum = meta.prNumber as number | undefined;
    if (repo && prNum && promotedPrNumbers.has(`${repo}:${prNum}`)) {
      return true;
    }
    return false;
  }

  // All other event types: not included
  return false;
}

/**
 * Configuration for the promotion-selection policy.
 * Allows excluding specific platform logins (e.g. automation bots).
 */
export interface PromotionSelectionConfig {
  readonly excludedLogins?: readonly string[];
}

/**
 * Factory: create a promotion-selection policy with optional bot exclusion.
 * Receipts from excluded logins are always `included: false`.
 */
export function createPromotionSelectionPolicy(
  config?: PromotionSelectionConfig
): SelectionPolicyDescriptor {
  const excludedLogins = new Set(config?.excludedLogins ?? []);
  return {
    policyRef: PROMOTION_SELECTION_POLICY_REF,
    select(context: SelectionContext): SelectionDecision[] {
      const promotedShas = buildPromotedShas(context.allReceipts);
      const promotedPrNumbers = buildPromotedPrNumbers(
        context.allReceipts,
        promotedShas
      );

      return context.receiptsToSelect.map((receipt) => ({
        receiptId: receipt.receiptId,
        included:
          receipt.platformLogin && excludedLogins.has(receipt.platformLogin)
            ? false
            : decideInclusion(receipt, promotedShas, promotedPrNumbers),
      }));
    },
  };
}

/** Default instance — no exclusions, backward-compatible. */
export const PROMOTION_SELECTION_POLICY: SelectionPolicyDescriptor =
  createPromotionSelectionPolicy();
