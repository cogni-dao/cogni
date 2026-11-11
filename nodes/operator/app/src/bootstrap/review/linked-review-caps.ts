// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/review/linked-review-caps`
 * Purpose: Per-developer and per-node hourly caps for reviews of a LINKED node (story.0038), enforced in
 *   the review facade before any GitHub read.
 * Scope: Two in-process token buckets (the same class the public routes use). Constants, no setting.
 * Invariants:
 *   - CAPS_ARE_CONSTANTS: 3 reviews per developer per hour and 10 per node per hour; no burst.
 *   - PER_REPLICA: state is per process, like the registration buckets (an accepted v0 limit).
 * Side-effects: global (in-memory buckets)
 * Links: src/bootstrap/http/rateLimiter.ts, src/app/_facades/review/request.server.ts
 * @public
 */

import { TokenBucketRateLimiter } from "@/bootstrap/http/rateLimiter";

export const LINKED_REVIEWS_PER_DEVELOPER_PER_HOUR = 3;
export const LINKED_REVIEWS_PER_NODE_PER_HOUR = 10;

const perDeveloper = new TokenBucketRateLimiter({
  maxTokens: LINKED_REVIEWS_PER_DEVELOPER_PER_HOUR,
  refillRate: LINKED_REVIEWS_PER_DEVELOPER_PER_HOUR / 3600,
  burstSize: 0,
});
const perNode = new TokenBucketRateLimiter({
  maxTokens: LINKED_REVIEWS_PER_NODE_PER_HOUR,
  refillRate: LINKED_REVIEWS_PER_NODE_PER_HOUR / 3600,
  burstSize: 0,
});

/** Consume one review for this developer and node; false when either cap is spent. */
export function consumeLinkedReview(input: {
  readonly developerId: string;
  readonly nodeId: string;
}): boolean {
  if (!perNode.consume(input.nodeId)) return false;
  return perDeveloper.consume(input.developerId);
}
