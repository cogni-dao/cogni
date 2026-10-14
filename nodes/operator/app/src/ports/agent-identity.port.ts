// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/agent-identity`
 * Purpose: Durable agent actor and credential lifecycle boundary.
 * Scope: Interfaces only; secret generation, persistence, and request delivery live outside this port.
 * Invariants: CREDENTIAL_NE_PRINCIPAL; ROTATION_PRESERVES_ACTOR; NO_AUTH_SECRET_FALLBACK.
 * Side-effects: none
 * Links: task.5211, task.5217
 * @public
 */

import type { AgentRequestPrincipal } from "@cogni/node-contracts";

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

export interface AgentIdentityPort {
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
  }): Promise<AgentCredentialMaterial>;
}

export class AgentIdentityError extends Error {
  constructor(
    readonly code:
      | "invalid_grant"
      | "grant_expired"
      | "spawn_limit"
      | "rotation_pending"
      | "invalid_credential"
      | "recovery_denied"
      | "billing_account_missing",
    message: string
  ) {
    super(message);
    this.name = "AgentIdentityError";
  }
}
