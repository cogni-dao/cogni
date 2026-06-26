// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/review/resolve-review-route`
 * Purpose: Bootstrap helper for resolving the review GitHub-plane adapter.
 * Scope: Adapter construction only. No GitHub I/O (that lives in the adapter).
 * Invariants:
 *   - Returns null when the operator lacks GitHub App creds.
 * Side-effects: none
 * Links: adapters/server/review/github-review.adapter.ts
 * @internal
 */

import type { Logger } from "pino";
import {
  createGithubReviewAdapter,
  type GithubReviewAdapter,
} from "@/adapters/server";
import { serverEnv } from "@/shared/env";

export function resolveGithubReviewAdapter(
  log: Logger
): GithubReviewAdapter | null {
  const env = serverEnv();

  if (!env.GH_REVIEW_APP_ID || !env.GH_REVIEW_APP_PRIVATE_KEY_BASE64) {
    log.error("Review GitHub plane unconfigured - GH_REVIEW_APP_* not set");
    return null;
  }

  return createGithubReviewAdapter({
    appId: env.GH_REVIEW_APP_ID,
    privateKeyBase64: env.GH_REVIEW_APP_PRIVATE_KEY_BASE64,
    logger: log,
  });
}
