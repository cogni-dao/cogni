// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/secrets/app-credential-rotation`
 * Purpose: PURE decision logic for platform-owned GitHub App credential rotation
 *   (subtask.5016). Maps (staged pair, GitHub verification, OpenBao custody, live
 *   consumer credential, server-owned binding policy) → ONE typed conclusion.
 *   No IO — every branch is hermetically testable.
 *
 * THE CEREMONY ORDER IS PINNED HERE (C1) — rotation is five steps, and code owns
 * only the middle three observations/writes:
 *   1. MINT FIRST (human, GitHub owner UI): mint the NEW App key while the old one
 *      stays valid — GitHub App keys are concurrently valid, so nothing breaks.
 *   2. STAGE (human/CI): place the pair in the GitHub Environment bank
 *      (`gh secret set`, sealed, write-only).
 *   3. TYPED WRITE (this capability): validate the staged pair against live GitHub
 *      (identity, installation reach, webhook-host binding — all server-owned),
 *      then ONE atomic KV-v2 pair write with check-and-set (C4).
 *   4. VERIFY PROPAGATION (this capability, C2): a 200 OpenBao write is NOT
 *      rotation. ESO refresh + Reloader restart can lag (up to the refresh
 *      interval); the live consumer IS this operator pod, so propagation is
 *      proven by comparing the pod's own key fingerprint to the staged one.
 *      Until they match the conclusion is `written_not_propagated`, never
 *      `rotated`/`current`.
 *   5. REVOKE LAST (human, GitHub owner UI, with owner attestation): only after
 *      the live consumer demonstrably holds the new key. This capability has no
 *      revoke path BY DESIGN — GitHub is read-only to it (C1).
 *
 * Invariants:
 *   - NEVER_GREEN_ON_INVALID: `invalid`/`misbound` conclusions can never coexist
 *     with a write — admission runs before custody is touched.
 *   - TRANSPORT_PROVES_NOTHING (C2): a GitHub/OpenBao transport failure is
 *     `failed`, never `invalid` (the credential may be fine) and never success.
 *   - BANK_IS_UNOBSERVABLE: the GitHub Environment bank is write-only, so
 *     bank-vs-OpenBao divergence cannot be read directly. It is detected
 *     indirectly: a bank-only rotation (the 2026-10-03 class) eventually revokes
 *     the stored key, which the recurring health evaluation surfaces as
 *     `invalid` — loud, not silent. Full bank-custody parity is subtask.5018.
 * Side-effects: none
 * Links: src/ports/operator-app-credentials.port.ts,
 *   src/features/secrets/app-credential-rotation.service.ts (orchestration),
 *   docs/spec/secrets-management.md (Invariant 9), subtask.5016 (A1, C1–C4)
 * @public
 */

import type {
  AppCredentialVerification,
  StoredAppCredentialPair,
} from "@/ports";

/** The one typed result the whole capability speaks (subtask.5016 acceptance). */
export type AppCredentialConclusion =
  | "unconfigured"
  | "invalid"
  | "misbound"
  | "current"
  | "rotated"
  | "written_not_propagated"
  | "failed";

/** Server-owned binding policy — never caller input. */
export interface AppCredentialBindingPolicy {
  /** Operator-stamped env (`DEPLOY_ENVIRONMENT`). */
  readonly env: string;
  /**
   * The App identity this env's operator consumes (live pod `GH_REVIEW_APP_ID`,
   * falling back to the OpenBao-stored id). Rotation replaces a KEY, never the
   * App — changing App identity is a different, human ceremony.
   */
  readonly expectedAppId: string | undefined;
  /** Host the App's webhooks must point at (derived from `APP_BASE_URL`/`DOMAIN`). */
  readonly expectedWebhookHost: string | undefined;
  /** Org the App must be installed on (`NODE_SUBMODULE_PARENT_OWNER`). */
  readonly expectedInstallationOwner: string | undefined;
}

/** The credential the running pod holds (serverEnv) — the live consumer (C2). */
export interface LiveConsumerCredential {
  readonly appId: string | undefined;
  readonly privateKeyFingerprint: string | undefined;
}

