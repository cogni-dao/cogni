// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/readyz/readyz-probes`
 * Purpose: The operator's consumer of `@cogni-dao/substrate-health`: the declared-dependency registry and the
 *   closures `/readyz?deep=1` runs. It works the same way as every node's registry. The operator just declares more.
 * Scope: Owns the declaration map (`SUBSTRATE_DEPENDENCIES`), the probe closures and the drift-guard allowlist.
 *   Does not own the HTTP handler or the default (kubelet) path, which stays local-only and does no remote IO.
 * Invariants:
 *   - Imports are one-way: `route.ts` → this module → `@cogni/substrate-health`.
 *   - `?deep=1` probes exactly the dependencies the operator DECLARES (`isDeclared`), concurrently, each reach-only,
 *     fatal, under DEEP_CHECK_BUDGET_MS.
 *   - Deep registry order fixes first-failure `reason`/`message` and `unreachable[]`: evm-rpc, temporal,
 *     scheduler-worker, postgres, redis, litellm-gateway, doltgres.
 *   - Every substrate env key (`/_(URL|ADDRESS)$/`) is owned by a map entry or allowlisted; the drift guard fails CI
 *     otherwise.
 *   - The database reliability actuator and readmitter are `na`: recovery capacity must not depend on the failure it
 *     repairs (CD5).
 * Side-effects: IO (network reads to RPC/Temporal/LiteLLM/Redis/Doltgres, DB reads) only when a probe runs.
 * Links: src/app/(infra)/readyz/route.ts, @cogni-dao/substrate-health, deep-readyz-design, story.0029
 * @public
 */

import {
  type DeepChecks,
  DeepProbeFailure,
  type ProbeDependency as PkgProbeDependency,
  type SubstrateDependency as PkgSubstrateDependency,
  findUnclassifiedSubstrateKeys as pkgFindUnclassifiedSubstrateKeys,
  runDeepChecks as pkgRunDeepChecks,
  probeKnowledgePlane,
  probeLiteLlmGateway,
  probeRedisStream,
  SUBSTRATE_ENV_KEY_PATTERN,
} from "@cogni/substrate-health";
import type { getContainer } from "@/bootstrap/container";
import { verifySystemTenant } from "@/bootstrap/healthchecks";
import type { serverEnv } from "@/shared/env";
import {
  assertSchedulerWorkerConnectivity,
  assertTemporalConnectivity,
  checkEvmRpcConnectivity,
  InfraConnectivityError,
} from "@/shared/env/invariants";
import type { RequestContext } from "@/shared/observability";

export { type DeepChecks, DeepProbeFailure, SUBSTRATE_ENV_KEY_PATTERN };

type Container = ReturnType<typeof getContainer>;
type Env = ReturnType<typeof serverEnv>;

/** Per-check deadline on `?deep=1`. */
export const DEEP_CHECK_BUDGET_MS = 3000;

/** A fixed id whose point read returns null on a healthy knowledge plane. */
const DOLTGRES_READYZ_PROBE_ID = "readyz-probe-knowledge-reach";
/** A fixed run-stream key; `XLEN` of a missing key is 0. */
const REDIS_READYZ_PROBE_KEY = "readyz:probe";

const wrapInfra = (message: string): Error =>
  new InfraConnectivityError(message);

/** Dependencies a deep 503 can name in `unreachable` (the operator's probe-name union). */
export type DeepDependency =
  | "evm-rpc"
  | "temporal"
  | "scheduler-worker"
  | "postgres"
  | "redis"
  | "litellm-gateway"
  | "doltgres";

/** Run every declared check concurrently with the operator's logger, error type and budget. */
export async function runDeepChecks(
  ctx: RequestContext,
  checks: ReadonlyArray<readonly [DeepDependency, () => Promise<unknown>]>
): Promise<DeepChecks> {
  return pkgRunDeepChecks(checks, {
    log: (fields, message) => ctx.log.info(fields, message),
    timeoutError: (dependency, budgetMs) =>
      new InfraConnectivityError(
        `${dependency} check exceeded ${budgetMs}ms budget`
      ),
    budgetMs: DEEP_CHECK_BUDGET_MS,
  });
}

