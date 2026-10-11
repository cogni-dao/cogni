// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/operator-app-credentials`
 * Purpose: Platform-owned GitHub App credential rotation — the typed
 *   `OperatorSecretsPlane` capability for the ONE credential pair the operator
 *   itself consumes (`GH_REVIEW_APP_ID` + `GH_REVIEW_APP_PRIVATE_KEY_BASE64` at
 *   `cogni/<env>/operator`). Two boundaries, one adapter each:
 *   OpenBao (atomic pair read/write) and GitHub (read-only App identity probes).
 * Scope: Interfaces + typed shapes only. The ceremony DECISION logic is pure and
 *   lives in `features/secrets/app-credential-rotation`; orchestration in
 *   `features/secrets/app-credential-rotation.service` (deps-injected, shared by
 *   the routes and the scheduled job).
 * Invariants:
 *   - SERVER_OWNED_COORDINATES: env, OpenBao path, expected App identity,
 *     installation owner, and webhook host are never caller inputs — they come
 *     from the operator's own configuration. A caller supplies ONLY the staged
 *     pair (subtask.5016 acceptance).
 *   - ATOMIC_PAIR_CAS (C4): both keys land in ONE KV-v2 write guarded by
 *     check-and-set at the version the preceding read observed — no torn pair,
 *     no lost-sibling race.
 *   - FINGERPRINTS_NOT_VALUES: reads surface the public-key SHA-256 fingerprint
 *     and the App ID only; private-key bytes never cross this port's result types.
 *   - GITHUB_IS_READ_ONLY (C1): this plane NEVER mutates GitHub. Minting the new
 *     key (FIRST — two keys concurrently valid) and revoking the superseded one
 *     (LAST — only after propagation is verified) are human/owner ceremony steps
 *     outside this port. No revoke method exists by design.
 * Side-effects: none (interfaces)
 * Links: docs/spec/cicd-platform-boundary.md (OperatorSecretsPlanePort row),
 *   docs/spec/secrets-management.md (Invariants 4, 7, 9), subtask.5016,
 *   src/ports/operator-secrets-plane.port.ts (the node self-serve sibling)
 * @public
 */

/** Non-secret view of the pair currently stored at `cogni/<env>/operator`. */
export interface StoredAppCredentialPair {
  /** False when either key is absent at the path (or the bucket is missing). */
  readonly configured: boolean;
  /** `GH_REVIEW_APP_ID` as stored — an App ID is public, not a secret. */
  readonly appId?: string | undefined;
  /** sha256(SPKI DER of the public half), hex — never key bytes. */
  readonly privateKeyFingerprint?: string | undefined;
  /**
   * Set when the stored private key exists but does not parse as key material —
   * a corrupt custody that a rotation must replace, never report as `current`.
   */
  readonly privateKeyUnparseable?: boolean | undefined;
  /** Current KV-v2 version of the bucket (0 when the bucket does not exist). */
  readonly version: number;
}

export interface WriteAppCredentialPairInput {
  /** Operator-stamped env (`DEPLOY_ENVIRONMENT`) — never a caller value. */
  readonly env: string;
  readonly appId: string;
  /** Staged private key, base64-encoded PEM. Never logged; body-only transport. */
  readonly privateKeyBase64: string;
  /**
   * KV-v2 check-and-set guard: the bucket version the preceding read observed.
   * A concurrent writer bumps the version and this write fails typed
   * (`openbao_cas_conflict`) instead of silently interleaving (C4).
   */
  readonly expectedVersion: number;
}

export interface WriteAppCredentialPairResult {
  /** KV-v2 version produced by the atomic pair write. */
  readonly version: number;
}

/**
 * OpenBao custody for the operator's own App credential pair. Implemented by
 * `OpenBaoAppCredentialsAdapter` (pod projected-SA self-login, same identity as
 * the node self-serve writer).
 */
export interface OperatorAppCredentialsStorePort {
  /** Read the pair's non-secret identity at `cogni/<env>/operator`. */
  readStoredAppCredentialPair(env: string): Promise<StoredAppCredentialPair>;
  /** ONE KV-v2 write of BOTH keys with check-and-set (C4). */
  writeAppCredentialPair(
    input: WriteAppCredentialPairInput
  ): Promise<WriteAppCredentialPairResult>;
}

/** What a staged (or stored) credential proved against live GitHub. Read-only. */
export type AppCredentialVerification =
  | {
      /** Key bytes unusable, GitHub rejected the JWT, or GET /app identity ≠ claimed App. */
      readonly kind: "invalid";
      readonly reason:
        | "invalid_key_material"
        | "unauthenticated"
        | "identity_mismatch";
    }
  | {
      /** GitHub/network failure that proves nothing about the credential (C2: never success). */
      readonly kind: "transport_failure";
      readonly status?: number | undefined;
    }
  | {
      readonly kind: "verified";
      readonly appId: string;
      readonly appSlug: string;
      /** Host of the App's webhook URL (`GET /app/hook/config`), null when unset. */
      readonly webhookHost: string | null;
      /** Owner logins of the App's installations (`GET /app/installations`). */
      readonly installationOwners: readonly string[];
    };

/**
 * Read-only GitHub App identity probe: App JWT → `GET /app`,
 * `GET /app/hook/config`, `GET /app/installations`. NEVER a mutation (C1).
 */
export interface GithubAppIdentityPort {
  verifyAppCredential(input: {
    readonly appId: string;
    readonly privateKeyBase64: string;
  }): Promise<AppCredentialVerification>;
}
