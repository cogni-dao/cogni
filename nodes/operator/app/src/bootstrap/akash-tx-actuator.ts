// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/akash-tx-actuator`
 * Purpose: The composition root task.5095 deliberately omitted — the dedicated process that
 *   binds `AkashTxActuator` over the Akash Console client, the durable allocation ledger and
 *   the serving probe, and serves the four bounded operations on a PRIVATE ClusterIP the
 *   Crossplane XComputeWorkload Composition calls (task.5102).
 * Scope: Wiring, minimal env validation and lifecycle only. Every decision about WHEN to
 *   observe/create/update/delete belongs to Crossplane, and every decision about whether a
 *   transaction is safe belongs to the actuator — neither is re-implemented here. No watches,
 *   no timers, no leader election, no reconciliation.
 * Invariants:
 *   - ONE_WALLET_ONE_WRITER: the wallet identity comes from `resolveAkashTxWallet`, which
 *     REFUSES a missing `AKASH_ACTUATOR_CONSOLE_API_KEY` or a missing pinned
 *     `AKASH_ACTUATOR_ACCOUNT_ID`, and then `assertActuatorWalletAccount` proves against the
 *     LIVE Console account read that the credential opens the pinned wallet — before anything
 *     listens. A refusal exits non-zero; there is no degraded mode that spends from a wallet a
 *     second writer already owns.
 *   - NEVER_HOLDS_TWO_WALLETS: the legacy ComputeWorkload controller's `AKASH_CONSOLE_API_KEY`
 *     is NOT projected here and is never read. Holding it to byte-compare it (task.5095) was
 *     the opposite of isolation; separation is a revocation fact plus the pinned account
 *     assertion (story.5016).
 *   - PRIVATE_BY_CONSTRUCTION: a bearer token is required before the socket is opened. The
 *     Service is ClusterIP-only and never behind an Ingress or a public route.
 *   - SECRETS_ARRIVE_AS_FILES: credentials are read from a projected Secret volume, never from
 *     the process env, so they cannot leak into a crash dump of `process.env` or a child env.
 *     The wallet credential + bearer token come from the actuator's OWN ExternalSecret
 *     (`akash-tx-actuator-env-secrets` ← cogni/<env>/akash-tx-actuator), which the public
 *     operator app has no path to. Only the ledger DSN is projected from the operator bucket.
 *     The pinned account id is NOT a secret and correctly arrives as plain env config.
 *   - SURGE_IS_SAFE_HERE: unlike the ComputeWorkload controller, correctness does not rest on a
 *     Kubernetes Lease. Two live replicas cannot both spend, because the wallet slot is a
 *     partial unique index in Postgres (`akash_tx_allocations_single_writer_idx`).
 *   - MIGRATION_PROVER_IS_WIRED: the actuator's migration gate is fail-CLOSED, and the
 *     Composition lowers `RequireBeforeTransaction` on every create/update of a
 *     `cogni-node-app-v1` workload — so an actuator built without a prover refuses EVERY paid
 *     transaction with `migration_unavailable` (story.5016). The prover is therefore mandatory
 *     here, not optional: it is the SAME `KubernetesMigrationJobAdapter` the ComputeWorkload
 *     controller uses, against the SAME per-digest Job names in this namespace, so the two
 *     lanes cannot disagree about whether a bundle digest has migrated. There is no dormant
 *     variant — a wallet-less actuator has already exited above, so "no credential, no Jobs"
 *     is structurally unreachable at this point.
 *   - LEAST_KUBERNETES_PRIVILEGE: the ONLY Kubernetes objects this process touches are the
 *     migration Jobs it creates and the Pods it reads to classify a Failed one. Its Role
 *     (infra/k8s/base/akash-tx-actuator/rbac.yaml) grants exactly that and nothing else — no
 *     computeworkloads, no leases, no events, no configmaps. Crossplane still owns every CR.
 * Side-effects: IO (HTTP listener; Akash Console transactions; Postgres ledger writes;
 *   Kubernetes migration Job create/read/delete in this namespace)
 * Links: @features/compute/akash-tx/akash-tx-http, @features/compute/akash-tx/akash-tx-actuator,
 *   @features/compute/akash-tx/akash-tx-wallet,
 *   @features/compute/akash-tx/akash-tx-migration-gate,
 *   @adapters/server/compute/kubernetes-migration-job.adapter,
 *   infra/k8s/base/akash-tx-actuator,
 *   infra/crossplane/xcomputeworkload/composition.yaml, task.5102, story.5016
 * @internal
 */

import { readFile } from "node:fs/promises";

