// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_api/reviewedClose`
 * Purpose: Validate frozen review links and read their selected contribution records.
 * Scope: Operator browser composition; never grants authority or mutates on read.
 * Invariants: BOUNDED_REVIEW_SELECTION, NULL_HEAD_IS_EXPLICIT, GET_NEVER_CLOSES.
 * Side-effects: IO (bounded serial authenticated GETs)
 * @internal
 */

import type { ContributionRecord } from "@cogni/node-contracts";
import { z } from "zod";
import { fetchContribution } from "./fetchContribution";

const ReviewSchema = z
  .strictObject({
    reason: z.string().trim().min(1).max(512),
    items: z
      .array(
        z.strictObject({
          contributionId: z.string().min(1).max(128),
          expectedHeadCommit: z.string().min(1).max(128).nullable(),
        })
      )
      .min(1)
      .max(50),
  })
  .refine(
    (value) =>
      new Set(value.items.map((item) => item.contributionId)).size ===
      value.items.length,
    "Duplicate contribution IDs"
  );

export type ReviewedCloseSelection = z.infer<typeof ReviewSchema>;
export type ReviewedCloseRow = {
  item: ReviewedCloseSelection["items"][number];
  record?: ContributionRecord;
  error?: string;
};

export function parseReviewedClose(value: string): ReviewedCloseSelection {
  if (encodeURIComponent(value).length > 16_384)
    throw new Error("Review link is too large.");
  return ReviewSchema.parse(JSON.parse(value));
}

export function isReviewedCloseEligible(row: ReviewedCloseRow): boolean {
  return (
    row.record?.state === "open" &&
    row.record.headCommit === row.item.expectedHeadCommit
  );
}

export async function loadReviewedClose(
  selection: ReviewedCloseSelection,
  stillMounted: () => boolean = () => true
): Promise<ReviewedCloseRow[]> {
  const rows: ReviewedCloseRow[] = [];
  for (const item of selection.items) {
    if (!stillMounted()) break;
    try {
      const record = await fetchContribution(
        item.contributionId,
        AbortSignal.timeout(10_000)
      );
      rows.push({ item, record });
    } catch {
      rows.push({ item, error: "Could not read this proposal; excluded." });
    }
  }
  return rows;
}
