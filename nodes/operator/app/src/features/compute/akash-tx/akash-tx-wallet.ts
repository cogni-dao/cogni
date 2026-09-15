// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/compute/akash-tx/akash-tx-wallet`
 * Purpose: The construction-time gate that makes ONE_WALLET_ONE_WRITER structurally true —
 *   resolves the actuator's Akash Console credential plus the NON-SECRET account identity it is
 *   authorized to spend from, and refuses to hand back anything that could serialize two writers
 *   against one wallet (task.5095, amended by story.5016).
 * Scope: Pure resolution + refusal over explicitly passed values. Reads no process env, opens no
 *   socket, and starts nothing on import — the caller supplies the projected credential and the
 *   pinned account id at wiring time, and separately feeds it the Console's own account read.
 * Invariants:
 *   - THE_ACTUATOR_HOLDS_EXACTLY_ONE_WALLET: there is no input for the legacy ComputeWorkload
 *     controller's `AKASH_CONSOLE_API_KEY`. It is not projected into the pod and cannot be
 *     compared, because possessing both credentials is the opposite of isolating them. The
 *     legacy writer is separated by REVOCATION (story.5016: disable the old writers, revoke its
 *     key, mint a fresh one on the SAME account), not by a byte comparison at boot.
 *   - WALLET_IDENTITY_IS_PINNED_AND_ASSERTED: `AKASH_ACTUATOR_ACCOUNT_ID` is REQUIRED, is public
 *     on-chain data carried as PLAIN CONFIG (never a secret, never an OpenBao key), and
 *     `assertActuatorWalletAccount` fails closed unless the live Console account set contains it.
 *     A rotated-to-the-wrong-account credential is caught before the socket opens.
 *   - DEDICATED_CREDENTIAL_OR_NOTHING: `AKASH_ACTUATOR_CONSOLE_API_KEY` is REQUIRED and has no
 *     fallback of any kind. Omission cannot silently point the actuator at another wallet.
 *   - SCOPE_IS_PER_ENVIRONMENT: the ledger scope is `akash-console:<environment>`, so each env's
 *     wallet is serialized by exactly one env's Postgres. Per-env Postgres over ONE shared wallet
 *     is the unsound shape this exists to prevent — hence v0 seeds candidate-a ONLY.
 *   - SCOPE_IS_ROTATION_STABLE: the scope is derived from the environment, never from the secret
 *     value, so rotating the credential cannot orphan in-flight allocation receipts.
 *   - NEVER_LOGS_OR_RETURNS_THE_VALUE_IN_AN_ERROR: refusals carry a stable code and, at most, the
 *     NON-SECRET account ids. The API key never appears in a message.
 * Side-effects: none
 * Links: @shared/db/akash-tx-allocations, ./akash-tx-actuator,
 *   infra/secrets-catalog.yaml (service: akash-tx-actuator),
 *   infra/k8s/base/akash-tx-actuator/deployment.yaml, task.5095, story.5016
 * @internal
 */

/** Stable refusal reasons. Config failures surface at wiring time, never as a request status. */
export type AkashTxWalletConfigErrorCode =
  | "actuator_credential_missing"
  | "actuator_account_id_missing"
  | "actuator_account_unverifiable"
  | "actuator_account_mismatch"
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
  /** Deployment environment (`DEPLOY_ENVIRONMENT`). One wallet per environment. */
  readonly environment?: string | undefined;
  /** `AKASH_ACTUATOR_CONSOLE_API_KEY` — the credential of the one active writer. */
  readonly actuatorApiKey?: string | undefined;
  /**
   * `AKASH_ACTUATOR_ACCOUNT_ID` — the PUBLIC Akash account/wallet address this actuator is
   * authorized to spend from. Plain config from the Deployment env, NOT a secret.
   */
  readonly expectedAccountId?: string | undefined;
}

export interface AkashTxWalletIdentity {
  /** Ledger serialization domain written to `akash_tx_allocations.wallet_scope`. */
  readonly walletScope: string;
  /** The actuator's Console credential. */
  readonly apiKey: string;
  /** The non-secret account id the credential must resolve to. */
  readonly expectedAccountId: string;
}

/** The only field of a Console balance read this gate cares about — a public account id. */
export interface ActuatorAccountObservation {
  readonly accountId: string;
}

function clean(value: string | undefined): string {
  return (value ?? "").trim();
}

/**
 * Resolve the actuator's wallet identity, or refuse.
 *
 * ONE WALLET, ONE ACTIVE WRITER (story.5016, BINDING). The earlier design gave the actuator a
 * second Console account and proved separation by requiring BOTH credentials and comparing them
 * byte-for-byte. That inverted the goal: to prove it was not the legacy writer, the actuator had
 * to hold the legacy writer's wallet. Now the legacy key is neither projected nor accepted, and
 * separation is asserted against the pinned, non-secret account identity instead — see
 * {@link assertActuatorWalletAccount}, which the composition root runs before it listens.
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
      "Akash tx actuator requires AKASH_ACTUATOR_CONSOLE_API_KEY from its own secret plane " +
        "(cogni/<env>/akash-tx-actuator). There is deliberately no fallback to any other wallet."
    );
  }

  const expectedAccountId = clean(input.expectedAccountId);
  if (!expectedAccountId) {
    throw new AkashTxWalletConfigError(
      "actuator_account_id_missing",
      "Akash tx actuator requires AKASH_ACTUATOR_ACCOUNT_ID — the non-secret Akash account " +
        "address it is authorized to spend from. A wallet writer with no pinned wallet identity " +
        "cannot prove it is the one active writer, so it must not start."
    );
  }

  return {
    walletScope: `akash-console:${environment}`,
    apiKey,
    expectedAccountId,
  };
}

/**
 * Prove the credential actually opens the wallet we pinned, using the Console's own account read.
 *
 * This is what replaced the byte-equality check. A byte comparison only ever said "these two
 * secrets differ" — it could not say WHICH wallet either one opened, and it required custody of a
 * credential we are trying to keep out of this process. Comparing the live account set against a
 * public, git-reviewable address answers the question that actually matters: is this actuator
 * about to spend from the intended wallet?
 *
 * Fail-closed and loud, at boot, exactly like the refusals above: an empty observation is a
 * refusal (never "assume it is fine"), and a mismatch names only public account ids.
 */
export function assertActuatorWalletAccount(
  expectedAccountId: string,
  observed: readonly ActuatorAccountObservation[]
): void {
  const expected = clean(expectedAccountId);
  if (!expected) {
    throw new AkashTxWalletConfigError(
      "actuator_account_id_missing",
      "Cannot assert the actuator wallet: AKASH_ACTUATOR_ACCOUNT_ID is empty."
    );
  }

  const accountIds = observed
    .map((entry) => clean(entry.accountId))
    .filter(Boolean);

  if (accountIds.length === 0) {
    throw new AkashTxWalletConfigError(
      "actuator_account_unverifiable",
      "Akash Console reported no account for AKASH_ACTUATOR_CONSOLE_API_KEY, so the wallet " +
        `pinned as ${expected} cannot be confirmed. Refusing to spend from an unproven wallet.`
    );
  }

  if (!accountIds.includes(expected)) {
    throw new AkashTxWalletConfigError(
      "actuator_account_mismatch",
      `AKASH_ACTUATOR_CONSOLE_API_KEY opens ${accountIds.join(", ")}, not the pinned ` +
        `AKASH_ACTUATOR_ACCOUNT_ID ${expected}. Either the credential was minted on the wrong ` +
        "Akash account or the pin is stale; both mean a second writer could be spending here."
    );
  }
}
