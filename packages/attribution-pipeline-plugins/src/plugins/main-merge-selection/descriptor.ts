// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/attribution-pipeline-plugins/plugins/main-merge-selection/descriptor`
 * Purpose: Direct-to-main selection policy — a contribution IS a PR merged to `main`.
 * Scope: Pure selection logic. Does not perform I/O or access the store.
 * Invariants:
 * - SELECTION_POLICY_PURE: receives context, returns decisions — no store writes.
 * - MAIN_MERGE_IS_CONTRIBUTION: `pr_merged` with `baseBranch === "main"` is included.
 *   `review_submitted` on a merged-to-main PR is included (visibility). All other
 *   event types (and merges to non-main branches) are excluded. Excluded logins are
 *   always `included: false`.
 * Side-effects: none
 * Links: services/scheduler-worker/src/activities/ledger.ts, docs/spec/attribution-ledger.md
 *
 * Why this exists: `promotion-selection.v0` was built for a staging→main promotion
 * model where a direct-to-`main` PR is a "release PR" (reference data, NOT a
 * contribution). The repo merges feature/fix/chore PRs DIRECTLY to `main`
 * (canary/staging retired), so under promotion-selection every real PR is excluded
 * and epochs always have zero claimants. This policy is the inverse for the
 * direct-to-main workflow: the merge to `main` is the contribution.
 * @public
 */

import type { IngestionReceipt } from "@cogni/attribution-ledger";
import type {
  SelectionContext,
  SelectionDecision,
  SelectionPolicyDescriptor,
} from "@cogni/attribution-pipeline-contracts";

export const MAIN_MERGE_SELECTION_POLICY_REF =
  "cogni.main-merge-selection.v0" as const;

/**
 * Build the set of "repo:prNumber" identifiers for PRs merged to `main`, so reviews
 * on those PRs can be matched and included. PR number is derived from the receiptId
 * (`github:pr:owner/repo:42` → `42`), mirroring the promotion-selection convention.
 */
function buildMergedMainPrNumbers(
  allReceipts: readonly IngestionReceipt[]
): Set<string> {
  const prNumbers = new Set<string>();
  for (const receipt of allReceipts) {
    if (receipt.eventType !== "pr_merged" || !receipt.metadata) continue;
    const meta = receipt.metadata as Record<string, unknown>;
    if (meta.baseBranch !== "main") continue;
    const repo = meta.repo as string | undefined;
    const parts = receipt.receiptId.split(":");
    const prNum = parts[parts.length - 1];
    if (repo && prNum) {
      prNumbers.add(`${repo}:${prNum}`);
    }
  }
  return prNumbers;
}

/**
 * Determine inclusion for a single receipt under the direct-to-main policy.
 */
function decideInclusion(
  receipt: IngestionReceipt,
  mergedMainPrNumbers: Set<string>
): boolean {
  const meta = (receipt.metadata ?? {}) as Record<string, unknown>;

  if (receipt.eventType === "pr_merged") {
    // The merge to main IS the contribution.
    return meta.baseBranch === "main";
  }

  if (receipt.eventType === "review_submitted") {
    // Include reviews on PRs that merged to main (for visibility).
    const repo = meta.repo as string | undefined;
    const prNum = meta.prNumber as number | undefined;
    if (repo && prNum && mergedMainPrNumbers.has(`${repo}:${prNum}`)) {
      return true;
    }
    return false;
  }

  // All other event types (issues, comments, pushes, non-main merges): excluded.
  return false;
}

/**
 * Configuration for the main-merge-selection policy.
 * Allows excluding specific platform logins (e.g. automation bots).
 */
export interface MainMergeSelectionConfig {
  readonly excludedLogins?: readonly string[];
  /**
   * Repo allowlist e.g. ['cogni-dao/cogni']. Empty/undefined → no repo
   * filtering (fail-open).
   */
  readonly sourceRefs?: readonly string[];
}

/**
 * Factory: create a main-merge-selection policy with optional bot exclusion
 * and an optional fail-open repo allowlist (`sourceRefs`). When `sourceRefs`
 * is non-empty, a receipt whose `metadata.repo` is not in the allowlist is
 * excluded; an empty/undefined allowlist means no repo filtering.
 * Receipts from excluded logins are always `included: false`.
 */
export function createMainMergeSelectionPolicy(
  config?: MainMergeSelectionConfig
): SelectionPolicyDescriptor {
  const excludedLogins = new Set(config?.excludedLogins ?? []);
  const allowedRepos = new Set(config?.sourceRefs ?? []);
  return {
    policyRef: MAIN_MERGE_SELECTION_POLICY_REF,
    select(context: SelectionContext): SelectionDecision[] {
      const mergedMainPrNumbers = buildMergedMainPrNumbers(context.allReceipts);

      return context.receiptsToSelect.map((receipt) => {
        // Fail-open repo allowlist: only filter when sourceRefs is non-empty.
        const repo = (receipt.metadata as Record<string, unknown> | null)?.repo;
        if (
          allowedRepos.size > 0 &&
          (typeof repo !== "string" || !allowedRepos.has(repo))
        ) {
          return { receiptId: receipt.receiptId, included: false };
        }

        return {
          receiptId: receipt.receiptId,
          included:
            receipt.platformLogin && excludedLogins.has(receipt.platformLogin)
              ? false
              : decideInclusion(receipt, mergedMainPrNumbers),
        };
      });
    },
  };
}

/** Default instance — no exclusions. */
export const MAIN_MERGE_SELECTION_POLICY: SelectionPolicyDescriptor =
  createMainMergeSelectionPolicy();