/** Forced live EVM RPC read; fatal on failure. */
async function checkEvmRpc(
  ctx: RequestContext,
  container: Container,
  env: Env
): Promise<void> {
  const result = await checkEvmRpcConnectivity(
    container.evmOnchainClient,
    env,
    {
      forceLive: true,
    }
  );
  if (!result.ok) {
    const message = `EVM RPC connectivity check failed: ${result.errorMessage ?? "unknown"}`;
    ctx.log.error(
      {
        event: "substrate.evm_rpc.unreachable",
        severity: "critical",
        reason: "INFRA_UNREACHABLE",
        dependency: "evm-rpc",
        source: result.source,
        message,
      },
      "deep readiness: EVM RPC unreachable"
    );
    throw new InfraConnectivityError(message);
  }
  ctx.log.info(
    {
      event: "substrate.evm_rpc.reachable",
      dependency: "evm-rpc",
      source: result.source,
    },
    "deep readiness: EVM RPC reachable"
  );
}

function checkDoltgres(container: Container, env: Env): Promise<void> {
  if (!env.DOLTGRES_URL) return Promise.resolve();
  const port = container.knowledgeStorePort;
  if (!port) {
    return Promise.reject(
      new InfraConnectivityError(
        "Doltgres is declared (DOLTGRES_URL set) but the knowledge store is not wired"
      )
    );
  }
  return probeKnowledgePlane(port, DOLTGRES_READYZ_PROBE_ID, {
    wrapError: wrapInfra,
  })();
}

function checkLiteLlm(env: Env): Promise<void> {
  return probeLiteLlmGateway(
    {
      baseUrl: env.LITELLM_BASE_URL,
      apiKey: env.LITELLM_MASTER_KEY,
      budgetMs: DEEP_CHECK_BUDGET_MS,
    },
    { wrapError: wrapInfra }
  )();
}

function checkRedis(container: Container): Promise<void> {
  return probeRedisStream(container.runStream, REDIS_READYZ_PROBE_KEY, {
    wrapError: wrapInfra,
  })();
}

type SubstrateName =
  | DeepDependency
  | "tigerbeetle"
  | "langfuse"
  | "openbao-eso"
  | "openfga"
  | "database-reliability-actuator"
  | "database-reliability-readmitter";

type ProbeRun = (
  ctx: RequestContext,
  container: Container,
  env: Env
) => Promise<unknown>;

type SubstrateDependency = PkgSubstrateDependency<
  Env,
  DeepDependency,
  SubstrateName,
  ProbeRun
>;

function isProbe(
  dep: SubstrateDependency
): dep is PkgProbeDependency<Env, DeepDependency, ProbeRun> {
  return dep.readyz.kind === "probe";
}

const always = (): boolean => true;

/**
 * The single source of truth for what the operator's deep readiness proves. Probe entries are in deep-registry
 * order. `na` entries record why a declared dependency is not probed.
 */
