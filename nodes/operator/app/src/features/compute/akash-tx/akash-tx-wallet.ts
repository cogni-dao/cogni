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
 *     local actuator is serialized by that env's Postgres, which is per-database and cannot
 *     serialize two envs sharing one wallet. Centralized v0 therefore pins the managed test
 *     account on candidate-a ONLY (preview pins no wallet — one active writer per test wallet);
 *     production stays isolated on a dedicated account. This makes one actuator per pinned wallet
 *     plus NO Console/manual writes load-bearing: an external writer invalidates cursor recovery
 *     and must fail deployment proof (ci-cd.md Axiom 26).
 *   - SCOPE_IS_ROTATION_STABLE: the scope is derived from the environment, never from the secret
 *     value, so rotating the credential cannot orphan in-flight allocation receipts.
 *   - NEVER_LOGS_OR_RETURNS_THE_VALUE_IN_AN_ERROR: refusals carry a stable code and, at most, the
 *     NON-SECRET account ids. The API key never appears in a message.
 *   - CREDENTIAL_VERSION_IS_OBSERVABLE_WITHOUT_THE_VALUE: `credentialFingerprint` publishes a
 *     truncated, non-reversible digest so an operator can answer "did the pod pick up the
 *     rotation?" from pod logs alone — no OpenBao access, no root token. It is consistent with
 *     the invariant above: a 12-hex prefix identifies WHICH credential, never what it is.
 * Side-effects: none
 * Links: @shared/db/akash-tx-allocations, ./akash-tx-actuator,
 *   infra/secrets-catalog.yaml (service: akash-tx-actuator),
 *   infra/k8s/base/akash-tx-actuator/deployment.yaml, task.5095, story.5016
 * @internal
 */

import { createHash } from "node:crypto";

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
  /** Deployment environment (`DEPLOY_ENVIRONMENT`). One local ledger scope per environment. */
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

/** Hex characters kept from the digest. Enough to distinguish credential versions, short
 *  enough that the log line reads as a fingerprint and never as something secret-shaped. */
const FINGERPRINT_LENGTH = 12;

/**
 * WHICH Console credential does this process hold? A truncated, non-reversible digest —
 * never the value, and never enough of a digest to be treated as one.
 *
 * WHY THIS EXISTS (bug.5142, and it cost real time): a rotation is two separate facts —
 * "written to OpenBao" and "projected into the pod" — with an ExternalSecret and its
 * `refreshInterval` in between. The actuator verifies its wallet only at BOOT, so a pod
 * holding a REVOKED credential looks identical to a healthy one until the first paid call
 * discovers it. On 2026-09-14 the only way to tell v3 from v4 was root-token access to
 * OpenBao plus a hand-rolled hash compare; the pod itself said nothing.
 *
 * The real win is that this needs NO OpenBao access at all: compare this field across two
 * pod log lines over time and you know whether the rotation was picked up.
 *
 * VERIFYING AGAINST OPENBAO — use this recipe literally:
 *
 *   bao kv get -field=AKASH_ACTUATOR_CONSOLE_API_KEY cogni/<env>/akash-tx-actuator \
 *     | tr -d '\r\n' | shasum -a 256 | cut -c1-12
 *
 * Two traps, both hit for real:
 *   1. `-format=json -field=` emits a JSON-QUOTED string. Hashing that matches NOTHING,
 *      because the process holds raw bytes. Use the bare `-field=` form above.
 *   2. `readCredential` in the actuator's composition root TRIMS what it reads, so the
 *      fingerprint covers the TRIMMED value. `tr -d '\r\n'` is what makes the recipe agree;
 *      a plain `shasum` of the file would include the trailing newline and disagree.
 *
 * An empty credential returns `"absent"` rather than the digest of the empty string. That
 * digest is a fixed, real-looking constant (`e3b0c442...`), and publishing it would invite
 * exactly the false match this function exists to prevent.
 *
 * NOT FOR THE BEARER TOKEN. `AKASH_TX_ACTUATOR_TOKEN` is the wire credential the Composition
 * presents; it has no rotation-visibility problem and no reason to be fingerprinted.
 *
 * ON `js/insufficient-password-hash` (CodeQL flags the `createHash` below): that rule targets
 * PASSWORD STORAGE, where a fast hash is wrong because passwords are low-entropy and a stolen
 * digest can be brute-forced offline back into the original.
 *
 * The load-bearing refutation is TRUNCATION. 48 bits of output over an effectively unbounded
 * input space means astronomically many preimages, so this value cannot identify its input even
 * given unlimited compute — the rule's attack does not merely become expensive, it stops being
 * defined. Two supporting facts: the input is a vendor-minted high-entropy API key rather than a
 * human-chosen password, and the digest never authenticates or verifies anything — it answers
 * only "is this the same credential as before?". A slow KDF would add boot latency and a tuning
 * parameter while leaving the value exactly as disclosive. Same call and same justification as
 * `packages/node-shared/src/util/accountId.ts`.
 *
 * WHY NOT READ THE REAL VERSION INSTEAD. The honest alternative is to read the KV version from
 * the projected Secret's metadata rather than hash anything — and it is rejected because it
 * would require giving this pod SECRET-READ RBAC. That is the property to protect: the actuator
 * receives its credentials by PROJECTION (ESO -> volume), never by reading the Kubernetes API,
 * so a compromised actuator cannot enumerate the Secrets of `cogni-<env>`. Granting it Secret
 * reads would hand it the same broad blast radius that moving this wallet out of
 * `cogni/<env>/operator` existed to close. (State it that way and not as "the actuator has no
 * ServiceAccount": task.5143 gives it a ServiceAccount plus a Role over `jobs`/`pods` so the
 * migration prover can create and watch Jobs. Having SOME RBAC is fine; having Secret-read RBAC
 * is not.) Logging a substring of the key would be actual partial disclosure instead of none.
 */
export function credentialFingerprint(value: string): string {
  if (value === "") return "absent";
  // The `codeql[...]` marker below is DOCUMENTATION, not a suppression. Verified on this very
  // alert (#55): GitHub code scanning does not honour inline markers here — the check stayed red
  // through two attempts at "fixing" the comment's placement. What actually clears the gate is
  // DISMISSING the alert in GitHub as a false positive, which is how every prior instance of this
  // rule was resolved (alerts #3/#7/#15/#30 on accountId.ts). The marker is still worth keeping:
  // it puts the reason where the code is, so a reader does not have to find the security tab.
  // Do not "fix" a red CodeQL check by reformatting around this comment — it will not work.
  const digest = createHash("sha256").update(value, "utf8").digest("hex"); // codeql[js/insufficient-password-hash] Not password hashing — truncated, non-reversible version tag over a high-entropy API key; never authenticates. See docblock.
  return digest.slice(0, FINGERPRINT_LENGTH);
}
