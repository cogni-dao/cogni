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
  // Node-formation MINTS repos (fork node-template, commit repo-spec, open the
  // pin PR) — a distinct, higher-privilege (repo-create) trust domain from PR
  // review / deploy dispatch. Prefer the dedicated formation App so an env can
  // scope repo-creation to its own git org (e.g. candidate-a → cogni-operator-test
  // on cogni-test-org, with ZERO reach into cogni-dao/cogni). Falls back to the
  // overloaded GH_REVIEW_APP when the formation App is unset, so existing envs are
  // unchanged until they set it explicitly (bug.5017, dao-governance-loop.md:371).
  const appId = env.GH_NODE_FORMATION_APP_ID ?? env.GH_REVIEW_APP_ID;
  const privateKeyB64 =
    env.GH_NODE_FORMATION_APP_PRIVATE_KEY_BASE64 ??
    env.GH_REVIEW_APP_PRIVATE_KEY_BASE64;
  if (!appId || !privateKeyB64) {
    throw new Error(
      "operator not configured for repo write: GH_NODE_FORMATION_APP_ID (or GH_REVIEW_APP_ID) + matching private key required"
    );
  }
  const privateKey = Buffer.from(privateKeyB64, "base64").toString("utf-8");
  return new GitHubRepoWriter({
    appId,
    privateKey,
    dnsReverseReconcile: env.DNS_REVERSE_RECONCILE,
  });
}
