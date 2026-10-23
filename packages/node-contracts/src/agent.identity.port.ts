// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/node-contracts/agent.identity.port`
 * Purpose: Portable target-node boundary for durable AI lifecycle implementations.
 * Scope: Shared types and errors only. Does not persist identities, issue secrets, or authorize accounts.
 * Invariants: TARGET_NODE_OWNS_IDENTITY; CREDENTIAL_NE_PRINCIPAL; ROTATION_PRESERVES_ACTOR; NO_AUTH_SECRET_FALLBACK.
 * Side-effects: none
 * Links: https://cognidao.org/knowledge/human-ai-identity-standard, story.5075
 * @public
 */

import type { AgentRequestPrincipal } from "./agent.credentials.v1.contract";

export type AgentCredentialAccess = "active" | "renew_only";

export interface AgentCredentialMaterial {
  readonly actorId: string;
  readonly principalId: `agent:${string}`;
  readonly credentialId: string;
  readonly apiKey: string;
  readonly billingAccountId: string;
  readonly authenticateUntil: string;
  readonly renewUntil: string;
}

export interface AgentCredentialStatus {
  readonly principal: AgentRequestPrincipal;
  readonly access: AgentCredentialAccess;
  readonly authenticateUntil: string;
  readonly renewUntil: string;
}

/**
 * `grantTransferRequired: false` means the role copy is durably complete, but
 * the returned credential remains pending until the client confirms it.
 */
export type LegacyAgentUpgrade = AgentCredentialMaterial &
  (
    | { readonly grantTransferRequired: false }
    | {
        readonly grantTransferRequired: true;
        readonly transferLeaseId: string;
      }
  );

export interface AgentIdentityPort {
  getAcceptedStewardship(actorId: string): Promise<{
    readonly stewardUserId: string;
    readonly billingAccountId: string;
  } | null>;
  createExistingAgentClaim(input: {
    readonly stewardUserId: string;
    readonly actorId: string;
    readonly provider: "github";
    readonly externalId: string;
    readonly providerLogin: string | null;
    readonly attestationJti: string;
    readonly attestationEvidence: Record<string, unknown>;
    readonly attestationExpiresAt: Date;
    readonly idempotencyKey: string;
  }): Promise<{
    readonly claimId: string;
    readonly actorId: string;
    readonly provider: "github";
    readonly providerLogin: string | null;
    readonly status: "pending_ai_acceptance" | "accepted";
    readonly expiresAt: string;
  }>;
  acceptExistingAgentClaim(input: {
    readonly actorId: string;
    readonly claimId: string;
  }): Promise<{
    readonly claimId: string;
    readonly actorId: string;
    readonly provider: "github";
    readonly providerLogin: string | null;
    readonly status: "pending_ai_acceptance" | "accepted";
    readonly expiresAt: string;
  }>;
  suspendAgent(input: {
    readonly stewardUserId: string;
    readonly actorId: string;
    readonly reason: string;
  }): Promise<{ readonly actorId: string; readonly status: "suspended" }>;
  createSpawnGrant(input: {
    readonly issuerUserId: string;
    readonly name: string;
    readonly idempotencyKey: string;
  }): Promise<{
    readonly grantId: string;
    readonly token: string;
    readonly expiresAt: string;
  }>;
  redeemSpawnGrant(token: string): Promise<AgentCredentialMaterial>;
  authenticate(
    token: string,
    mode?: "data" | "renew"
  ): Promise<AgentCredentialStatus | null>;
  rotate(input: {
    readonly token: string;
    readonly idempotencyKey: string;
  }): Promise<
    AgentCredentialMaterial & {
      readonly predecessorCredentialId: string;
      readonly pendingExpiresAt: string;
    }
  >;
  confirm(token: string): Promise<AgentCredentialStatus>;
  createRecoveryGrant(input: {
    readonly issuerUserId: string;
    readonly actorId: string;
    readonly idempotencyKey: string;
  }): Promise<{
    readonly grantId: string;
    readonly token: string;
    readonly expiresAt: string;
  }>;
  recover(token: string): Promise<AgentCredentialMaterial>;
  upgradeLegacy(input: {
    readonly legacyToken: string;
    readonly legacyUserId: string;
    readonly displayName: string | null;
    readonly idempotencyKey: string;
  }): Promise<LegacyAgentUpgrade>;
  /** Marks the one-time role copy complete without activating the bearer. */
  completeLegacyGrantTransfer(input: {
    readonly legacyUserId: string;
    readonly credentialId: string;
    readonly transferLeaseId: string;
  }): Promise<void>;
  /** Releases an unfinished role-copy lease so an exact retry may resume it. */
  releaseLegacyGrantTransfer(input: {
    readonly legacyUserId: string;
    readonly credentialId: string;
    readonly transferLeaseId: string;
  }): Promise<void>;
}

export class AgentIdentityError extends Error {
  constructor(
    readonly code:
      | "invalid_grant"
      | "grant_expired"
      | "grant_already_redeemed"
      | "spawn_limit"
      | "grant_limit"
      | "rotation_pending"
      | "invalid_credential"
      | "recovery_denied"
      | "billing_account_missing"
      | "claim_denied"
      | "claim_expired"
      | "claim_conflict",
    message: string
  ) {
    super(message);
    this.name = "AgentIdentityError";
  }
}