export const SUBSTRATE_DEPENDENCIES: readonly SubstrateDependency[] = [
  {
    dependency: "evm-rpc",
    envKeys: ["EVM_RPC_URL"],
    isDeclared: always,
    readyz: {
      kind: "probe",
      run: (ctx, container, env) => checkEvmRpc(ctx, container, env),
    },
  },
  {
    dependency: "temporal",
    envKeys: ["TEMPORAL_ADDRESS"],
    isDeclared: always,
    readyz: {
      kind: "probe",
      run: (_ctx, container, env) =>
        assertTemporalConnectivity(container.scheduleControl, env),
    },
  },
  {
    dependency: "scheduler-worker",
    envKeys: ["SCHEDULER_WORKER_HEALTH_URL"],
    isDeclared: always,
    readyz: {
      kind: "probe",
      run: (_ctx, _container, env) => assertSchedulerWorkerConnectivity(env),
    },
  },
  {
    // The system tenant billing account (SYSTEM_TENANT_STARTUP_CHECK) is the Postgres verdict.
    dependency: "postgres",
    envKeys: ["DATABASE_URL", "DATABASE_SERVICE_URL"],
    isDeclared: always,
    readyz: {
      kind: "probe",
      run: (_ctx, container) =>
        verifySystemTenant(container.serviceAccountService),
    },
  },
  {
    dependency: "redis",
    envKeys: ["REDIS_URL"],
    isDeclared: always,
    readyz: { kind: "probe", run: (_ctx, container) => checkRedis(container) },
  },
  {
    dependency: "litellm-gateway",
    envKeys: ["LITELLM_BASE_URL"],
    isDeclared: always,
    readyz: {
      kind: "probe",
      run: (_ctx, _container, env) => checkLiteLlm(env),
    },
  },
  {
    dependency: "doltgres",
    envKeys: ["DOLTGRES_URL"],
    isDeclared: (env) => Boolean(env.DOLTGRES_URL),
    readyz: {
      kind: "probe",
      run: (_ctx, container, env) => checkDoltgres(container, env),
    },
  },
  {
    dependency: "tigerbeetle",
    envKeys: ["TIGERBEETLE_ADDRESS"],
    isDeclared: (env) => Boolean(env.TIGERBEETLE_ADDRESS),
    readyz: {
      kind: "na",
      reason:
        "Account/ledger class; proven out-of-band, never from the serving path.",
    },
  },
  {
    dependency: "langfuse",
    envKeys: ["LANGFUSE_BASE_URL"],
    isDeclared: (env) => Boolean(env.LANGFUSE_BASE_URL),
    readyz: {
      kind: "na",
      reason:
        "Observe class; probing telemetry from the serving path makes it a serving dependency.",
    },
  },
  {
    dependency: "openbao-eso",
    envKeys: [],
    isDeclared: always,
    readyz: {
      kind: "na",
      reason: "Secret delivery is already proven by assertRuntimeSecrets.",
    },
  },
  {
    dependency: "openfga",
    envKeys: ["OPENFGA_API_URL"],
    isDeclared: (env) => Boolean(env.OPENFGA_API_URL),
    readyz: {
      kind: "na",
      reason:
        "Optional until the RBAC store is deployed; not a serving dependency yet.",
    },
  },
  {
    dependency: "database-reliability-actuator",
    envKeys: ["DATABASE_RELIABILITY_ACTUATOR_URL"],
    isDeclared: (env) => Boolean(env.DATABASE_RELIABILITY_ACTUATOR_URL),
    readyz: {
      kind: "na",
      reason:
        "Recovery capacity must live outside the failure it repairs (CD5); never gates serving.",
    },
  },
  {
    dependency: "database-reliability-readmitter",
    envKeys: ["DATABASE_RELIABILITY_READMITTER_URL"],
    isDeclared: (env) => Boolean(env.DATABASE_RELIABILITY_READMITTER_URL),
    readyz: {
      kind: "na",
      reason:
        "Recovery capacity must live outside the failure it repairs (CD5); never gates serving.",
    },
  },
];

/** Build the deep-path checks for the dependencies the operator declares, in registry order. */
export function buildDeepChecks(
  ctx: RequestContext,
  container: Container,
  env: Env
): ReadonlyArray<readonly [DeepDependency, () => Promise<unknown>]> {
  const checks: Array<readonly [DeepDependency, () => Promise<unknown>]> = [];
  for (const dep of SUBSTRATE_DEPENDENCIES) {
    if (!isProbe(dep) || !dep.isDeclared(env)) continue;
    const run = dep.readyz.run;
    checks.push([dep.dependency, () => run(ctx, container, env)]);
  }
  return checks;
}

/** Schema keys that match the substrate pattern but are not substrate dependencies. */
export const NON_SUBSTRATE_ALLOWLIST: readonly string[] = [
  "APP_BASE_URL",
  "LANGGRAPH_DEV_URL",
  "KNOWLEDGE_DOLTHUB_REMOTE_URL",
  "PROMETHEUS_REMOTE_WRITE_URL",
  "PROMETHEUS_QUERY_URL",
  "GRAFANA_URL",
];

/** Drift guard: every substrate-looking schema key owned by no map entry and not allowlisted. */
export function findUnclassifiedSubstrateKeys(
  schemaKeys: readonly string[]
): string[] {
  const classifiedKeys = SUBSTRATE_DEPENDENCIES.flatMap((dep) => [
    ...dep.envKeys,
  ]);
  return pkgFindUnclassifiedSubstrateKeys(schemaKeys, {
    classifiedKeys,
    allowlist: NON_SUBSTRATE_ALLOWLIST,
  });
}
