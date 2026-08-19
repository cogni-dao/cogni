// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/_facades/identity/attestation-broker.server`
 * Purpose: Completes the authenticated browser leg of identity.attestation.v1.
 * Scope: Validates return_to, resolves configured signing custody, and delegates
 *   all registered-node/origin/claim policy to the identity feature service.
 * Invariants:
 *   - NO_OPEN_REDIRECT: return_to must be exactly the registered node's
 *     canonical `/profile` URL in one of its registered deploy environments.
 *   - SAME_REQUEST_BINDING: the exact nodeId + nonce + registered targetOrigin validated by the shared
 *     contract are passed unchanged to the issuer.
 *   - FRAGMENT_ONLY: the signed token is returned in a URL fragment, never a
 *     query string or cross-origin fetch response.
 * Side-effects: IO (registry/user reads)
 * @public
 */

import type { KeyObject } from "node:crypto";

import {
  IdentityAttestationOriginSchema,
  type IdentityAttestationRequest,
} from "@cogni/node-contracts";
import type { SessionUser } from "@cogni/node-shared";
import { resolveIdentityAttestationDependencies } from "@/bootstrap/identity-attestation";
import {
  AttestationPreconditionError,
  createIdentityAttestationService,
} from "@/features/identity/services/issue-identity-attestation";
import { serverEnv } from "@/shared/env";
import { importAttestationSigningKey } from "@/shared/identity/attestation-keys";
import { baseDomain } from "@/shared/node-registry/resolve";

export type AttestationBrokerErrorCode =
  | "attestation_unavailable"
  | "invalid_return_to"
  | "no_github_binding"
  | "no_wallet"
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

/** Exact allowlist check: canonical registered-node origin plus `/profile`. */
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
      url.pathname !== "/profile" ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    ) {
      return null;
    }
    return `${expectedNodeOrigin}/profile`;
  } catch {
    return null;
  }
}

export async function issueBrowserIdentityAttestation(params: {
  sessionUser: SessionUser;
  request: IdentityAttestationRequest;
  returnTo: string;
}): Promise<{ redirectUrl: string }> {
  const env = serverEnv();
  const issuer = canonicalOrigin(env.APP_BASE_URL);
  const domain = baseDomain(env);
  if (
    !issuer ||
    !domain ||
    !env.IDENTITY_ATTESTATION_PRIVATE_KEY ||
    !env.NODE_SUBMODULE_PARENT_OWNER ||
    !env.NODE_SUBMODULE_PARENT_REPO ||
    !env.GH_REVIEW_APP_ID ||
    !env.GH_REVIEW_APP_PRIVATE_KEY_BASE64
  ) {
    throw new AttestationBrokerError("attestation_unavailable");
  }

  const safeReturnTo = validateAttestationReturnTo(
    params.returnTo,
    params.request.targetOrigin
  );
  if (!safeReturnTo) {
    throw new AttestationBrokerError("invalid_return_to");
  }

  let signingKey: KeyObject;
  try {
    signingKey = importAttestationSigningKey(
      env.IDENTITY_ATTESTATION_PRIVATE_KEY
    );
  } catch {
    throw new AttestationBrokerError("attestation_unavailable");
  }

  try {
    const service = createIdentityAttestationService(
      resolveIdentityAttestationDependencies(signingKey)
    );
    const issued = await service.issue({
      userId: params.sessionUser.id,
      fallbackWalletAddress: params.sessionUser.walletAddress,
      issuer,
      domain,
      request: params.request,
    });
    return {
      redirectUrl: `${safeReturnTo}#attestation=${encodeURIComponent(
        issued.attestation
      )}`,
    };
  } catch (error) {
    if (error instanceof AttestationPreconditionError) {
      throw new AttestationBrokerError(
        error.code === "invalid_target_origin"
          ? "invalid_return_to"
          : error.code
      );
    }
    throw error;
  }
}
