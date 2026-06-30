// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/attribution-pipeline-plugins/tests/plugins/main-merge-selection/descriptor`
 * Purpose: Unit tests for main-merge-selection policy — direct-to-main PRs are contributions.
 * Scope: Pure unit tests against the selection policy descriptor. Does not test I/O or store writes.
 * Invariants: SELECTION_POLICY_PURE, MAIN_MERGE_IS_CONTRIBUTION
 * Side-effects: none
 * Links: packages/attribution-pipeline-plugins/src/plugins/main-merge-selection/descriptor.ts
 * @internal
 */

import type { IngestionReceipt } from "@cogni/attribution-ledger";
import { describe, expect, it } from "vitest";
import {
  createMainMergeSelectionPolicy,
  MAIN_MERGE_SELECTION_POLICY,
  MAIN_MERGE_SELECTION_POLICY_REF,
} from "../../../src/plugins/main-merge-selection/descriptor";

/** Helper: build a minimal IngestionReceipt for test fixtures. */
function makeReceipt(
  overrides: Partial<IngestionReceipt> & { receiptId: string }
): IngestionReceipt {
  return {
    nodeId: "node-1",
    source: "github",
    eventType: "pr_merged",
    platformUserId: "12345",
    platformLogin: null,
    artifactUrl: null,
    metadata: null,
    payloadHash: "abc",
    producer: "github",
    producerVersion: "1.0.0",
    eventTime: new Date("2026-06-29"),
    retrievedAt: new Date("2026-06-29"),
    ingestedAt: new Date("2026-06-29"),
    ...overrides,
  };
}

