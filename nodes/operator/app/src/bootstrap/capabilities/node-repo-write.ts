// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/node-repo-write`
 * Purpose: Thin factory that the wizard API route calls to commit `.cogni/repo-spec.yaml` and open
 *   a PR on the target repo via the cogni-node-template GitHub App.
 * Scope: Reads env, returns a ready-to-call writer; route never imports the adapter directly.
 * Side-effects: none (adapter call deferred to caller)
 * Links: src/adapters/server/vcs/github-repo-write.ts, task.5083
 * @internal
 */

import { GitHubRepoWriter } from "@/adapters/server";
import type { ServerEnv } from "@/shared/env";

export function createNodeRepoWriter(env: ServerEnv): GitHubRepoWriter {
  if (!env.GH_REVIEW_APP_ID || !env.GH_REVIEW_APP_PRIVATE_KEY_BASE64) {
    throw new Error(
      "operator not configured for repo write: GH_REVIEW_APP_ID + GH_REVIEW_APP_PRIVATE_KEY_BASE64 required"
    );
  }
  const privateKey = Buffer.from(
    env.GH_REVIEW_APP_PRIVATE_KEY_BASE64,
    "base64"
  ).toString("utf-8");
  return new GitHubRepoWriter({
    appId: env.GH_REVIEW_APP_ID,
    privateKey,
    dnsReverseReconcile: env.DNS_REVERSE_RECONCILE,
  });
}
