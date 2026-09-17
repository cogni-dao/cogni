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
 *   no leader election, no reconciliation.
 *
 *   ONE exception, added deliberately by bug.5192: a bounded interval that asks the actuator
 *   to sweep stale allocation receipts. It is NOT reconciliation — it drives no desired state,
 *   observes no Kubernetes object and retries nothing. It exists because the one failure a
 *   request-scoped actuator structurally cannot handle is the request's own process dying
 *   mid-transaction, and the receipt that leaves behind holds a WALLET-WIDE slot: without a
 *   sweeper, one dead process stops every node in the environment from leasing. Crossplane
 *   cannot do this job either — it only ever calls about ONE workload, and the wedged receipt
 *   belongs to a different one.
 * Invariants:
 *   - ONE_WALLET_ONE_WRITER: the wallet identity comes from `resolveAkashTxWallet`, which
 *     REFUSES a missing `AKASH_ACTUATOR_CONSOLE_API_KEY` or a missing pinned
 *     `AKASH_ACTUATOR_ACCOUNT_ID`, and then `assertActuatorWalletAccount` proves against the
 *     LIVE Console account read that the credential opens the pinned wallet — before anything
 *     listens. A refusal exits non-zero; there is no degraded mode that spends from a wallet a
 *     second writer already owns.
 *   - LEDGER_SCOPE_IS_MIGRATED (bug.5187): the ledger scope is keyed on the pinned Console
 *     ACCOUNT, never on `DEPLOY_ENVIRONMENT`, and `wallet_scope` is half the key `claimOnce`
 *     uses to find a prior receipt. So this root also counts env-keyed rows once at boot and
 *     REFUSES to serve while any remain — a pod that beats its migrator would otherwise look
 *     straight past still-billing leases and mint a second one beside each. The reverse order
 *     is covered by the database: `akash_tx_allocations_wallet_scope_account_check` makes the
 *     legacy form unwritable, so an old pod that outlives the migration fails loudly instead.
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
 *     partial unique index in Postgres (`akash_tx_allocations_single_writer_idx`) — and since
 *     bug.5187 that slot is keyed on the ACCOUNT, so it serializes the replicas of a writer
 *     that serves several environments just as it serializes two replicas serving one.
 *   - MIGRATION_RUNNER_IS_WIRED_BUT_NEVER_GATES (task.5135): the same
 *     `KubernetesMigrationJobAdapter` the ComputeWorkload controller uses is still wired here,
 *     against the SAME per-digest Job names in this namespace, so the two lanes cannot disagree
 *     about whether a bundle digest has migrated. What changed is WHERE it is consulted: the
 *     RELEASE step on `observe`, never the paid create/update. An actuator built WITHOUT it no
 *     longer refuses every paid transaction — it reports `migration.phase: "unavailable"` and
 *     still mints the lease. Renting compute must not depend on a database being reachable.
 *   - LEAST_KUBERNETES_PRIVILEGE: the ONLY Kubernetes objects this process touches are the
 *     migration Jobs it creates on the release tick and the Pods it reads to classify a Failed
 *     one. Its Role (infra/k8s/base/akash-tx-actuator/rbac.yaml) grants exactly that and
 *     nothing else — no computeworkloads, no leases, no events, no configmaps. Crossplane still
 *     owns every CR. FOLLOW-UP: with the paid path no longer touching Kubernetes at all, this
 *     runner can be lifted out of the wallet-holding process entirely (see task.5135's PR).
 * Side-effects: IO (HTTP listener; Akash Console transactions; Postgres ledger writes;
 *   Kubernetes migration Job create/read/delete in this namespace)
 * Links: @features/compute/akash-tx/akash-tx-http, @features/compute/akash-tx/akash-tx-actuator,
 *   @features/compute/akash-tx/akash-tx-wallet,
 *   @features/compute/akash-tx/akash-tx-migration-step,
 *   @adapters/server/compute/kubernetes-migration-job.adapter,
 *   infra/k8s/base/akash-tx-actuator,
 *   infra/crossplane/xcomputeworkload/composition.yaml, task.5102, story.5016
 * @internal
 */

import { readFile } from "node:fs/promises";

import { createAppDbClient, type Database } from "@cogni/db-client";
import { BatchV1Api, CoreV1Api, KubeConfig } from "@kubernetes/client-node";
import { sql } from "drizzle-orm";
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
  assertLedgerIsAccountScoped,
  credentialFingerprint,
  resolveAkashTxWallet,
} from "@/features/compute/akash-tx/akash-tx-wallet";
import {
  ACCOUNT_WALLET_SCOPE_PATTERN,
  akashTxAllocations,
} from "@/shared/db/akash-tx-allocations";

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
 * LEDGER_SCOPE_IS_MIGRATED (bug.5187). `claimOnce` finds a prior receipt by
 * `(wallet_scope, cogni_key)`, so an account-keyed writer against an environment-keyed ledger
 * cannot SEE the receipts of leases that are still billing — and a lookup that finds nothing is
 * how you mint a second paid lease. Migration 0048 moves the rows and then makes the legacy form
 * unwritable; this is the other direction, the one a CHECK constraint cannot cover: a pod that
 * starts before its migrator has run refuses to serve instead of spending.
 *
 * Counted, not sampled, and read once at boot: the table is a few rows per environment, and the
 * answer is permanently 0 the moment 0048 has applied (the constraint makes any other value
 * impossible), so this costs one query and then nothing.
 */
