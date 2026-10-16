// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Verifier-only boundary for lane-local authorization-facade credentials. */

export type AuthorizationFacadeCredentialVerification =
  | { readonly decision: "valid" }
  | { readonly decision: "invalid" }
  | { readonly decision: "unavailable" };

export interface AuthorizationFacadeCredentialVerifierPort {
  verify(input: {
    readonly lane: "candidate-a" | "preview" | "production";
    readonly nodeId: string;
    readonly presentedCredential: string;
  }): Promise<AuthorizationFacadeCredentialVerification>;
}
