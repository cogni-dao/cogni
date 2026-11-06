// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Infrastructure boundary used by the operator identity-attestation feature. */

export interface IdentityAttestationNode {
  readonly nodeId: string;
  readonly slug: string;
  readonly repoOwner: string | null;
  readonly deployEnvs: readonly string[];
}

export interface IdentityAttestationGithubIdentity {
  readonly id: string;
  readonly login: string | null;
}

/**
 * Node registry only. There is deliberately NO subject lookup here: the attested
 * GitHub identity comes from the authorization response for the request being
 * brokered, never from an operator account or a stored binding (task.5024).
 */
export interface IdentityAttestationRepositoryPort {
  findNode(nodeId: string): Promise<IdentityAttestationNode | null>;
}

export interface IdentityAttestationJwtClaims {
  readonly type: "identity.attestation.v1";
  readonly protocol: string;
  readonly iss: string;
  readonly aud: string;
  readonly nodeId: string;
  readonly nonce: string;
  readonly targetOrigin: string;
  readonly github: { readonly id: string; readonly login: string | null };
  readonly iat: number;
  readonly exp: number;
  readonly jti: string;
}

export interface IdentityAttestationSignerPort {
  sign(claims: IdentityAttestationJwtClaims): Promise<string>;
}
