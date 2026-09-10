// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { hostname } from "node:os";

import {
  CoordinationV1Api,
  CoreV1Api,
  CustomObjectsApi,
  KubeConfig,
} from "@kubernetes/client-node";
import pLimit from "p-limit";
import pino from "pino";
import { Counter, Gauge, Histogram, Registry } from "prom-client";

import {
  AkashComputeAdapter,
  CloudflareComputeWorkloadDnsAdapter,
  ComputeWorkloadLifecycleAdapter,
  ComputeWorkloadSecretResolverAdapter,
  DEFAULT_LEASE_DURATION_SECONDS,
  DormantComputeWorkloadDnsAdapter,
  DormantComputeWorkloadLifecycleAdapter,
  KubernetesComputeWorkloadStateAdapter,
  KubernetesLeaseLeaderElector,
  LeaseRenewError,
  renewLeadershipOrFence,
} from "@/adapters/server";
import { reconcileComputeWorkload } from "@/features/compute/compute-workload-reconciler";

// biome-ignore lint/style/noProcessEnv: dedicated process composition root validates its own minimal env
const runtimeEnv = process.env;
const log = pino({ level: runtimeEnv.LOG_LEVEL ?? "info" }).child({
  component: "compute-workload-controller",
});
const namespace = runtimeEnv.POD_NAMESPACE;
const environment = runtimeEnv.CONTROLLER_ENVIRONMENT;
const deploymentDomain = runtimeEnv.DEPLOYMENT_DOMAIN;
const apiKeyFile =
  runtimeEnv.AKASH_CONSOLE_API_KEY_FILE ??
  "/var/run/secrets/compute/AKASH_CONSOLE_API_KEY";
const credentialFile = (name: string) => `/var/run/secrets/compute/${name}`;
if (!namespace || !environment || !deploymentDomain) {
  throw new Error(
    "POD_NAMESPACE, CONTROLLER_ENVIRONMENT, and DEPLOYMENT_DOMAIN are required"
  );
}
const controllerEnvironment: string = environment;
const controllerDeploymentDomain: string = deploymentDomain;

const registry = new Registry();
const reconcileTotal = new Counter({
  name: "compute_workload_reconcile_total",
  help: "ComputeWorkload reconciliation attempts",
  labelNames: ["result"],
  registers: [registry],
});
const reconcileDuration = new Histogram({
  name: "compute_workload_reconcile_duration_seconds",
  help: "ComputeWorkload reconciliation duration",
  buckets: [0.1, 0.5, 1, 5, 30, 120, 360],
  registers: [registry],
});
const leaderGauge = new Gauge({
  name: "compute_workload_controller_leader",
  help: "1 when this controller instance holds the Kubernetes Lease",
  registers: [registry],
});
const leaderRenewFailureTotal = new Counter({
  name: "compute_workload_leader_renew_failure_total",
  help: "Lease renewal attempts that did not end holding the lease, by discriminated reason",
  labelNames: ["reason"],
  registers: [registry],
});
const workloadStatusGauge = new Gauge({
  name: "compute_workload_status",
  help: "Current ComputeWorkload phase (one labeled series with value 1 per resource)",
  labelNames: ["namespace", "name", "node_id", "environment", "phase"],
  registers: [registry],
});
const generationLagGauge = new Gauge({
  name: "compute_workload_generation_lag",
  help: "Desired generation minus the last generation observed by the provider controller",
  labelNames: ["namespace", "name", "node_id", "environment"],
  registers: [registry],
});

const kubeConfig = new KubeConfig();
kubeConfig.loadFromCluster();
const custom = kubeConfig.makeApiClient(CustomObjectsApi);
const core = kubeConfig.makeApiClient(CoreV1Api);
const coordination = kubeConfig.makeApiClient(CoordinationV1Api);
const identity = `${hostname()}-${process.pid}`;
const state = new KubernetesComputeWorkloadStateAdapter(
  custom,
  core,
  namespace,
  identity
);
/**
 * bug.5110 — the lease deadline is the ONLY thing standing between a slow k3s API server
 * and a self-fenced controller. At `replicas: 1` a longer deadline costs only failover
 * latency on a redeploy (which the surge-free `maxSurge: 0` rollout already serializes) and buys
 * proportionally more tolerance for consecutive failed renewals.
 */