import { createAppDbClient, type Database } from "@cogni/db-client";
import { BatchV1Api, CoreV1Api, KubeConfig } from "@kubernetes/client-node";
import pino from "pino";

import {
  AkashComputeAdapter,
  DrizzleAkashTxAllocationLedger,
  DrizzleComputeCostStore,
  DrizzleProviderOutcomeStore,
  KubernetesMigrationJobAdapter,
  safeReadyzProbe,
  safeVersionProbe,
} from "@/adapters/server";
import {
  AkashTxActuator,
  type AkashTxServingProbe,
} from "@/features/compute/akash-tx/akash-tx-actuator";
import { createAkashTxActuatorServer } from "@/features/compute/akash-tx/akash-tx-http";
import {
  AkashTxWalletConfigError,
  assertActuatorWalletAccount,
  credentialFingerprint,
  resolveAkashTxWallet,
} from "@/features/compute/akash-tx/akash-tx-wallet";

/**
 * The port the XComputeWorkload Composition hard-codes in
 * `http://akash-tx-actuator.<ns>.svc.cluster.local:8080`. Changing it is a wire break.
 */
const LISTEN_PORT = 8080;

/** Projected Secret volume — one file per key, mirroring the ComputeWorkload controller. */
const CREDENTIAL_DIR = "/var/run/secrets/akash-tx";

// biome-ignore lint/style/noProcessEnv: dedicated process composition root validates its own minimal env
const runtimeEnv = process.env;
const log = pino({ level: runtimeEnv.LOG_LEVEL ?? "info" }).child({
  component: "akash-tx-actuator",
});

const namespace = runtimeEnv.POD_NAMESPACE;
const environment = runtimeEnv.DEPLOY_ENVIRONMENT;
if (!namespace || !environment) {
  throw new Error("POD_NAMESPACE and DEPLOY_ENVIRONMENT are required");
}

/** Missing/unreadable is "" — every consumer below decides its own refusal. */
const readCredential = (name: string): Promise<string> =>
  readFile(`${CREDENTIAL_DIR}/${name}`, "utf8")
    .then((value) => value.trim())
    .catch(() => "");

const [actuatorApiKey, bearerToken, databaseUrl] = await Promise.all([
  readCredential("AKASH_ACTUATOR_CONSOLE_API_KEY"),
  readCredential("AKASH_TX_ACTUATOR_TOKEN"),
  readCredential("DATABASE_URL"),
]);

/**
 * WHICH Console credential this pod booted with (bug.5142). Computed once, over the exact
 * string every consumer below uses, and attached to both the wallet refusals and the healthy
 * lines — so "did the pod pick up the rotation?" is answerable by comparing two pod log lines,
 * with no OpenBao access. Deliberately NOT computed for the bearer token.
 */
const consoleKeyFingerprint = credentialFingerprint(actuatorApiKey);

/**
 * The wallet identity pin. Public on-chain data, so it is plain env config rather than a
 * projected secret — routing it through OpenBao would re-couple the actuator to a secret plane
 * it does not need, and a value that must be reviewable in git does not belong in a vault.
 */
const expectedAccountId = runtimeEnv.AKASH_ACTUATOR_ACCOUNT_ID;

/**
 * Refuse before anything listens. A wallet misconfiguration is not a request-time status —
 * the actuator must simply not exist in that shape, and a CrashLoopBackOff with a stable
 * reason is the honest surface (an empty Service endpoint list, not a silent wrong wallet).
 */
const wallet = (() => {
  try {
    return resolveAkashTxWallet({
      environment,
      actuatorApiKey,
      expectedAccountId,
    });
  } catch (error) {
    if (error instanceof AkashTxWalletConfigError) {
      log.fatal(
        { reason: error.code, environment, namespace, consoleKeyFingerprint },
        "akash_tx_actuator_wallet_unresolved"
      );
    }
    throw error;
  }
})();

if (!bearerToken) {
  log.fatal(
    { reason: "ActuatorTokenMissing", environment, namespace },
    "akash_tx_actuator_token_missing"
  );
  throw new Error(
    "AKASH_TX_ACTUATOR_TOKEN is required; refusing to expose an unauthenticated wallet writer"
  );
}
if (!databaseUrl) {
  log.fatal(
    { reason: "LedgerDsnMissing", environment, namespace },
    "akash_tx_actuator_ledger_dsn_missing"
  );
  throw new Error(
    "DATABASE_URL is required; the actuator must not spend without a durable receipt"
  );
}

const db: Database = createAppDbClient(databaseUrl);
const getDb = async (): Promise<Database> => db;

