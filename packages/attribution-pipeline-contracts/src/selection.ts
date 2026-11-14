// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/attribution-pipeline-contracts/selection`
 * Purpose: Selection policy contracts — determine which receipts are included in an epoch.
 * Scope: Types, context interface, and dispatch function. Does not perform I/O or contain side effects.
 * Invariants:
 * - FRAMEWORK_NO_IO: this module contains zero I/O.
 * - SELECTION_POLICY_PURE: policies receive context and return inclusion decisions — no store writes.
 * - SELECTION_POLICY_PLUGGABLE: adding a new selection policy requires zero changes to the framework.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/attribution-plugin-pipeline
 * @public
 */

import type { IngestionReceipt } from "@cogni/attribution-ledger";

/**
 * Decision for a single receipt: should it be included in the epoch?
 */
export interface SelectionDecision {
  readonly receiptId: string;
  readonly included: boolean;
}

/**
 * Context passed to a selection policy's `select()` function.
 * Contains all receipts in the epoch window — both the unselected batch
 * and the full receipt set (for cross-referencing, e.g., cross-epoch promotion lookups).
 */
export interface SelectionContext {
  /** Receipts needing a selection decision (the current unselected batch). */
  readonly receiptsToSelect: readonly IngestionReceipt[];
  /** All receipts for the node (for cross-referencing, including cross-epoch). */
  readonly allReceipts: readonly IngestionReceipt[];
}

/**
 * Descriptor for a selection policy plugin.
 * Policies are pure functions: they receive context and return decisions.
 * They do NOT write to the store — the caller handles persistence.
 */
export interface SelectionPolicyDescriptor {
  /** Policy ref (e.g., "cogni.promotion-selection.v0"). */
  readonly policyRef: string;

  /**
   * Determine inclusion for each receipt in the batch.
   * Must return a decision for every receipt in `context.receiptsToSelect`.
   * Deterministic: same inputs → same outputs.
   */
  readonly select: (context: SelectionContext) => SelectionDecision[];
}

/** Registry mapping policyRef → SelectionPolicyDescriptor. */
export type SelectionPolicyRegistry = ReadonlyMap<
  string,
  SelectionPolicyDescriptor
>;

/**
 * Dispatch to a selection policy by ref.
 * Throws if the policy is unknown.
 * Validates that decisions cover all input receipts.
 */
export function dispatchSelectionPolicy(
  registry: SelectionPolicyRegistry,
  policyRef: string,
  context: SelectionContext
): SelectionDecision[] {
  const descriptor = registry.get(policyRef);
  if (!descriptor) {
    const available = [...registry.keys()].join(", ");
    throw new Error(
      `Unknown selection policy: "${policyRef}". Available: [${available}]`
    );
  }

  const decisions = descriptor.select(context);

  // Validate coverage: every receipt must have a decision
  const decisionIds = new Set(decisions.map((d) => d.receiptId));
  const missing = context.receiptsToSelect.filter(
    (r) => !decisionIds.has(r.receiptId)
  );
  if (missing.length > 0) {
    throw new Error(
      `Selection policy "${policyRef}" did not return decisions for ${missing.length} receipts: [${missing.map((r) => r.receiptId).join(", ")}]`
    );
  }

  return decisions;
}
