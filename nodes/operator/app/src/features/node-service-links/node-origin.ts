// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-service-links/node-origin`
 * Purpose: The registered origin of node X in THIS operator's environment (story.0038). A test operator
 *   links to `<slug>-test.<root>`, preview to `<slug>-preview.<root>`, production to `<slug>.<root>`.
 * Scope: Pure host-string derivation from the node registry row and the operator's own apex. Does no IO.
 * Invariants:
 *   - ORIGIN_FROM_REGISTRY_NEVER_BODY: callers pass the resolved slug and deploy envs; no request field
 *     chooses the origin.
 *   - REGISTERED_ENV_ONLY: a node not deployed in this operator's env has no origin (null), so no
 *     enrollment token is ever sent to a host the registry does not list.
 * Side-effects: none
 * Links: src/shared/node-registry/deploy-hosts.ts, story.0038
 * @public
 */

import {
  envForApex,
  hostForEnv,
  rootDomain,
} from "@/shared/node-registry/deploy-hosts";
import { baseDomain } from "@/shared/node-registry/resolve";

export function registeredNodeOrigin(input: {
  readonly slug: string;
  readonly deployEnvs: readonly string[];
  readonly env: {
    readonly DOMAIN?: string | undefined;
    readonly APP_BASE_URL?: string | undefined;
  };
}): string | null {
  const apex = baseDomain(input.env);
  if (!apex) return null;
  const flightEnv = envForApex(apex);
  if (!input.deployEnvs.includes(flightEnv)) return null;
  return `https://${hostForEnv(input.slug, false, flightEnv, rootDomain(apex))}`;
}
