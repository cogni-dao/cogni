// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/review/resolve-review-route`
 * Purpose: Bootstrap helper for the internal review GitHub-plane routes — bearer
 *   auth + GitHub App adapter resolution. Lives in bootstrap so the app/route
 *   layer can wire the server adapter without importing `adapters/server/*`
 *   directly (no-restricted-imports boundary).
 * Scope: Auth gate + adapter construction only. No GitHub I/O (that lives in the
 *   adapter).
 * Invariants:
 *   - INTERNAL_API_SHARED_SECRET: Bearer SCHEDULER_API_TOKEN required.
 *   - Returns 503 when the operator lacks GitHub App creds (review unconfigured).
 * Side-effects: none
 * Links: bug.5000, adapters/server/review/github-review.adapter.ts
 * @internal
 */

import { verifySchedulerBearer } from "@cogni/node-shared";
import { NextResponse } from "next/server";
import type { Logger } from "pino";
import {
  createGithubReviewAdapter,
  type GithubReviewAdapter,
} from "@/adapters/server";
import { serverEnv } from "@/shared/env";

type Resolved =
  | { ok: true; adapter: GithubReviewAdapter }
  | { ok: false; response: NextResponse };

/**
 * Authorize the scheduler bearer token and build the review GitHub adapter.
 * Returns a typed result: either the adapter or the NextResponse to return.
 */
export function resolveReviewRoute(request: Request, log: Logger): Resolved {
  const env = serverEnv();

  if (
    !verifySchedulerBearer(
      request.headers.get("authorization"),
      env.SCHEDULER_API_TOKEN
    )
  ) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  if (!env.GH_REVIEW_APP_ID || !env.GH_REVIEW_APP_PRIVATE_KEY_BASE64) {
    log.error("Review GitHub plane unconfigured — GH_REVIEW_APP_* not set");
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Review GitHub plane not configured" },
        { status: 503 }
      ),
    };
  }

  const adapter = createGithubReviewAdapter({
    appId: env.GH_REVIEW_APP_ID,
    privateKeyBase64: env.GH_REVIEW_APP_PRIVATE_KEY_BASE64,
    logger: log,
  });
  return { ok: true, adapter };
}
