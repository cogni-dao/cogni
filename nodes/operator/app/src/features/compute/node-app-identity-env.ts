// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/compute/node-app-identity-env`
 * Purpose: Stamp the canonical identity/base-URL env onto a node-app container's
 *   environment, so every compute lane agrees on what the app calls itself.
 * Scope: Pure. Does NOT size workloads, render provider manifests, read OpenBao, or
 *   persist anything — the caller supplies the node's real connection env.
 * Invariants:
 *   - CANONICAL_IDENTITY_WINS: the keys stamped here override caller-supplied values,
 *     so a stale DSN bundle can never redirect NEXTAUTH_URL/APP_BASE_URL.
 * Side-effects: none (pure)
 * Links: compute-workload-reconciler.ts (sole caller; holds the workload invariants),
 *   packages/repo-spec/src/node-app-deployment.ts (authoritative workload sizing)
 * @internal
 */

/**
 * Overlay the canonical identity config onto a node's connection/secret env.
 * Caller env comes first so the identity keys below stay authoritative.
 */
export function buildNodeAppIdentityEnv(input: {
  slug: string;
  publicUrl: string;
  env: Readonly<Record<string, string>>;
}): Record<string, string> {
  return {
    ...input.env,
    NODE_NAME: input.slug,
    COGNI_REPO_PATH: "/app",
    AUTH_TRUST_HOST: "true",
    NEXTAUTH_URL: input.publicUrl,
    APP_BASE_URL: input.publicUrl,
  };
}
