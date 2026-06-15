// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/operator-deploy-plane`
 * Purpose: Factory for the operator-local deploy plane port.
 * Scope: Reads env and returns the GitHub App backed deploy-plane implementation.
 * Side-effects: none (adapter calls deferred to callers)
 * Links: src/ports/operator-deploy-plane.port.ts, src/adapters/server/vcs/github-repo-write.ts
 * @internal
 */

import { GitHubRepoWriter } from "@/adapters/server";
import type { OperatorDeployPlanePort } from "@/ports";
import type { ServerEnv } from "@/shared/env";

export function createOperatorDeployPlane(
  env: ServerEnv
): OperatorDeployPlanePort {
  if (!env.GH_REVIEW_APP_ID || !env.GH_REVIEW_APP_PRIVATE_KEY_BASE64) {
    throw new Error(
      "operator not configured for deploy plane: GH_REVIEW_APP_ID + GH_REVIEW_APP_PRIVATE_KEY_BASE64 required"
    );
  }
  const privateKey = Buffer.from(
    env.GH_REVIEW_APP_PRIVATE_KEY_BASE64,
    "base64"
  ).toString("utf-8");
  return new GitHubRepoWriter({
    appId: env.GH_REVIEW_APP_ID,
    privateKey,
  });
}
