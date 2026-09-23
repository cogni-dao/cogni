// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/lease-log-pump`
 * Purpose: Composition root for the lease-log pump (bug.5240) — the dedicated keyless
 *   process that turns "deployed via operator" into "logs in Loki" for every service of
 *   every live Akash lease. Binds `LeaseLogPump` over three seams: the actuator's
 *   lease-log-sources op (coordinates + ephemeral logs-scoped JWT), the Console
 *   provider-proxy (log windows), and the Loki push endpoint (write-only lease credential).
 * Scope: Wiring, minimal env validation, poll scheduling and lifecycle only. Merge policy
 *   and label authority live in the feature; HTTP mechanics live in the adapters.
 * Invariants:
 *   - KEYLESS_BY_CONSTRUCTION: this process holds the actuator BEARER token and the
 *     logs:write-only Loki credential — never the Console API key, never a wallet, never a
 *     Kubernetes API permission. Its ServiceAccount binds no Role at all.
 *   - SECRETS_ARRIVE_AS_FILES: credentials are read from a projected Secret volume, never
 *     process env (mirrors the actuator; a crash dump of env leaks nothing).
 *   - FAIL_OPEN_FOR_DEPLOYS_FAIL_LOUD_FOR_ITSELF: a missing credential refuses boot
 *     (CrashLoopBackOff is the honest surface) — but nothing here can block, gate, or slow a
 *     deploy; the pump only ever reads.
 *   - UNFILTERED_ENUMERATION: sources are requested without an environment filter and each
 *     stream is labeled from its OWN receipt's environment — a writer that custodies several
 *     environments' lanes (bug.5187/bug.5207 shape) still gets every lease covered.
 * Side-effects: IO (HTTP to actuator + provider-proxy + Loki; tiny health listener)
 * Links: @features/compute/lease-log-pump/lease-log-pump,
 *   @adapters/server/compute/akash-tx-sources.client,
 *   @adapters/server/compute/provider-proxy-logs.adapter,
 *   @adapters/server/observability/loki-push.adapter, infra/k8s/base/lease-log-pump,
 *   bug.5240, task.5144
 * @internal
 */

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

import pino from "pino";

import {
  AkashTxSourcesClient,
  HttpLokiPusher,
  ProviderProxyLogsClient,
} from "@/adapters/server";
import { LeaseLogPump } from "@/features/compute/lease-log-pump/lease-log-pump";

const LISTEN_PORT = 8080;
const CREDENTIAL_DIR = "/var/run/secrets/lease-log-pump";
const DEFAULT_POLL_MS = 30_000;
const DEFAULT_PROVIDER_PROXY_URL =
  "https://console.akash.network/provider-proxy-mainnet";

// biome-ignore lint/style/noProcessEnv: dedicated process composition root validates its own minimal env
const runtimeEnv = process.env;
const log = pino({ level: runtimeEnv.LOG_LEVEL ?? "info" }).child({
  component: "lease-log-pump",
});

const namespace = runtimeEnv.POD_NAMESPACE;
const environment = runtimeEnv.DEPLOY_ENVIRONMENT;
if (!namespace || !environment) {
  throw new Error("POD_NAMESPACE and DEPLOY_ENVIRONMENT are required");
}

/** Missing/unreadable is "" — each guard below decides its own refusal. */
const readCredential = (name: string): Promise<string> =>
  readFile(`${CREDENTIAL_DIR}/${name}`, "utf8")
    .then((value) => value.trim())
    .catch(() => "");

const [actuatorToken, lokiPushUrl, lokiPushUser, lokiPushToken] =
  await Promise.all([
    readCredential("AKASH_TX_ACTUATOR_TOKEN"),
    readCredential("LOKI_LEASE_PUSH_URL"),
    readCredential("LOKI_LEASE_PUSH_USER"),
    readCredential("LOKI_LEASE_PUSH_TOKEN"),
  ]);

if (!actuatorToken) {
  log.fatal(
    { reason: "ActuatorTokenMissing", environment, namespace },
    "lease_log_pump_actuator_token_missing"
  );
  throw new Error("AKASH_TX_ACTUATOR_TOKEN is required to enumerate sources");
}
if (!lokiPushUrl || !lokiPushUser || !lokiPushToken) {
  log.fatal(
    {
      reason: "LokiPushCredentialMissing",
      environment,
      namespace,
      hasUrl: Boolean(lokiPushUrl),
      hasUser: Boolean(lokiPushUser),
      hasToken: Boolean(lokiPushToken),
    },
    "lease_log_pump_loki_credential_missing"
  );
  throw new Error(
    "LOKI_LEASE_PUSH_URL/USER/TOKEN are required; a pump that cannot ship is not a pump"
  );
}

const actuatorUrl =
  runtimeEnv.AKASH_TX_ACTUATOR_URL ?? "http://akash-tx-actuator:8080";
const providerProxyUrl =
  runtimeEnv.PROVIDER_PROXY_URL ?? DEFAULT_PROVIDER_PROXY_URL;
// Clamp defensively: NaN or a too-small override would otherwise tight-loop the actuator.
const pollMsRaw = Number(runtimeEnv.LEASE_LOG_PUMP_POLL_MS ?? DEFAULT_POLL_MS);
const pollMs = Number.isFinite(pollMsRaw)
  ? Math.max(5_000, pollMsRaw)
  : DEFAULT_POLL_MS;

const sourcesClient = new AkashTxSourcesClient({
  actuatorUrl,
  token: actuatorToken,
});
const providerLogs = new ProviderProxyLogsClient({
  proxyUrl: providerProxyUrl,
});
const lokiPusher = new HttpLokiPusher({
  url: lokiPushUrl,
  username: lokiPushUser,
  password: lokiPushToken,
});

const pump = new LeaseLogPump({
  // UNFILTERED_ENUMERATION: label per receipt, never per this pod's own environment.
  sources: () => sourcesClient.fetch(),
  readLogs: (input) => providerLogs.read(input),
  push: (streams) => lokiPusher.push(streams),
  log,
});

/** Liveness only — the pump serves no traffic; readiness equals liveness by design. */
const health = createServer((req, res) => {
  if (req.url === "/healthz" || req.url === "/readyz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
    return;
  }
  res.writeHead(404);
  res.end();
});
health.listen(LISTEN_PORT, "0.0.0.0", () => {
  log.info(
    { namespace, environment, port: LISTEN_PORT, pollMs, providerProxyUrl },
    "lease_log_pump_listening"
  );
});

let stopping = false;
let timer: NodeJS.Timeout | undefined;

const runCycle = (): void => {
  void pump
    .tick()
    .catch((error: unknown) => {
      // tick() absorbs its own failures; this is a belt-and-braces guard.
      log.error(
        { causeMessage: error instanceof Error ? error.message : "unknown" },
        "lease_log_pump_tick_threw"
      );
    })
    .finally(() => {
      if (!stopping) timer = setTimeout(runCycle, pollMs);
    });
};
runCycle();

function shutdown(signal: string): void {
  log.info({ signal }, "lease_log_pump_stopping");
  stopping = true;
  if (timer) clearTimeout(timer);
  health.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
