// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/_facades/identity/attestation-broker.server`
 * Purpose: Completes the browser legs of `identity.attestation.v1` — validate the node
 *   request, then (after GitHub has authenticated an account and the human has confirmed
 *   it) sign the attestation and hand it back to the exact registered node origin.
 * Scope: Validates return_to, resolves configured signing custody, and delegates all
 *   registered-node/origin policy to the identity feature service.
 * Invariants:
 *   - SUBJECT_FROM_AUTHORIZATION_ONLY: the attested GitHub identity is supplied by the
 *     caller from the authorization response for THIS request. There is no operator
 *     session, no operator `user_id`, and no `user_bindings` read anywhere in this flow.
 *     An ambient session silently selecting the subject is the confused deputy that
 *     bound the wrong account on the 2026-08-19 candidate (task.5024).
 *   - NO_OPEN_REDIRECT: return_to must be exactly the registered node's canonical
 *     `/profile` URL in one of its registered deploy environments.
 *   - SAME_REQUEST_BINDING: the exact nodeId + nonce + registered targetOrigin validated by
 *     the shared contract are passed unchanged to the issuer.
 *   - FRAGMENT_ONLY: the signed token is returned in a URL fragment, never a query string
 *     or cross-origin fetch response. It is `aud`-, `nodeId`- and nonce-bound, so it is
 *     inert without the relying node's unconsumed one-time nonce.
 * Side-effects: IO (registry reads)
 * @public
 */

import type { KeyObject } from "node:crypto";

import {
  IdentityAttestationOriginSchema,
  type IdentityAttestationRequest,
} from "@cogni/node-contracts";
import { resolveIdentityAttestationDependencies } from "@/bootstrap/identity-attestation";
import {
  AttestationPreconditionError,
  createIdentityAttestationService,
  type ResolvedAttestationNode,
} from "@/features/identity/services/issue-identity-attestation";
import type { IdentityAttestationGithubIdentity } from "@/ports";
import { serverEnv } from "@/shared/env";
import { importAttestationSigningKey } from "@/shared/identity/attestation-keys";
import { ATTESTATION_RETURN_PATHS } from "@/shared/identity/broker-config";

export type AttestationBrokerErrorCode =
  | "attestation_unavailable"
  | "invalid_return_to"
  | "invalid_target_origin"
  | "unknown_node";

export class AttestationBrokerError extends Error {
  constructor(readonly code: AttestationBrokerErrorCode) {
    super(code);
    this.name = "AttestationBrokerError";
  }
}

function canonicalOrigin(configured: string | undefined): string | null {
  if (!configured) return null;
  const parsed = IdentityAttestationOriginSchema.safeParse(configured);
  return parsed.success ? parsed.data : null;
}

/** Exact allowlist check: canonical registered-node origin plus an allowed path. */
export function validateAttestationReturnTo(
  returnTo: string,
  expectedNodeOrigin: string
): string | null {
  if (!IdentityAttestationOriginSchema.safeParse(expectedNodeOrigin).success) {
    return null;
  }
  try {
    const url = new URL(returnTo);
    if (
      url.origin !== expectedNodeOrigin ||
      !ATTESTATION_RETURN_PATHS.includes(url.pathname) ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    ) {
      return null;
    }
    return `${expectedNodeOrigin}${url.pathname}`;
  } catch {
    return null;
  }
}

export interface BrokerConfig {
  issuer: string;
  signingKey: KeyObject;
}

/** Issuer origin and signing key. Shared with the proof-comment facade (task.0095): the same key signs both token types. */
export function resolveBrokerConfig(): BrokerConfig {
  const env = serverEnv();
  const issuer = canonicalOrigin(env.APP_BASE_URL);
  if (
    !issuer ||
    !env.IDENTITY_ATTESTATION_PRIVATE_KEY ||
    !env.NODE_SUBMODULE_PARENT_OWNER ||
    !env.NODE_SUBMODULE_PARENT_REPO ||
    !env.GH_REVIEW_APP_ID ||
    !env.GH_REVIEW_APP_PRIVATE_KEY_BASE64
  ) {
    throw new AttestationBrokerError("attestation_unavailable");
  }
  try {
    return {
      issuer,
      signingKey: importAttestationSigningKey(
        env.IDENTITY_ATTESTATION_PRIVATE_KEY
      ),
    };
  } catch {
    throw new AttestationBrokerError("attestation_unavailable");
  }
}

function mapPreconditionError(error: unknown): never {
  if (error instanceof AttestationPreconditionError) {
    // Pass the precondition code through: "this origin is not registered for the node" is a
    // different fault from "return_to is malformed" and needs its own error page (bug.5596).
    throw new AttestationBrokerError(error.code);
  }
  throw new AttestationBrokerError("attestation_unavailable");
}

/**
 * Entry leg. Proves the request names a registered node, a registered deploy origin,
 * and an exact `/profile` return URL — BEFORE the human is sent to GitHub, so a bad
 * request fails immediately instead of after an authentication nobody can use.
 */
export async function resolveAttestationTarget(params: {
  request: IdentityAttestationRequest;
  returnTo: string;
}): Promise<{ node: ResolvedAttestationNode; safeReturnTo: string }> {
  const config = resolveBrokerConfig();
  const safeReturnTo = validateAttestationReturnTo(
    params.returnTo,
    params.request.targetOrigin
  );
  if (!safeReturnTo) {
    throw new AttestationBrokerError("invalid_return_to");
  }

  try {
    const service = createIdentityAttestationService(
      resolveIdentityAttestationDependencies(config.signingKey)
    );
    const node = await service.resolveNode({
      request: params.request,
    });
    return { node, safeReturnTo };
  } catch (error) {
    return mapPreconditionError(error);
  }
}

/**
 * Confirmation leg. `github` MUST come from the authorization response correlated to
 * this request — never from a session or a stored binding.
 */
export async function issueBrowserIdentityAttestation(params: {
  github: IdentityAttestationGithubIdentity;
  request: IdentityAttestationRequest;
  returnTo: string;
}): Promise<{ redirectUrl: string }> {
  const config = resolveBrokerConfig();
  const safeReturnTo = validateAttestationReturnTo(
    params.returnTo,
    params.request.targetOrigin
  );
  if (!safeReturnTo) {
    throw new AttestationBrokerError("invalid_return_to");
  }

  try {
    const service = createIdentityAttestationService(
      resolveIdentityAttestationDependencies(config.signingKey)
    );
    const issued = await service.issue({
      github: params.github,
      issuer: config.issuer,
      request: params.request,
    });
    return {
      redirectUrl: `${safeReturnTo}#attestation=${encodeURIComponent(
        issued.attestation
      )}`,
    };
  } catch (error) {
    return mapPreconditionError(error);
  }
}