const legacyScopedReceipts = await db
  .select({ count: sql<number>`count(*)::int` })
  .from(akashTxAllocations)
  .where(
    sql`${akashTxAllocations.walletScope} !~ ${ACCOUNT_WALLET_SCOPE_PATTERN}`
  )
  .then(([row]) => row?.count ?? 0);

try {
  assertLedgerIsAccountScoped(legacyScopedReceipts);
} catch (error) {
  log.fatal(
    {
      reason:
        error instanceof AkashTxWalletConfigError
          ? error.code
          : "ledger_scope_unmigrated",
      environment,
      namespace,
      legacyScopedReceipts,
    },
    "akash_tx_actuator_ledger_scope_unmigrated"
  );
  throw error;
}

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
  expectedCostConsumerAccountId: wallet.expectedAccountId,
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
  providerConsumerAccountId: wallet.expectedAccountId,
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

/**
 * How long a receipt must have held the wallet slot before the sweeper will INVESTIGATE it.
 * Comfortably longer than the slowest legitimate create (Console write timeout + bid wait +
 * lease), so a healthy in-flight transaction is never a candidate. Age alone never settles
 * anything — every candidate is still resolved against Console evidence.
 */
const SWEEP_STALE_AFTER_MS = 15 * 60_000;
/** One pass, hard-bounded: a sweep is a bounded attempt, not a drain loop. */
const SWEEP_BATCH_LIMIT = 20;
const SWEEP_INTERVAL_MS = 5 * 60_000;

/**
 * The backstop for a create whose process never came back. Failures are logged and swallowed:
 * the sweeper is a recovery aid, and a Console or ledger outage must never take the actuator
 * down with it — the next pass tries again.
 */
const sweepTimer = setInterval(() => {
  void actuator
    .sweepStaleAllocations({
      olderThanMs: SWEEP_STALE_AFTER_MS,
      limit: SWEEP_BATCH_LIMIT,
    })
    .catch((error: unknown) => {
      log.error(
        {
          causeMessage:
            error instanceof Error ? error.message : "unknown cause",
        },
        "akash_tx_allocation_sweep_failed"
      );
    });
}, SWEEP_INTERVAL_MS);
// Never hold the process open for a recovery pass.
sweepTimer.unref();

function shutdown(signal: string): void {
  log.info({ signal }, "akash_tx_actuator_stopping");
  clearInterval(sweepTimer);
  // In-flight requests are already idempotent by key, so a bounded drain is enough: a
  // dropped response is recoverable from the durable receipt, a double-spend is not.
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