export interface AdmissionDecision {
  readonly admit: boolean;
  readonly conclusion?: Extract<
    AppCredentialConclusion,
    "unconfigured" | "invalid" | "misbound" | "failed"
  >;
  /** Machine-readable reasons — key names and policy facts only, never values. */
  readonly reasons: readonly string[];
}

/**
 * Admission gate for a staged pair: is this credential VALID (GitHub accepts it
 * as the claimed App) and BOUND to this environment (right App, right org reach,
 * right webhook host)? Runs BEFORE any custody write.
 */
export function decideStagedPairAdmission(input: {
  readonly stagedAppId: string;
  /** null when the staged key bytes do not parse (fingerprint derivation failed). */
  readonly stagedFingerprint: string | null;
  readonly verification: AppCredentialVerification;
  readonly policy: AppCredentialBindingPolicy;
}): AdmissionDecision {
  const { stagedAppId, stagedFingerprint, verification, policy } = input;
  if (stagedFingerprint === null) {
    return refuse("invalid", ["staged_key_material_unparseable"]);
  }
  if (verification.kind === "transport_failure") {
    return refuse("failed", [
      verification.status === undefined
        ? "github_transport_failure"
        : `github_transport_failure_status_${verification.status}`,
    ]);
  }
  if (verification.kind === "invalid") {
    return refuse("invalid", [`github_${verification.reason}`]);
  }
  // Server-owned policy must be expressible before any binding verdict: a plane
  // that cannot state its own expectations must say so, not guess.
  const missingPolicy: string[] = [];
  if (policy.expectedAppId === undefined)
    missingPolicy.push("expected_app_id_unset");
  if (policy.expectedWebhookHost === undefined)
    missingPolicy.push("expected_webhook_host_unset");
  if (policy.expectedInstallationOwner === undefined)
    missingPolicy.push("expected_installation_owner_unset");
  if (missingPolicy.length > 0) return refuse("unconfigured", missingPolicy);

  const reasons: string[] = [];
  if (stagedAppId !== policy.expectedAppId) {
    reasons.push("staged_app_id_differs_from_expected_app");
  }
  if (verification.webhookHost !== policy.expectedWebhookHost) {
    reasons.push("webhook_host_differs_from_env_host");
  }
  if (
    policy.expectedInstallationOwner !== undefined &&
    !verification.installationOwners.includes(policy.expectedInstallationOwner)
  ) {
    reasons.push("no_installation_on_expected_owner");
  }
  if (reasons.length > 0) return refuse("misbound", reasons);
  return { admit: true, reasons: [] };
}

export interface CustodyDecision {
  /** True when the atomic pair write should run. */
  readonly shouldWrite: boolean;
  /** Set when no write is needed — the conclusion is already known. */
  readonly conclusion?: Extract<
    AppCredentialConclusion,
    "current" | "written_not_propagated"
  >;
  readonly reasons: readonly string[];
}

/**
 * Idempotence gate: given an ADMITTED staged pair, does custody need the write?
 *   - stored == staged == live  → `current` (full no-op; re-runs are safe)
 *   - stored == staged != live  → `written_not_propagated` (prior write still
 *     propagating; do NOT write again, do NOT report success)
 *   - otherwise                 → write.
 */
export function decideCustodyWrite(input: {
  readonly stagedAppId: string;
  readonly stagedFingerprint: string;
  readonly stored: StoredAppCredentialPair;
  readonly live: LiveConsumerCredential;
}): CustodyDecision {
  const { stagedAppId, stagedFingerprint, stored, live } = input;
  const storedMatchesStaged =
    stored.configured &&
    stored.privateKeyUnparseable !== true &&
    stored.appId === stagedAppId &&
    stored.privateKeyFingerprint === stagedFingerprint;
  if (!storedMatchesStaged) {
    return { shouldWrite: true, reasons: ["custody_differs_from_staged_pair"] };
  }
  if (live.privateKeyFingerprint === stagedFingerprint) {
    return {
      shouldWrite: false,
      conclusion: "current",
      reasons: ["custody_and_live_consumer_match_staged_pair"],
    };
  }
  return {
    shouldWrite: false,
    conclusion: "written_not_propagated",
    reasons: ["custody_matches_staged_pair_live_consumer_lags"],
  };
}

