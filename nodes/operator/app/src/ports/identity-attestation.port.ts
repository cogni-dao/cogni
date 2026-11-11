// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Infrastructure boundary used by the operator identity-attestation feature. */

export interface IdentityAttestationNode {
  readonly nodeId: string;
  readonly slug: string;
  readonly repoOwner: string | null;
  /** Repository NAME of the registry row's `repoUrl` (lowercase), or null when the URL is not a GitHub repo URL of `repoOwner`. */
  readonly repoName: string | null;
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

/** `github.comment.attestation.v1` claims (task.0095). Shape is owned by `@cogni/node-contracts`; the signer re-validates nothing. */
export interface GithubCommentAttestationJwtClaims {
  readonly type: "github.comment.attestation.v1";
  readonly protocol: string;
  readonly iss: string;
  readonly aud: string;
  readonly nodeId: string;
  readonly requestNonce: string;
  readonly readAt: number;
  readonly result: "found" | "not_found";
  readonly comment: Readonly<Record<string, unknown>> | null;
  readonly iat: number;
  readonly exp: number;
  readonly jti: string;
}

export interface IdentityAttestationSignerPort {
  sign(claims: IdentityAttestationJwtClaims): Promise<string>;
  /** Own JWS `typ` (`github.comment.attestation+jwt`) and own claim type. `sign` does not change. */
  signProofComment(claims: GithubCommentAttestationJwtClaims): Promise<string>;
}

/** What one GitHub call said. Only `ok` is evidence; the other two are never signed. */
export type GithubRead<T> =
  | { readonly kind: "ok"; readonly value: T }
  /** GitHub says the budget is out. `resetAt` is epoch seconds when GitHub gave one. */
  | { readonly kind: "rate_limited"; readonly resetAt: number | null }
  | {
      readonly kind: "error";
      readonly reasonCode:
        | "timeout"
        | "network"
        | "http_403"
        | "http_4xx"
        | "http_5xx"
        | "too_large"
        | "bad_body"
        | "auth";
      readonly status: number | null;
    };

/** The REST comment, as GitHub reported it. Field values are untrusted text until the service shapes them. */
export interface GithubIssueCommentRead {
  readonly nodeId: string;
  readonly issueUrl: string;
  readonly userId: number | null;
  readonly userType: string | null;
  readonly login: string | null;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Reads public GitHub data with the operator's own App. One method per GitHub call, so the service can count each cache-missing call
 * against its budgets (a 404 or an error costs the same as a hit). The reader signs nothing and decides nothing.
 */
export interface GithubProofCommentReaderPort {
  /** GraphQL `repository { isPrivate }`. `value: null` = the App cannot see the repository. */
  repositoryIsPrivate(repo: {
    owner: string;
    name: string;
  }): Promise<GithubRead<boolean | null>>;
  /** REST `GET /repos/{owner}/{repo}/issues/comments/{id}`. `value: null` = 404. Body capped at 256 KB. */
  readIssueComment(
    repo: { owner: string; name: string },
    commentId: number
  ): Promise<GithubRead<GithubIssueCommentRead | null>>;
  /** GraphQL `node(id){ ... on IssueComment { lastEditedAt } }`. `value: null` = the node is gone (not_found). */
  readCommentLastEditedAt(
    repo: { owner: string; name: string },
    commentNodeId: string
  ): Promise<GithubRead<{ readonly lastEditedAt: string | null } | null>>;
}