const leaseDurationSeconds = (() => {
  const raw = Number(runtimeEnv.COMPUTE_CONTROLLER_LEASE_DURATION_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LEASE_DURATION_SECONDS;
})();
/**
 * Renew on a twelfth of the deadline, bounded. Derived rather than a magic 5s so raising
 * the deadline actually raises tolerance (12 consecutive failures) instead of just
 * lengthening the window a fixed 6-attempt budget burns through — and so a stressed API
 * server is not additionally hammered by the controller diagnosing it.
 */
const leaderRenewIntervalMs = Math.min(
  15_000,
  Math.max(5_000, Math.round((leaseDurationSeconds * 1000) / 12))
);
const leader = new KubernetesLeaseLeaderElector(
  coordination,
  namespace,
  "compute-workload-controller",
  identity,
  leaseDurationSeconds
);

const apiKey = await readFile(apiKeyFile, "utf8")
  .then((value) => value.trim())
  .catch(() => "");
const preferredProviders = (runtimeEnv.AKASH_PREFERRED_PROVIDERS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const allowedProviders = (runtimeEnv.AKASH_ALLOWED_PROVIDERS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const lifecycle = apiKey
  ? new ComputeWorkloadLifecycleAdapter(
      new AkashComputeAdapter({
        apiKey,
        timeoutMs: 15_000,
        // An empty configured boundary intentionally rejects every provider.
        // Provider-enabled environments must opt in their reachable accounts.
        allowedProviders,
        ...(preferredProviders.length > 0 ? { preferredProviders } : {}),
        outcomeStore: {
          record: async () => {},
          stats: async () => new Map(),
        },
      })
    )
  : new DormantComputeWorkloadLifecycleAdapter();
const readCredential = (name: string) =>
  readFile(credentialFile(name), "utf8")
    .then((value) => value.trim())
    .catch(() => "");
const [cloudflareToken, cloudflareZoneId] = await Promise.all([
  readCredential("CLOUDFLARE_API_TOKEN"),
  readCredential("CLOUDFLARE_ZONE_ID"),
]);
const dns =
  cloudflareToken && cloudflareZoneId
    ? new CloudflareComputeWorkloadDnsAdapter({
        apiToken: cloudflareToken,
        zoneId: cloudflareZoneId,
      })
    : new DormantComputeWorkloadDnsAdapter();
const secretResolver = new ComputeWorkloadSecretResolverAdapter(
  core,
  namespace
);
if (!apiKey) {
  log.error(
    { reason: "ProviderCredentialMissing" },
    "compute_workload_controller_dormant"
  );
}

let kubeReachable = false;
let shuttingDown = false;
let reconciling = false;
const reconcileLimit = pLimit(2);

createServer(async (request, response) => {
  if (request.url === "/metrics") {
    response.writeHead(200, { "content-type": registry.contentType });
    response.end(await registry.metrics());
    return;
  }
  if (request.url === "/livez") {
    response.writeHead(200).end("ok");
    return;
  }
  if (request.url === "/readyz") {
    response
      .writeHead(kubeReachable ? 200 : 503)
      .end(kubeReachable ? "ok" : "not ready");
    return;
  }
  response.writeHead(404).end();
}).listen(9090, "0.0.0.0");

/** Kubernetes API failures carry no provider secrets; the message is what makes a fence diagnosable. */
function causeFields(cause: unknown): Record<string, string | number> {
  const status = (
    cause as { statusCode?: number; response?: { statusCode?: number } } | null
  )?.statusCode;
  return {
    causeType: cause instanceof Error ? cause.name : "unknown",
    causeMessage:
      cause instanceof Error
        ? cause.message
        : typeof cause === "string"
          ? cause
          : "unknown",
    ...(typeof status === "number" ? { causeStatus: status } : {}),
  };
}

async function renewLeadership(): Promise<void> {
  try {
    await renewLeadershipOrFence(leader, (cause) => {
      kubeReachable = false;
      leaderGauge.set(0);
      leaderRenewFailureTotal.inc({ reason: cause.reason });
      log.fatal(
        {
          reason: "LeadershipLost",
          leaseRenewReason: cause.reason,
          leaseDurationSeconds,
          ...causeFields(cause),
        },
        "compute_workload_leadership_lost_process_fenced"
      );
      // Fencing is reserved for a lease we can no longer prove we hold. In-flight mutations
      // already have a durable attempt marker, so restart fails closed instead of allowing
      // two leaders to write.
      process.exit(1);
    });
    kubeReachable = true;
    leaderGauge.set(leader.isLeader() ? 1 : 0);
  } catch (error) {
    const renewError = error instanceof LeaseRenewError ? error : undefined;
    // A 409 conflict means the API server ANSWERED and we are still inside the deadline we
    // earned, so neither readiness nor the leader gauge may be downgraded — doing so was
    // half of bug.5110's self-harm (it paused reconciliation on a healthy leader).
    const tolerated = renewError?.reason === "cas_conflict";
    if (!tolerated) kubeReachable = false;
    leaderGauge.set(tolerated && leader.isLeader() ? 1 : 0);
    leaderRenewFailureTotal.inc({ reason: renewError?.reason ?? "api_error" });
    // A tolerated conflict is routine noise on a loaded API server; anything else is a
    // real degradation an operator should see. Same event, honest severity.
    const emit = tolerated ? log.warn.bind(log) : log.error.bind(log);
    emit(
      {
        reason: "LeaderRenewFailed",
        leaseRenewReason: renewError?.reason ?? "api_error",
        leaseHeldThrough: leader.leaseHeldThrough(),
        leaseDurationSeconds,
        ...causeFields(error),
      },
      "compute_workload_leader_renew_failed"
    );
  }
}

async function reconcileAll(): Promise<void> {
  if (!leader.isLeader() || reconciling) return;
  reconciling = true;
  try {
    const resources = await state.list();
    kubeReachable = true;
    workloadStatusGauge.reset();
    generationLagGauge.reset();
    for (const resource of resources) {
      const labels = {
        namespace: resource.metadata.namespace,
        name: resource.metadata.name,
        node_id: resource.spec.nodeId,
        environment: resource.spec.environment,
      };
      workloadStatusGauge.set(
        { ...labels, phase: resource.status?.phase ?? "Unknown" },
        1
      );
      generationLagGauge.set(
        labels,
        Math.max(
          0,
          resource.metadata.generation -
            (resource.status?.observedGeneration ?? 0)
        )
      );
    }
    await Promise.all(
      resources.map((resource) =>
        reconcileLimit(async () => {
          if (!leader.isLeader() || shuttingDown) return;
          const leaderEpoch = leader.currentEpoch();
          if (!leaderEpoch) return;
          const started = Date.now();
          const labels = {
            namespace: resource.metadata.namespace,
            name: resource.metadata.name,
            nodeId: resource.spec.nodeId,
            environment: resource.spec.environment,
            generation: resource.metadata.generation,
          };
          try {
            await reconcileComputeWorkload(
              {
                lifecycle,
                state,
                dns,
                secretResolver,
                environment: controllerEnvironment,
                deploymentDomain: controllerDeploymentDomain,
                leaderEpoch,
                assertLeadership: (epoch) => leader.stillHolds(epoch),
                now: () => new Date(),
                recordReadinessTransition: (observation) =>
                  log.info(
                    observation,
                    "compute_workload_readiness_transition"
                  ),
                recordRecoveryLimit: (observation) =>
                  log.error(
                    observation,
                    "compute_workload_recovery_limit_exceeded"
                  ),
                recordMutationFailure: (observation) =>
                  log.warn(observation, "compute_workload_mutation_failed"),
              },
              resource
            );
            reconcileTotal.inc({ result: "success" });
            log.info(
              { ...labels, durationMs: Date.now() - started },
              "compute_workload_reconciled"
            );
          } catch (error) {
            reconcileTotal.inc({ result: "error" });
            log.error(
              {
                reason: "ReconcileFailed",
                causeType: error instanceof Error ? error.name : "unknown",
                ...labels,
                durationMs: Date.now() - started,
              },
              "compute_workload_reconcile_failed"
            );
          } finally {
            reconcileDuration.observe((Date.now() - started) / 1000);
          }
        })
      )
    );
  } catch (error) {
    kubeReachable = false;
    log.error(
      {
        reason: "ListFailed",
        causeType: error instanceof Error ? error.name : "unknown",
      },
      "compute_workload_list_failed"
    );
  } finally {
    reconciling = false;
  }
}

log.info(
  { leaseDurationSeconds, leaderRenewIntervalMs, identity },
  "compute_workload_controller_leader_election_configured"
);
await renewLeadership();
const leaderTimer = setInterval(
  () => void renewLeadership(),
  leaderRenewIntervalMs
);
const reconcileTimer = setInterval(() => void reconcileAll(), 15_000);
void reconcileAll();

function shutdown(signal: string): void {
  shuttingDown = true;
  clearInterval(leaderTimer);
  clearInterval(reconcileTimer);
  log.info({ signal }, "compute_workload_controller_stopping");
  setTimeout(() => process.exit(0), 1_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