describe("createMainMergeSelectionPolicy", () => {
  it("PR merged directly to main IS included (the inverse of promotion-selection)", () => {
    const policy = createMainMergeSelectionPolicy({
      excludedLogins: ["Cogni-1729"],
    });
    const mainPr = makeReceipt({
      receiptId: "github:pr:Cogni-DAO/cogni:42",
      platformLogin: "derekg1729",
      metadata: { baseBranch: "main", repo: "Cogni-DAO/cogni" },
    });

    const decisions = policy.select({
      receiptsToSelect: [mainPr],
      allReceipts: [mainPr],
    });

    expect(decisions[0].included).toBe(true);
  });

  it("excluded login (bot) on a main merge is NOT included", () => {
    const policy = createMainMergeSelectionPolicy({
      excludedLogins: ["Cogni-1729"],
    });
    const botPr = makeReceipt({
      receiptId: "github:pr:Cogni-DAO/cogni:43",
      platformLogin: "Cogni-1729",
      metadata: { baseBranch: "main", repo: "Cogni-DAO/cogni" },
    });

    const decisions = policy.select({
      receiptsToSelect: [botPr],
      allReceipts: [botPr],
    });

    expect(decisions[0].included).toBe(false);
  });

  it("merge to a non-main branch is NOT a contribution", () => {
    const policy = createMainMergeSelectionPolicy();
    const featurePr = makeReceipt({
      receiptId: "github:pr:Cogni-DAO/cogni:44",
      platformLogin: "derekg1729",
      metadata: { baseBranch: "release/v2", repo: "Cogni-DAO/cogni" },
    });

    const decisions = policy.select({
      receiptsToSelect: [featurePr],
      allReceipts: [featurePr],
    });

    expect(decisions[0].included).toBe(false);
  });

  it("review on a PR merged to main is included (visibility)", () => {
    const policy = createMainMergeSelectionPolicy();
    const mainPr = makeReceipt({
      receiptId: "github:pr:Cogni-DAO/cogni:50",
      platformLogin: "authorA",
      metadata: { baseBranch: "main", repo: "Cogni-DAO/cogni" },
    });
    const review = makeReceipt({
      receiptId: "github:review:51",
      eventType: "review_submitted",
      platformLogin: "reviewerB",
      metadata: { repo: "Cogni-DAO/cogni", prNumber: 50 },
    });

    const decisions = policy.select({
      receiptsToSelect: [review],
      allReceipts: [mainPr, review],
    });

    expect(decisions[0].included).toBe(true);
  });

  it("review on a PR that did NOT merge to main is excluded", () => {
    const policy = createMainMergeSelectionPolicy();
    const featurePr = makeReceipt({
      receiptId: "github:pr:Cogni-DAO/cogni:60",
      platformLogin: "authorA",
      metadata: { baseBranch: "dev", repo: "Cogni-DAO/cogni" },
    });
    const review = makeReceipt({
      receiptId: "github:review:61",
      eventType: "review_submitted",
      platformLogin: "reviewerB",
      metadata: { repo: "Cogni-DAO/cogni", prNumber: 60 },
    });

    const decisions = policy.select({
      receiptsToSelect: [review],
      allReceipts: [featurePr, review],
    });

    expect(decisions[0].included).toBe(false);
  });

  it("other event types (issue_closed) are excluded", () => {
    const policy = createMainMergeSelectionPolicy();
    const issue = makeReceipt({
      receiptId: "github:issue:70",
      eventType: "issue_closed",
      platformLogin: "derekg1729",
      metadata: { repo: "Cogni-DAO/cogni" },
    });

    const decisions = policy.select({
      receiptsToSelect: [issue],
      allReceipts: [issue],
    });

    expect(decisions[0].included).toBe(false);
  });

  it("null platformLogin on a main merge is unaffected by the exclusion list", () => {
    const policy = createMainMergeSelectionPolicy({
      excludedLogins: ["Cogni-1729"],
    });
    const pr = makeReceipt({
      receiptId: "github:pr:Cogni-DAO/cogni:80",
      platformLogin: null,
      metadata: { baseBranch: "main", repo: "Cogni-DAO/cogni" },
    });

    const decisions = policy.select({
      receiptsToSelect: [pr],
      allReceipts: [pr],
    });

    expect(decisions[0].included).toBe(true);
  });

  it("sourceRefs allowlist EXCLUDES a main merge whose repo is not in the list", () => {
    const policy = createMainMergeSelectionPolicy({
      sourceRefs: ["cogni-test-org/test-cog"],
    });
    const otherRepoPr = makeReceipt({
      receiptId: "github:pr:cogni-test-org/other:100",
      platformLogin: "derekg1729",
      metadata: { baseBranch: "main", repo: "cogni-test-org/other" },
    });

    const decisions = policy.select({
      receiptsToSelect: [otherRepoPr],
      allReceipts: [otherRepoPr],
    });

    expect(decisions[0].included).toBe(false);
  });

  it("sourceRefs allowlist INCLUDES a main merge whose repo matches", () => {
    const policy = createMainMergeSelectionPolicy({
      sourceRefs: ["cogni-test-org/test-cog"],
    });
    const allowedPr = makeReceipt({
      receiptId: "github:pr:cogni-test-org/test-cog:101",
      platformLogin: "derekg1729",
      metadata: { baseBranch: "main", repo: "cogni-test-org/test-cog" },
    });

    const decisions = policy.select({
      receiptsToSelect: [allowedPr],
      allReceipts: [allowedPr],
    });

    expect(decisions[0].included).toBe(true);
  });

  it("empty/undefined sourceRefs is fail-open: both repos are included", () => {
    const otherRepoPr = makeReceipt({
      receiptId: "github:pr:cogni-test-org/other:102",
      platformLogin: "derekg1729",
      metadata: { baseBranch: "main", repo: "cogni-test-org/other" },
    });
    const allowedRepoPr = makeReceipt({
      receiptId: "github:pr:cogni-test-org/test-cog:103",
      platformLogin: "derekg1729",
      metadata: { baseBranch: "main", repo: "cogni-test-org/test-cog" },
    });

    // undefined sourceRefs
    const defaultPolicy = createMainMergeSelectionPolicy();
    const defaultDecisions = defaultPolicy.select({
      receiptsToSelect: [otherRepoPr, allowedRepoPr],
      allReceipts: [otherRepoPr, allowedRepoPr],
    });
    expect(defaultDecisions[0].included).toBe(true);
    expect(defaultDecisions[1].included).toBe(true);

    // explicit empty sourceRefs
    const emptyPolicy = createMainMergeSelectionPolicy({ sourceRefs: [] });
    const emptyDecisions = emptyPolicy.select({
      receiptsToSelect: [otherRepoPr, allowedRepoPr],
      allReceipts: [otherRepoPr, allowedRepoPr],
    });
    expect(emptyDecisions[0].included).toBe(true);
    expect(emptyDecisions[1].included).toBe(true);
  });

  it("factory default behaves identically to MAIN_MERGE_SELECTION_POLICY constant", () => {
    const defaultPolicy = createMainMergeSelectionPolicy();
    const mainPr = makeReceipt({
      receiptId: "github:pr:Cogni-DAO/cogni:90",
      platformLogin: "derekg1729",
      metadata: { baseBranch: "main", repo: "Cogni-DAO/cogni" },
    });
    const context = { receiptsToSelect: [mainPr], allReceipts: [mainPr] };

    expect(defaultPolicy.select(context)).toEqual(
      MAIN_MERGE_SELECTION_POLICY.select(context)
    );
    expect(defaultPolicy.policyRef).toBe(MAIN_MERGE_SELECTION_POLICY_REF);
  });
});
