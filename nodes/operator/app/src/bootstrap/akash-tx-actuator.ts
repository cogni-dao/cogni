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
 *     REFUSES a missing `AKASH_ACTUATOR_CONSOLE_API_KEY` and one byte-equal to the legacy
 *     controller's `AKASH_CONSOLE_API_KEY`. A refusal exits non-zero; there is no degraded
 *     mode that spends from a wallet a second writer already owns.
 *   - PRIVATE_BY_CONSTRUCTION: a bearer token is required before the socket is opened. The
 *     Service is ClusterIP-only and never behind an Ingress or a public route.
 *   - SECRETS_ARRIVE_AS_FILES: credentials are read from a projected Secret volume, never from
 *     the process env, so they cannot leak into a crash dump of `process.env` or a child env.
 *   - SURGE_IS_SAFE_HERE: unlike the ComputeWorkload controller, correctness does not rest on a
 *     Kubernetes Lease. Two live replicas cannot both spend, because the wallet slot is a
 *     partial unique index in Postgres (`akash_tx_allocations_single_writer_idx`).
 * Side-effects: IO (HTTP listener; Akash Console transactions; Postgres ledger writes)
 * Links: @features/compute/akash-tx/akash-tx-http, @features/compute/akash-tx/akash-tx-actuator,
 *   @features/compute/akash-tx/akash-tx-wallet, infra/k8s/base/akash-tx-actuator,
 *   infra/crossplane/xcomputeworkload/composition.yaml, task.5102
 * @internal
 */

import { readFile } from "node:fs/promises";

import { createAppDbClient, type Database } from "@cogni/db-client";
import pino from "pino";

import {
  AkashComputeAdapter,
  DrizzleAkashTxAllocationLedger,
  DrizzleProviderOutcomeStore,
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

const [actuatorApiKey, legacyControllerApiKey, bearerToken, databaseUrl] =
  await Promise.all([
    readCredential("AKASH_ACTUATOR_CONSOLE_API_KEY"),
    readCredential("AKASH_CONSOLE_API_KEY"),
    readCredential("AKASH_TX_ACTUATOR_TOKEN"),
    readCredential("DATABASE_URL"),
  ]);

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
      legacyControllerApiKey,
    });
  } catch (error) {
    if (error instanceof AkashTxWalletConfigError) {
      log.fatal(
        { reason: error.code, environment, namespace },
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

const actuator = new AkashTxActuator({
  console: new AkashComputeAdapter({
    apiKey: wallet.apiKey,
    timeoutMs: 15_000,
    allowedProviders,
    ...(preferredProviders.length > 0 ? { preferredProviders } : {}),
    // Provider screening keeps its memory: boot outcomes are durable in the SAME operator
    // Postgres that serializes the wallet, so a provider that stranded a lease is ranked down.
    outcomeStore: new DrizzleProviderOutcomeStore(getDb),
    log,
  }),
  ledger: new DrizzleAkashTxAllocationLedger(getDb, wallet.walletScope),
  log,
  probe,
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
