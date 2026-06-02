// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/review/github-auth`
 * Purpose: Installation token factory for the Review GitHub App.
 * Scope: JWT signing + installation token exchange via @octokit/auth-app. Does not contain business logic.
 * Invariants: TOKEN_SHORT_LIVED — installation tokens are never persisted. NO_PROBOT_DEPENDENCY.
 * Side-effects: IO (GitHub API call to exchange JWT for installation token)
 * Links: task.0153, docs/spec/vcs-integration.md
 * @public
 */

import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/core";

/**
 * Create an authenticated Octokit instance for a specific GitHub App installation.
 * Uses JWT → installation token exchange.
 *
 * @param installationId - GitHub App installation ID (from webhook payload)
 * @param appId - GitHub App ID (GH_REVIEW_APP_ID)
 * @param privateKeyBase64 - Base64-encoded PEM private key (GH_REVIEW_APP_PRIVATE_KEY_BASE64)
 */
export function createInstallationOctokit(
  installationId: number,
  appId: string,
  privateKeyBase64: string
): Octokit {
  const privateKey = Buffer.from(privateKeyBase64, "base64").toString("utf-8");

  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId,
      privateKey,
      installationId,
    },
  });
}
