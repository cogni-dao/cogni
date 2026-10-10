// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { EnvAuthorizationFacadeCredentialVerifierAdapter } from "@/adapters/server";
import type { AuthorizationFacadeCredentialVerifierPort } from "@/ports";
import type { ServerEnv } from "@/shared/env";

export function createAuthorizationFacadeCredentialVerifier(
  env: ServerEnv
): AuthorizationFacadeCredentialVerifierPort {
  const encoded = env.AUTHORIZATION_FACADE_VERIFIER_RINGS_JSON;
  if (!encoded) {
    throw new Error("authorization facade verifier projection is unavailable");
  }
  return new EnvAuthorizationFacadeCredentialVerifierAdapter(encoded);
}
