// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@ports/node-service-link.port`
 * Purpose: Ports the operator's node-service link service needs (story.0038): the link row store, the
 *   enrollment signer, the transport to node X's public enrollment routes, the sealed-key crypto and the
 *   connection writer that vaults the X-issued key.
 * Scope: Interfaces and value types only. Adapters live in `adapters/server/node-service-links`.
 * Invariants:
 *   - NO_PLAINTEXT_AT_REST: the store AEAD-encrypts the device code and the private JWK; callers see
 *     plaintext only through `readSecrets`, which the poll step alone calls.
 *   - KEY_NEVER_RETURNED: nothing here returns an X-issued key to a model-visible path. `openSealedKey`
 *     hands it to the connection writer in the same step; the link service never logs or returns it.
 * Side-effects: none (interfaces only)
 * Links: https://node-template.cognidao.org/knowledge/node-service-enrollment, story.0038
 * @public
 */

import type {
  NodeServiceLinkStateValue,
  NodeServiceName,
  ServiceEnrollmentClaims,
} from "@cogni/node-contracts";

/** One link row as the service sees it (secrets excluded). */
export interface NodeServiceLinkRecord {
  readonly id: string;
  readonly nodeId: string;
  readonly service: NodeServiceName;
  /** Registered origin of X (`https://<host>`). */
  readonly audience: string;
  readonly state: NodeServiceLinkStateValue;
  readonly requestedByUserId: string;
  readonly jti: string;
  readonly pollIntervalS: number;
  readonly lastPolledAt: Date | null;
  readonly deviceCodeExpiresAt: Date;
  readonly connectionId: string | null;
  readonly failureCode: string | null;
  readonly createdAt: Date;
  readonly connectedAt: Date | null;
}

export interface NewNodeServiceLink {
  readonly nodeId: string;
  readonly service: NodeServiceName;
  readonly audience: string;
  readonly requestedByUserId: string;
  readonly jti: string;
  /** X's poll secret; stored AEAD-encrypted. */
  readonly deviceCode: string;
  /** Private half of the ephemeral X25519 key the key is sealed to; stored AEAD-encrypted. */
  readonly cnfPrivateJwk: Record<string, unknown>;
  readonly pollIntervalS: number;
  readonly deviceCodeExpiresAt: Date;
}

/** An open (`pending` or `connected`) link already exists for the node and service. */
export class OpenServiceLinkExistsError extends Error {
  constructor() {
    super("open_service_link_exists");
    this.name = "OpenServiceLinkExistsError";
  }
}

export interface NodeServiceLinkStorePort {
  /** Insert a `pending` row. @throws OpenServiceLinkExistsError on the one-open-link index. */
  insert(input: NewNodeServiceLink): Promise<NodeServiceLinkRecord>;
  findById(id: string): Promise<NodeServiceLinkRecord | null>;
  /** The `pending` or `connected` link for the node and service, if any. */
  findOpen(
    nodeId: string,
    service: NodeServiceName
  ): Promise<NodeServiceLinkRecord | null>;
  /** The `connected` link whose key is held for this origin (key-rejected handling). */
  findConnectedByAudience(
    audience: string,
    service: NodeServiceName
  ): Promise<NodeServiceLinkRecord | null>;
  /** Plaintext poll secrets of a `pending` link. Null once the link left `pending`. */
  readSecrets(id: string): Promise<{
    readonly deviceCode: string;
    readonly cnfPrivateJwk: Record<string, unknown>;
  } | null>;
  /**
   * Claim the poll slot of a `pending` link: true (and `last_polled_at = now`) only when the last poll
   * is at least `minGapMs` old, so two concurrent steps cannot both poll X (a replay supersedes the key).
   */
  claimPoll(id: string, now: Date, minGapMs: number): Promise<boolean>;
  setPollInterval(id: string, pollIntervalS: number): Promise<void>;
  /** `pending` to `connected`; clears the device code and the private key. */
  markConnected(id: string, connectionId: string): Promise<void>;
  /** Move to a non-`connected` state; clears secrets. */
  markState(
    id: string,
    state: Exclude<NodeServiceLinkStateValue, "pending" | "connected">,
    failureCode?: string
  ): Promise<void>;
  /** Link starts by one developer since `since` (the 5 per hour cap). */
  countStartsSince(userId: string, since: Date): Promise<number>;
}

export interface ServiceEnrollmentSignerPort {
  /** Sign `claims` as a `service.enrollment.v1` JWT (own `typ`). */
  sign(claims: ServiceEnrollmentClaims): Promise<string>;
}

/** What X answered when it accepted the signed enrollment token. */
export interface EnrollmentAccepted {
  readonly deviceCode: string;
  readonly expiresInS: number;
  readonly intervalS: number;
}

export type EnrollmentPollResult =
  | { readonly kind: "authorization_pending" }
  | { readonly kind: "slow_down" }
  | { readonly kind: "access_denied" }
  | { readonly kind: "expired_token" }
  | { readonly kind: "issued"; readonly sealedKey: string };

/** Failure talking to X's public enrollment routes. */
export class EnrollmentTransportError extends Error {
  constructor(
    readonly code:
      | "origin_unreachable"
      | "enrollment_rejected"
      | "replayed_token"
      | "bad_response",
    readonly status?: number
  ) {
    super(code);
    this.name = "EnrollmentTransportError";
  }
}

export interface NodeEnrollmentTransportPort {
  /** POST the signed token to X's `service-enrollments` route. */
  postEnrollment(origin: string, token: string): Promise<EnrollmentAccepted>;
  /** POST the device code to X's `service-enrollments/token` route. */
  pollToken(origin: string, deviceCode: string): Promise<EnrollmentPollResult>;
  /** Confirm the freshly stored key with X (`POST /api/v1/agent/credentials/confirm`). */
  confirmKey(
    origin: string,
    apiKey: string
  ): Promise<{ readonly ok: boolean; readonly status: number }>;
}

export interface ServiceKeyCryptoPort {
  generateLinkKeypair(): Promise<{
    readonly publicJwk: { kty: "OKP"; crv: "X25519"; x: string };
    readonly privateJwk: Record<string, unknown>;
  }>;
  /** Open the JWE (ECDH-ES, A256GCM) X sealed to the link key and return the key string. */
  openSealedKey(
    jwe: string,
    privateJwk: Record<string, unknown>
  ): Promise<string>;
}

export interface ServiceConnectionWriterPort {
  /**
   * Vault the X-issued key as the system tenant's `cogni-node` connection for `audience`, revoking
   * any earlier active row for that audience in the same transaction. Returns the connection id.
   */
  store(input: {
    readonly audience: string;
    readonly apiKey: string;
    readonly scopes: readonly string[];
  }): Promise<string>;
  /** Soft-revoke one connection (never hard delete). */
  revoke(connectionId: string): Promise<void>;
}
