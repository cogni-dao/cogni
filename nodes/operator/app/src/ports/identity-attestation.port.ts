// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Infrastructure boundary used by the operator identity-attestation feature. */

export interface IdentityAttestationNode {
  readonly nodeId: string;
  readonly slug: string;
  readonly deployEnvs: readonly string[];
}

export interface IdentityAttestationSubject {
  readonly walletAddress: string | null;
  readonly github: {
    readonly id: string;
    readonly login: string | null;
  } | null;
}

export interface IdentityAttestationRepositoryPort {
  findNode(nodeId: string): Promise<IdentityAttestationNode | null>;
  findSubject(
    userId: string,
    fallbackWalletAddress: string | null
  ): Promise<IdentityAttestationSubject>;
}

export interface IdentityAttestationJwtClaims {
  readonly type: "identity.attestation.v1";
  readonly protocol: string;
  readonly iss: string;
  readonly sub: string;
  readonly aud: string;
  readonly nodeId: string;
  readonly nonce: string;
  readonly targetOrigin: string;
  readonly wallet: string;
  readonly github: { readonly id: string; readonly login: string | null };
  readonly iat: number;
  readonly exp: number;
  readonly jti: string;
}

export interface IdentityAttestationSignerPort {
  sign(claims: IdentityAttestationJwtClaims): Promise<string>;
}
