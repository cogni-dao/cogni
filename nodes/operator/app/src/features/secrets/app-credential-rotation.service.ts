// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/secrets/app-credential-rotation.service`
 * Purpose: Orchestration for platform-owned GitHub App credential rotation
 *   (subtask.5016): gathers the SERVER-OWNED binding policy from this operator's
 *   own configuration, drives the ports, and maps everything through the pure
 *   decision module to ONE typed conclusion. Also the recurring health
 *   evaluation (C3) the route + scheduled job share.
 * Scope: No HTTP, no RBAC (the route owns both). Ports injected for hermetic tests.
 * Invariants:
 *   - SERVER_OWNED_COORDINATES: env = `DEPLOY_ENVIRONMENT`; expected App =
 *     the live pod's `GH_REVIEW_APP_ID` (fallback: OpenBao-stored id); expected
 *     webhook host = `APP_BASE_URL`/`DOMAIN` host; expected installation owner =
 *     `NODE_SUBMODULE_PARENT_OWNER`. A caller supplies ONLY the staged pair.
 *   - FINGERPRINTS_NOT_VALUES: reports carry fingerprints, versions, hosts,
 *     owners — never key bytes. `JSON.stringify(report)` is log-safe.
 *   - WRITE_ONLY_AFTER_ADMISSION: invalid/misbound/unconfigured/failed admission
 *     short-circuits before custody is touched (never-green-on-invalid).
 *   - LIVE_CONSUMER_IS_THIS_POD (C2): propagation is proven against the pod's
 *     own credential fingerprint; a 200 OpenBao write alone is never `rotated`.
 * Side-effects: IO via injected ports only.
 * Links: src/features/secrets/app-credential-rotation.ts (decisions),
 *   src/bootstrap/capabilities/operator-app-credentials.ts (wiring),
 *   subtask.5016 (A1, C1–C4)
 * @public
 */

import {
  type AppCredentialBindingPolicy,
  type AppCredentialConclusion,
  decideCustodyWrite,
  decideHealth,
  decidePostWriteConclusion,
  decideStagedPairAdmission,
  type LiveConsumerCredential,
} from "@/features/secrets/app-credential-rotation";
import type {
  AppCredentialVerification,
  GithubAppIdentityPort,
  OperatorAppCredentialsStorePort,
  StoredAppCredentialPair,
} from "@/ports";
import type { ServerEnv } from "@/shared/env";
import { fingerprintAppPrivateKeyBase64 } from "@/shared/secrets/github-app-key-fingerprint";

export interface AppCredentialPlaneDeps {
  readonly store: OperatorAppCredentialsStorePort;
  readonly github: GithubAppIdentityPort;
  readonly env: ServerEnv;
}

/** Log- and wire-safe report: fingerprints and policy facts only, never values. */
export interface AppCredentialReport {
  readonly conclusion: AppCredentialConclusion;
  readonly env: string;
  readonly reasons: readonly string[];
  readonly staged?:
    | {
        readonly appId: string;
        readonly keyFingerprint: string | null;
      }
    | undefined;
  readonly stored?:
    | {
        readonly configured: boolean;
        readonly appId?: string | undefined;
        readonly keyFingerprint?: string | undefined;
        readonly version: number;
      }
    | undefined;
  readonly liveConsumer?:
    | {
        readonly appId?: string | undefined;
        readonly keyFingerprint?: string | undefined;
      }
    | undefined;
  readonly github?:
    | {
        readonly appSlug: string;
        readonly webhookHost: string | null;
        readonly installationOwners: readonly string[];
      }
    | undefined;
  /** KV-v2 version produced when (and only when) the atomic pair write ran. */
  readonly kvVersion?: number | undefined;
  /**
   * The GitHub Environment bank is sealed/write-only — its copy cannot be read
   * here. Divergence with it surfaces indirectly (a bank-only rotation ends as
   * `invalid` once the superseded key is revoked). Bank parity work: subtask.5018.
   */
  readonly bankCustody: "unobservable";
}