/**
 * One bounded serving proof per observe: exact source SHA on `/version` AND a 2xx `/readyz`,
 * byte-identical to the ComputeWorkload lifecycle adapter's `verifySource`. Never loops —
 * convergence polling is Crossplane's job.
 */
const probe: AkashTxServingProbe = async ({ endpoints, expectedSourceSha }) => {
  for (const endpoint of endpoints) {
    if (
      (await safeVersionProbe(endpoint, expectedSourceSha)) &&
      (await safeReadyzProbe(endpoint))
    ) {
      return true;
    }
  }
  return false;
};

const preferredProviders = (runtimeEnv.AKASH_PREFERRED_PROVIDERS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
// An empty configured boundary intentionally rejects every provider; provider-enabled
// environments must opt in their reachable accounts (same contract as the controller).
const allowedProviders = (runtimeEnv.AKASH_ALLOWED_PROVIDERS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const consoleClient = new AkashComputeAdapter({
  apiKey: wallet.apiKey,
  timeoutMs: 15_000,
  allowedProviders,
  ...(preferredProviders.length > 0 ? { preferredProviders } : {}),
  // Provider screening keeps its memory: boot outcomes are durable in the SAME operator
  // Postgres that serializes the wallet, so a provider that stranded a lease is ranked down.
  outcomeStore: new DrizzleProviderOutcomeStore(getDb),
  log,
});

/**
 * Prove the credential opens the wallet we pinned, BEFORE the socket exists.
 *
 * This is the structural replacement for task.5095's byte-equality check against the legacy
 * controller's key — that check required custody of the very credential we are isolating from,
 * and still only proved "different bytes", never "the right wallet". A Console read against a
 * public, git-reviewable account id proves the thing that matters. Any failure (mismatch, empty
 * account set, or Console unreachable) exits non-zero: an unproven wallet is not a degraded mode.
 */
try {
  assertActuatorWalletAccount(
    wallet.expectedAccountId,
    await consoleClient.balances()
  );
  log.info(
    {
      environment,
      namespace,
      expectedAccountId: wallet.expectedAccountId,
      consoleKeyFingerprint,
    },
    "akash_tx_actuator_wallet_verified"
  );
} catch (error) {
  log.fatal(
    {
      reason:
        error instanceof AkashTxWalletConfigError
          ? error.code
          : "actuator_account_unverifiable",
      environment,
      namespace,
      expectedAccountId: wallet.expectedAccountId,
      consoleKeyFingerprint,
    },
    "akash_tx_actuator_wallet_unverified"
  );
  throw error;
}

/**
 * In-cluster identity for the migration prover, constructed only after the env guards above —
 * `loadFromCluster()` needs the projected ServiceAccount token, and the packaged-artifact smoke
 * test must still reach the POD_NAMESPACE/DEPLOY_ENVIRONMENT refusal first.
 */
const kubeConfig = new KubeConfig();
kubeConfig.loadFromCluster();

const actuator = new AkashTxActuator({
  console: consoleClient,
  ledger: new DrizzleAkashTxAllocationLedger(getDb, wallet.walletScope),
  costEvidence: consoleClient,
  costStore: new DrizzleComputeCostStore(getDb),
  log,
  probe,
  /**
   * story.5016 — the gate this feeds is fail-CLOSED, so an omitted prover is not "no migration
   * policy", it is "every paid create is refused". Same adapter, same namespace and therefore
   * the same `migrate-<slug>-<digest12>` Job names as the ComputeWorkload controller: a digest
   * already proven by one lane is proven for the other, and neither re-runs it.
   */
  migration: new KubernetesMigrationJobAdapter(
    kubeConfig.makeApiClient(BatchV1Api),
    kubeConfig.makeApiClient(CoreV1Api),
    namespace,
    log
  ),
});

const server = createAkashTxActuatorServer({
  actuator,
  token: bearerToken,
  log,
});

server.listen(LISTEN_PORT, "0.0.0.0", () => {
  log.info(
    {
      namespace,
      environment,
      walletScope: wallet.walletScope,
      consoleKeyFingerprint,
      port: LISTEN_PORT,
      allowedProviders: allowedProviders.length,
      preferredProviders: preferredProviders.length,
    },
    "akash_tx_actuator_listening"
  );
});

function shutdown(signal: string): void {
  log.info({ signal }, "akash_tx_actuator_stopping");
  // In-flight requests are already idempotent by key, so a bounded drain is enough: a
  // dropped response is recoverable from the durable receipt, a double-spend is not.
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
