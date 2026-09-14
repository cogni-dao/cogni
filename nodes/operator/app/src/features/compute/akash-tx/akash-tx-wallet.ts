// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/compute/akash-tx/akash-tx-wallet`
 * Purpose: The construction-time gate that makes ONE_WALLET_ONE_WRITER structurally true —
 *   resolves the actuator's DEDICATED per-environment Akash Console credential and its ledger
 *   wallet scope, and refuses to hand back anything that could serialize two writers against
 *   one wallet (task.5095).
 * Scope: Pure resolution + refusal over explicitly passed values. Reads no process env, opens no
 *   socket, and starts nothing on import — the caller supplies `serverEnv()` fields at wiring
 *   time (which no code does yet; the actuator is unwired in this PR).
 * Invariants:
 *   - DEDICATED_CREDENTIAL_OR_NOTHING: `AKASH_ACTUATOR_CONSOLE_API_KEY` is REQUIRED and never
 *     falls back to the legacy controller's `AKASH_CONSOLE_API_KEY`. Omission cannot silently
 *     point the actuator at the wallet the ComputeWorkload controller is already spending from.
 *   - DISTINCT_FROM_LEGACY_WRITER: if the two credentials are byte-equal, resolution FAILS. One
 *     Console wallet with two independent writers makes cursor recovery unsound — the actuator
 *     would adopt a lease the legacy controller paid for.
 *   - SCOPE_IS_PER_ENVIRONMENT: the ledger scope is `akash-console:<environment>` and the
 *     credential is declared per environment in the secrets catalog, so each env's wallet is
 *     serialized by exactly one env's Postgres. Per-env Postgres over ONE shared wallet is the
 *     unsound shape this exists to prevent.
 *   - SCOPE_IS_ROTATION_STABLE: the scope is derived from the environment, never from the secret
 *     value, so rotating the credential cannot orphan in-flight allocation receipts.
 *   - NEVER_LOGS_OR_RETURNS_THE_VALUE_IN_AN_ERROR: refusals carry a stable code only.
 * Side-effects: none
 * Links: @shared/db/akash-tx-allocations, ./akash-tx-actuator,
 *   infra/secrets-catalog.yaml (AKASH_ACTUATOR_CONSOLE_API_KEY), task.5095
 * @internal
 */

/** Stable refusal reasons. Config failures surface at wiring time, never as a request status. */
export type AkashTxWalletConfigErrorCode =
  | "actuator_credential_missing"
  | "actuator_credential_shared_with_legacy_writer"
  | "environment_missing";

/**
 * A boot/wiring-time misconfiguration. Deliberately NOT an `AkashTxError`: there is no request
 * to answer and no HTTP status to map — the actuator must simply not exist in this shape.
 */
export class AkashTxWalletConfigError extends Error {
  readonly code: AkashTxWalletConfigErrorCode;

  constructor(code: AkashTxWalletConfigErrorCode, message: string) {
    super(message);
    this.name = "AkashTxWalletConfigError";
    this.code = code;
  }
}

export interface AkashTxWalletInput {
  /** Deployment environment (`serverEnv().DEPLOY_ENVIRONMENT`). One wallet per environment. */
  readonly environment?: string | undefined;
  /** `AKASH_ACTUATOR_CONSOLE_API_KEY` — the actuator's OWN Console account. */
  readonly actuatorApiKey?: string | undefined;
  /** `AKASH_CONSOLE_API_KEY` — the legacy ComputeWorkload controller's wallet. Compared, never used. */
  readonly legacyControllerApiKey?: string | undefined;
}

export interface AkashTxWalletIdentity {
  /** Ledger serialization domain written to `akash_tx_allocations.wallet_scope`. */
  readonly walletScope: string;
  /** The dedicated actuator credential, proven distinct from the legacy writer's. */
  readonly apiKey: string;
}

function clean(value: string | undefined): string {
  return (value ?? "").trim();
}

/**
 * Resolve the actuator's wallet identity, or refuse.
 *
 * The only sound v0 of "one wallet, one writer" that does not require retiring the legacy
 * controller first is a SECOND, dedicated Console account per environment. This function is
 * where that stops being a convention and becomes a precondition: there is no code path that
 * yields a usable identity while the legacy controller's wallet is in play.
 */
export function resolveAkashTxWallet(
  input: AkashTxWalletInput
): AkashTxWalletIdentity {
  const environment = clean(input.environment);
  if (!environment) {
    throw new AkashTxWalletConfigError(
      "environment_missing",
      "Akash tx actuator requires DEPLOY_ENVIRONMENT: the wallet scope is per-environment."
    );
  }

  const apiKey = clean(input.actuatorApiKey);
  if (!apiKey) {
    throw new AkashTxWalletConfigError(
      "actuator_credential_missing",
      "Akash tx actuator requires a dedicated AKASH_ACTUATOR_CONSOLE_API_KEY. " +
        "It deliberately does not fall back to AKASH_CONSOLE_API_KEY — that wallet already has a writer."
    );
  }

  if (apiKey === clean(input.legacyControllerApiKey)) {
    throw new AkashTxWalletConfigError(
      "actuator_credential_shared_with_legacy_writer",
      "AKASH_ACTUATOR_CONSOLE_API_KEY must not equal AKASH_CONSOLE_API_KEY. " +
        "Two writers on one Console wallet make cursor-based recovery unsound: the actuator " +
        "could adopt a lease the ComputeWorkload controller paid for."
    );
  }

  return { walletScope: `akash-console:${environment}`, apiKey };
}