export async function rotateOperatorAppCredential(
  deps: AppCredentialPlaneDeps,
  staged: { readonly appId: string; readonly privateKeyBase64: string }
): Promise<AppCredentialReport> {
  const deployEnv = requireDeployEnv(deps.env);
  const fp = fingerprintAppPrivateKeyBase64(staged.privateKeyBase64);
  const stagedFingerprint = fp.ok ? fp.fingerprint : null;
  const stagedFacts = {
    appId: staged.appId,
    keyFingerprint: stagedFingerprint,
  };
  const live = liveConsumerCredential(deps.env);

  // Staged key must at least parse before any IO is spent on it.
  if (stagedFingerprint === null) {
    return report({
      conclusion: "invalid",
      env: deployEnv,
      reasons: ["staged_key_material_unparseable"],
      staged: stagedFacts,
      liveConsumer: liveFacts(live),
    });
  }

  let stored: StoredAppCredentialPair;
  try {
    stored = await deps.store.readStoredAppCredentialPair(deployEnv);
  } catch (error) {
    return report({
      conclusion: "failed",
      env: deployEnv,
      reasons: [errorCode(error, "openbao_read_failed")],
      staged: stagedFacts,
      liveConsumer: liveFacts(live),
    });
  }

  const verification = await deps.github.verifyAppCredential({
    appId: staged.appId,
    privateKeyBase64: staged.privateKeyBase64,
  });
  const policy = bindingPolicy(deps.env, deployEnv, stored);
  const admission = decideStagedPairAdmission({
    stagedAppId: staged.appId,
    stagedFingerprint,
    verification,
    policy,
  });
  if (!admission.admit) {
    return report({
      // biome-ignore lint/style/noNonNullAssertion: refuse() always sets conclusion when admit=false
      conclusion: admission.conclusion!,
      env: deployEnv,
      reasons: admission.reasons,
      staged: stagedFacts,
      stored: storedFacts(stored),
      liveConsumer: liveFacts(live),
      github: githubFacts(verification),
    });
  }

  const custody = decideCustodyWrite({
    stagedAppId: staged.appId,
    stagedFingerprint,
    stored,
    live,
  });
  if (!custody.shouldWrite) {
    return report({
      // biome-ignore lint/style/noNonNullAssertion: decideCustodyWrite sets conclusion when shouldWrite=false
      conclusion: custody.conclusion!,
      env: deployEnv,
      reasons: custody.reasons,
      staged: stagedFacts,
      stored: storedFacts(stored),
      liveConsumer: liveFacts(live),
      github: githubFacts(verification),
    });
  }

  let kvVersion: number;
  try {
    const written = await deps.store.writeAppCredentialPair({
      env: deployEnv,
      appId: staged.appId,
      privateKeyBase64: staged.privateKeyBase64,
      expectedVersion: stored.version,
    });
    kvVersion = written.version;
  } catch (error) {
    return report({
      conclusion: "failed",
      env: deployEnv,
      reasons: [errorCode(error, "openbao_pair_write_failed")],
      staged: stagedFacts,
      stored: storedFacts(stored),
      liveConsumer: liveFacts(live),
      github: githubFacts(verification),
    });
  }

  return report({
    conclusion: decidePostWriteConclusion({ stagedFingerprint, live }),
    env: deployEnv,
    reasons: ["pair_written_atomically_with_cas"],
    staged: stagedFacts,
    stored: storedFacts(stored),
    liveConsumer: liveFacts(live),
    github: githubFacts(verification),
    kvVersion,
  });
}

/**
 * Recurring divergence/health evaluation (C3) — shared by the GET route and the
 * scheduled job, so a staged-but-never-converged custody cannot sit silent.
 */
