// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/connection-broker.port`
 * Purpose: Port interface for encrypted credential resolution from the connections table.
 * Scope: Resolves connectionId to decrypted credentials. Handles tenant verification, expiry check, and refresh.
 *   Used by BYOExecutorDecorator (model backend) and future toolRunner (tool auth).
 * Invariants:
 * - BROKER_RESOLVES_ALL: Single credential resolution path. Adapters never do direct DB reads + decrypt.
 * - TENANT_SCOPED: Verifies connection belongs to the caller's billing account.
 * - TOKENS_NEVER_LOGGED: Resolved credentials must not appear in logs or error messages.
 * Side-effects: none (interface only)
 * Links: docs/spec/tenant-connections.md, nodes/operator/app/src/adapters/server/connections/drizzle-broker.adapter.ts
 * @public
 */

/**
 * Resolved connection credentials returned by the broker.
 * Provider-agnostic — the caller decides how to use the credentials
 * based on the `provider` field.
 */
export interface ResolvedConnection {
  readonly connectionId: string;
  readonly provider: string;
  readonly credentialType: string;
  readonly credentials: {
    readonly accessToken: string;
    readonly refreshToken?: string;
    readonly accountId?: string;
    readonly idToken?: string;
  };
  readonly expiresAt: Date | null;
  readonly scopes: readonly string[];
}

/** Security scope for connection resolution — defines the trust boundary. */
export interface ConnectionScope {
  /** The actor requesting access */
  readonly actorId: string;
  /** The tenant boundary — connection must belong to this tenant */
  readonly tenantId: string;
}

/**
 * Connection broker port.
 * Resolves a connectionId to decrypted credentials with tenant verification.
 */
export interface ConnectionBrokerPort {
  /**
   * Resolve a connection by ID with tenant + actor verification.
   * @throws if connection not found, revoked, or belongs to a different tenant.
   */
  resolve(
    connectionId: string,
    scope: ConnectionScope
  ): Promise<ResolvedConnection>;
}
