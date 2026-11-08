// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/operator-deploy-plane`
 * Purpose: Factory for the operator-local deploy plane port.
 * Scope: Reads env and returns the GitHub App backed deploy-plane implementation.
 * Side-effects: none (adapter calls deferred to callers)
 * Links: src/ports/deploy-plane.port.ts, src/adapters/server/vcs/github-repo-write.ts
 * @internal
 */

import {
  AppOrPublicDeclarationReader,
  GitHubPublicReader,
  GitHubRepoWriter,
  listCatalogNodesVia,
} from "@/adapters/server";
import type { DeployPlanePort } from "@/ports";
import type { ServerEnv } from "@/shared/env";

export function createOperatorDeployPlane(env: ServerEnv): DeployPlanePort {
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
    fleetControlEnv: env.FLEET_CONTROL_ENV,
    hostingEnv: env.DEPLOY_ENVIRONMENT,
    parentOwner: env.NODE_SUBMODULE_PARENT_OWNER,
    parentRepo: env.NODE_SUBMODULE_PARENT_REPO,
    // WORKLOAD public domain: DOMAIN (e.g. cogni-testing.org on the test-parent)
    // wins over the SUBSTRATE root FORK_DOMAIN_ROOT (cognidao.org); they diverge on
    // the test-parent mirror. Byte-exact twin of render-node-overlays.sh's
    // ${DOMAIN:-${FORK_DOMAIN_ROOT:-cognidao.org}} precedence (test-fleet-parity-boundary).
    forkDomainRoot: env.DOMAIN ?? env.FORK_DOMAIN_ROOT,
  });
}

let cachedCatalogReader: AppOrPublicDeclarationReader | undefined;

/**
 * Catalog node lister for the env's canonical catalog repo (bug.5596). The operator App reads it
 * where installed; where the App is NOT installed (the candidate's test App on the public
 * cogni-dao/cogni) the same read goes anonymously to raw.githubusercontent.com / api.github.com.
 * Private repos keep the App-only behavior: App-not-installed + not public reads as absent, never
 * with a credential. One process-wide reader remembers which repos the App is not installed on, so
 * the install lookup is paid once rather than on every read.
 */
export function createCatalogNodeLister(
  env: ServerEnv
): Pick<DeployPlanePort, "listCatalogNodes"> {
  cachedCatalogReader ??= new AppOrPublicDeclarationReader(
    createOperatorDeployPlane(env),
    new GitHubPublicReader()
  );
  const reader = cachedCatalogReader;
  return {
    listCatalogNodes: (input) => listCatalogNodesVia(reader, input),
  };
}