/**
 * Post-write propagation verdict (C2): `rotated` ONLY when the live consumer
 * already serves the staged key; otherwise the honest `written_not_propagated`.
 * ESO + Reloader restart THIS pod, so the usual immediate answer is
 * `written_not_propagated` — the recurring health evaluation reports `current`
 * once the restarted pod holds the new key.
 */
export function decidePostWriteConclusion(input: {
  readonly stagedFingerprint: string;
  readonly live: LiveConsumerCredential;
}): Extract<AppCredentialConclusion, "rotated" | "written_not_propagated"> {
  return input.live.privateKeyFingerprint === input.stagedFingerprint
    ? "rotated"
    : "written_not_propagated";
}

export interface HealthDecision {
  readonly conclusion: AppCredentialConclusion;
  readonly reasons: readonly string[];
}

/**
 * Recurring divergence/health verdict (C3) over STORED custody: validates the
 * OpenBao-held credential against live GitHub and against the live consumer.
 * This is what makes a staged-but-never-converged custody loud: a bank-only
 * rotation eventually revokes the stored key → `invalid` here, instead of the
 * 2026-10-03 silent window.
 */
export function decideHealth(input: {
  readonly stored: StoredAppCredentialPair;
  readonly live: LiveConsumerCredential;
  /** GitHub verification of the STORED pair; null when stored is unusable/absent. */
  readonly verification: AppCredentialVerification | null;
  readonly policy: AppCredentialBindingPolicy;
}): HealthDecision {
  const { stored, live, verification, policy } = input;
  if (!stored.configured) {
    return { conclusion: "unconfigured", reasons: ["openbao_pair_absent"] };
  }
  if (stored.privateKeyUnparseable === true) {
    return {
      conclusion: "invalid",
      reasons: ["stored_key_material_unparseable"],
    };
  }
  // Propagation first: when the live consumer does not hold the stored key,
  // ESO/Reloader convergence is the outstanding fact (and the stored key cannot
  // be GitHub-verified without its material — the pod only holds its own copy).
  if (live.privateKeyFingerprint !== stored.privateKeyFingerprint) {
    return {
      conclusion: "written_not_propagated",
      reasons: ["live_consumer_differs_from_custody"],
    };
  }
  if (verification === null) {
    return { conclusion: "failed", reasons: ["stored_pair_not_verified"] };
  }
  if (verification.kind === "transport_failure") {
    return {
      conclusion: "failed",
      reasons: [
        verification.status === undefined
          ? "github_transport_failure"
          : `github_transport_failure_status_${verification.status}`,
      ],
    };
  }
  if (verification.kind === "invalid") {
    // The stored credential no longer authenticates as its claimed App — the
    // revoked-key-in-custody class that ran silent for a week in 2026-10.
    return {
      conclusion: "invalid",
      reasons: [`github_${verification.reason}`],
    };
  }
  const reasons: string[] = [];
  if (
    policy.expectedAppId !== undefined &&
    stored.appId !== policy.expectedAppId
  ) {
    reasons.push("stored_app_id_differs_from_expected_app");
  }
  if (
    policy.expectedWebhookHost !== undefined &&
    verification.webhookHost !== policy.expectedWebhookHost
  ) {
    reasons.push("webhook_host_differs_from_env_host");
  }
  if (
    policy.expectedInstallationOwner !== undefined &&
    !verification.installationOwners.includes(policy.expectedInstallationOwner)
  ) {
    reasons.push("no_installation_on_expected_owner");
  }
  if (reasons.length > 0) return { conclusion: "misbound", reasons };
  return { conclusion: "current", reasons: [] };
}

function refuse(
  conclusion: Extract<
    AppCredentialConclusion,
    "unconfigured" | "invalid" | "misbound" | "failed"
  >,
  reasons: readonly string[]
): AdmissionDecision {
  return { admit: false, conclusion, reasons };
}
