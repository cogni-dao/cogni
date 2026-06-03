// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/vcs`
 * Purpose: Factory for VcsCapability — composes GitHubVcsAdapter with GitHub App credentials.
 * Scope: Creates VcsCapability from server environment. Does not implement transport.
 * Invariants:
 *   - NO_SECRETS_IN_CONTEXT: GitHub App credentials resolved from env, never passed to tools
 *   - GRACEFUL_DEGRADATION: Returns stub if GH_REVIEW_APP_ID not configured
 * Side-effects: none (factory only)
 * Links: task.0242, nodes/operator/app/src/adapters/server/vcs/github-vcs.adapter.ts
 * @internal
 */

import type { VcsCapability } from "@cogni/ai-tools";

import { GitHubVcsAdapter } from "@/adapters/server";
import type { ServerEnv } from "@/shared/env";

/**
 * Stub VcsCapability that throws when not configured.
 */
export const stubVcsCapability: VcsCapability = {
  listPrs: async () => {
    throw new Error(
      "VcsCapability not configured. Set GH_REVIEW_APP_ID and GH_REVIEW_APP_PRIVATE_KEY_BASE64."
    );
  },
  getCiStatus: async () => {
    throw new Error(
      "VcsCapability not configured. Set GH_REVIEW_APP_ID and GH_REVIEW_APP_PRIVATE_KEY_BASE64."
    );
  },
  mergePr: async () => {
    throw new Error(
      "VcsCapability not configured. Set GH_REVIEW_APP_ID and GH_REVIEW_APP_PRIVATE_KEY_BASE64."
    );
  },
  createBranch: async () => {
    throw new Error(
      "VcsCapability not configured. Set GH_REVIEW_APP_ID and GH_REVIEW_APP_PRIVATE_KEY_BASE64."
    );
  },
  dispatchCandidateFlight: async () => {
    throw new Error(
      "VcsCapability not configured. Set GH_REVIEW_APP_ID and GH_REVIEW_APP_PRIVATE_KEY_BASE64."
    );
  },
  approveForkChecks: async () => {
    throw new Error(
      "VcsCapability not configured. Set GH_REVIEW_APP_ID and GH_REVIEW_APP_PRIVATE_KEY_BASE64."
    );
  },
};

/**
 * Create VcsCapability from server environment.
 *
 * Requires GH_REVIEW_APP_ID + GH_REVIEW_APP_PRIVATE_KEY_BASE64.
 * Returns stub if credentials not configured (graceful degradation).
 *
 * @param env - Server environment
 * @returns VcsCapability backed by GitHubVcsAdapter or stub
 */
export function createVcsCapability(env: ServerEnv): VcsCapability {
  const appId = env.GH_REVIEW_APP_ID;
  const privateKeyBase64 = env.GH_REVIEW_APP_PRIVATE_KEY_BASE64;

  if (!appId || !privateKeyBase64) {
    return stubVcsCapability;
  }

  const privateKey = Buffer.from(privateKeyBase64, "base64").toString("utf-8");

  return new GitHubVcsAdapter({ appId, privateKey });
}