export async function evaluateOperatorAppCredentialHealth(
  deps: AppCredentialPlaneDeps
): Promise<AppCredentialReport> {
  const deployEnv = requireDeployEnv(deps.env);
  const live = liveConsumerCredential(deps.env);

  let stored: StoredAppCredentialPair;
  try {
    stored = await deps.store.readStoredAppCredentialPair(deployEnv);
  } catch (error) {
    return report({
      conclusion: "failed",
      env: deployEnv,
      reasons: [errorCode(error, "openbao_read_failed")],
      liveConsumer: liveFacts(live),
    });
  }

  // The stored key's material never leaves the adapter; it can only be verified
  // against GitHub via the pod's own copy — valid exactly when live == stored.
  let verification: AppCredentialVerification | null = null;
  const liveMatchesStored =
    stored.configured &&
    stored.privateKeyUnparseable !== true &&
    live.privateKeyFingerprint !== undefined &&
    live.privateKeyFingerprint === stored.privateKeyFingerprint;
  if (liveMatchesStored) {
    verification = await deps.github.verifyAppCredential({
      appId: stored.appId ?? "",
      privateKeyBase64: deps.env.GH_REVIEW_APP_PRIVATE_KEY_BASE64 ?? "",
    });
  }

  const decision = decideHealth({
    stored,
    live,
    verification,
    policy: bindingPolicy(deps.env, deployEnv, stored),
  });
  return report({
    conclusion: decision.conclusion,
    env: deployEnv,
    reasons: decision.reasons,
    stored: storedFacts(stored),
    liveConsumer: liveFacts(live),
    github: verification === null ? undefined : githubFacts(verification),
  });
}

/** Thrown when the pod cannot even name its own env — the route maps it to 503. */
export class DeployEnvUnsetError extends Error {
  constructor() {
    super("DEPLOY_ENVIRONMENT is not set on this operator");
    this.name = "DeployEnvUnsetError";
  }
}

function requireDeployEnv(env: ServerEnv): string {
  if (!env.DEPLOY_ENVIRONMENT) throw new DeployEnvUnsetError();
  return env.DEPLOY_ENVIRONMENT;
}

function bindingPolicy(
  env: ServerEnv,
  deployEnv: string,
  stored: StoredAppCredentialPair
): AppCredentialBindingPolicy {
  return {
    env: deployEnv,
    expectedAppId: env.GH_REVIEW_APP_ID ?? stored.appId,
    expectedWebhookHost: expectedWebhookHost(env),
    expectedInstallationOwner: env.NODE_SUBMODULE_PARENT_OWNER,
  };
}

/** The env's own public host — where this operator's App webhooks must point. */
function expectedWebhookHost(env: ServerEnv): string | undefined {
  if (env.APP_BASE_URL) {
    try {
      return new URL(env.APP_BASE_URL).host;
    } catch {
      // fall through to DOMAIN
    }
  }
  return env.DOMAIN ?? undefined;
}

function liveConsumerCredential(env: ServerEnv): LiveConsumerCredential {
  const material = env.GH_REVIEW_APP_PRIVATE_KEY_BASE64;
  if (!material) {
    return { appId: env.GH_REVIEW_APP_ID, privateKeyFingerprint: undefined };
  }
  const fp = fingerprintAppPrivateKeyBase64(material);
  return {
    appId: env.GH_REVIEW_APP_ID,
    privateKeyFingerprint: fp.ok ? fp.fingerprint : undefined,
  };
}

function liveFacts(
  live: LiveConsumerCredential
): NonNullable<AppCredentialReport["liveConsumer"]> {
  return { appId: live.appId, keyFingerprint: live.privateKeyFingerprint };
}

function storedFacts(
  stored: StoredAppCredentialPair
): NonNullable<AppCredentialReport["stored"]> {
  return {
    configured: stored.configured,
    appId: stored.appId,
    keyFingerprint: stored.privateKeyFingerprint,
    version: stored.version,
  };
}

function githubFacts(
  verification: AppCredentialVerification
): AppCredentialReport["github"] {
  if (verification.kind !== "verified") return undefined;
  return {
    appSlug: verification.appSlug,
    webhookHost: verification.webhookHost,
    installationOwners: verification.installationOwners,
  };
}

function errorCode(error: unknown, fallback: string): string {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code: unknown }).code)
    : fallback;
}

function report(
  fields: Omit<AppCredentialReport, "bankCustody">
): AppCredentialReport {
  return { ...fields, bankCustody: "unobservable" };
}
