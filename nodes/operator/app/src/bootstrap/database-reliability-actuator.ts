// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/database-reliability-actuator`
 * Purpose: Private autonomous reliability controller and authenticated status readback.
 * Scope: Wires reviewed ports/adapters; does not expose admin credentials or a public route.
 * Invariants: PRIVATE_CREDENTIALS, ONE_MINUTE_SWEEP, FAIL_CLOSED, BOUNDED_TARGET_FAILURES.
 * Side-effects: catalog/Mimir/Loki/Cherry/Postgres IO and a private HTTP listener.
 * Links: task.5247, /api/v1/nodes/{id}/observability/health
 * @internal
 */

import { timingSafeEqual } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { ReliabilityStatusV1 } from "@cogni/node-contracts";
import pino from "pino";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import {
  HttpReliabilityRecoveryAdapter,
  PinoDatabaseContainmentAuditWriter,
  PostgresAdminSqlAdapter,
  PostgresDatabaseRecoveryBeginAdapter,
  PostgresDatabaseRecoveryProbeAdapter,
  PostgresDatabaseRecoveryVerificationAdapter,
  PostgresReadmitSqlAdapter,
  RecoveryLedgerDatabaseContainmentAdapter,
} from "@/adapters/server";
import {
  createCellAdminRecoveryControls,
  createCellReadmitRecoveryControls,
  PostgresDatabaseCellRecoveryProbeAdapter,
  routeCellRecoveryBegin,
  routeCellRecoveryVerification,
} from "@/adapters/server/db/database-recovery-cell.adapter";
import { createGrafanaMimirAdapter } from "@/adapters/server/metrics/grafana-mimir.adapter";
import {
  hasHealthyScopedRecoveryWindow,
  isReliabilitySweepReady,
  RELIABILITY_EVIDENCE_TTL_MS,
  type ReliabilityTarget,
  runReliabilitySweep,
  verifyCurrentDatabaseRecovery,
} from "@/features/nodes/reliability-status";
import type {
  DatabaseRecoveryIncident,
  ReliabilityRecoveryCheck,
} from "@/ports";
import { hostForEnv } from "@/shared/node-registry/deploy-hosts";
import { EVENT_NAMES } from "@/shared/observability";
import { runDatabaseRecoveryWatchdog } from "./database-recovery-watchdog";

const SWEEP_INTERVAL_MS = 60_000;
const CREDENTIAL_DIR = "/var/run/secrets/database-reliability";
const CATALOG_DIR = "/app/infra/catalog";
// biome-ignore lint/style/noProcessEnv: standalone composition root validates its minimal env
const runtimeEnv = process.env;
type Environment = "candidate-a" | "preview" | "production";
type RuntimeMode = "sweep" | "readmit" | "watchdog";

const ReliabilityControllerCatalogSchema = z.object({
  type: z.literal("node"),
  name: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  path_prefix: z.string().regex(/^[a-z0-9._/-]+\/$/),
  source_repo: z.never().optional(),
  is_primary_host: z.literal(true),
  reliability: z.object({ controller: z.literal(true) }),
});

const CatalogIdentitySchema = z
  .object({
    nodeId: z.string().uuid(),
  })
  .or(
    z
      .object({ node_id: z.string().uuid() })
      .transform((value) => ({ nodeId: value.node_id }))
  );

async function resolveReliabilityController(): Promise<{
  slug: string;
  nodeId: string;
}> {
  const files = (await readdir(CATALOG_DIR)).filter((name) =>
    name.endsWith(".yaml")
  );
  const matches: Array<{ slug: string; pathPrefix: string }> = [];
  for (const name of files) {
    const raw = parseYaml(await readFile(`${CATALOG_DIR}/${name}`, "utf8"));
    if (raw?.reliability?.controller !== true) continue;
    const row = ReliabilityControllerCatalogSchema.parse(raw);
    matches.push({ slug: row.name, pathPrefix: row.path_prefix });
  }
  if (matches.length !== 1)
    throw new Error("reliability_catalog_controller_not_unique");
  const controller = matches[0];
  if (!controller) throw new Error("reliability_catalog_controller_missing");
  const identity = CatalogIdentitySchema.parse(
    parseYaml(
      await readFile(
        `/app/${controller.pathPrefix}.cogni/repo-spec.yaml`,
        "utf8"
      )
    )
  );
  return { slug: controller.slug, nodeId: identity.nodeId };
}

function requiredEnv(name: string): string {
  const value = runtimeEnv[name]?.trim();
  if (!value) throw new Error(`database_reliability_missing_env:${name}`);
  return value;
}

async function credential(name: string): Promise<string> {
  const value = await readFile(`${CREDENTIAL_DIR}/${name}`, "utf8")
    .then((text) => text.trim())
    .catch(() => "");
  if (!value)
    throw new Error(`database_reliability_missing_credential:${name}`);
  return value;
}

async function optionalCellBindings(name: string): Promise<unknown> {
  const raw = await readFile(`${CREDENTIAL_DIR}/${name}`, "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "[]";
      throw error;
    }
  );
  return JSON.parse(raw);
}

function parseEnvironment(value: string): Environment {
  if (["candidate-a", "preview", "production"].includes(value))
    return value as Environment;
  throw new Error("database_reliability_environment_invalid");
}

function parseBuildSha(value: string): string {
  if (/^[0-9a-f]{40}$/.test(value)) return value;
  throw new Error("database_reliability_build_sha_invalid");
}

function parseRuntimeMode(value: string): RuntimeMode {
  if (value === "sweep" || value === "readmit" || value === "watchdog")
    return value;
  throw new Error("database_reliability_mode_invalid");
}

function authorized(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}

const environment = parseEnvironment(requiredEnv("DEPLOY_ENVIRONMENT"));
const buildSha = parseBuildSha(requiredEnv("APP_BUILD_SHA"));
const mode = parseRuntimeMode(requiredEnv("DATABASE_RELIABILITY_MODE"));
if (mode === "watchdog") {
  await runDatabaseRecoveryWatchdog({
    environment,
    buildSha,
    ownerId: requiredEnv("POD_UID"),
    adminDsn: await credential("DATABASE_RELIABILITY_ADMIN_URL"),
    cellAdminBindings: await optionalCellBindings(
      "DATABASE_RELIABILITY_CELL_ADMIN_URLS_JSON"
    ),
  });
  throw new Error("database_recovery_watchdog_exited");
}
const reliabilityController = await resolveReliabilityController();
const port = mode === "sweep" ? 8080 : 8081;
const log = pino({ level: runtimeEnv.LOG_LEVEL ?? "info" }).child({
  buildSha,
  component: `database-reliability-${mode}`,
  service:
    mode === "sweep"
      ? "database-reliability-actuator"
      : "database-reliability-readmitter",
});
const rootDomain = requiredEnv("FORK_DOMAIN_ROOT");
const statusToken = await credential("DATABASE_RELIABILITY_STATUS_TOKEN");
const adminDsn =
  mode === "sweep" ? await credential("DATABASE_RELIABILITY_ADMIN_URL") : null;
const readmitToken =
  mode === "readmit"
    ? await credential("DATABASE_RELIABILITY_READMIT_TOKEN")
    : null;

const metrics =
  mode === "sweep"
    ? await createGrafanaMimirAdapter({
        grafanaUrl: await credential("GRAFANA_URL"),
        bearerToken: await credential("GRAFANA_SERVICE_ACCOUNT_TOKEN"),
        timeoutMs: 10_000,
      })
    : null;
const sharedRecoveryProbes =
  mode === "sweep"
    ? new PostgresDatabaseRecoveryProbeAdapter(
        JSON.parse(await credential("DATABASE_RECOVERY_PROBE_URLS_JSON"))
      )
    : null;
const cellProbeBindings =
  mode === "sweep"
    ? await optionalCellBindings("DATABASE_RECOVERY_CELL_PROBE_URLS_JSON")
    : [];
const cellProbes =
  mode === "sweep"
    ? new PostgresDatabaseCellRecoveryProbeAdapter(cellProbeBindings)
    : null;
const cellAdmins =
  mode === "sweep"
    ? createCellAdminRecoveryControls(
        await optionalCellBindings("DATABASE_RELIABILITY_CELL_ADMIN_URLS_JSON")
      )
    : [];
const cellReadmitters =
  mode === "readmit"
    ? createCellReadmitRecoveryControls(
        await optionalCellBindings(
          "DATABASE_RELIABILITY_CELL_READMIT_URLS_JSON"
        )
      )
    : [];
for (const cell of cellAdmins) {
  if (!cellProbes) throw new Error("database_recovery_cell_probe_unavailable");
  const probe = cellProbes.bindingFor(cell.binding);
  if (
    probe.nodeSlug !== cell.binding.nodeSlug ||
    probe.databaseName !== cell.binding.databaseName ||
    probe.probeRole !== cell.binding.probeRole ||
    probe.systemIdentifier !== cell.binding.systemIdentifier ||
    probe.substrateHost !== cell.binding.substrateHost ||
    probe.sourceSha !== cell.binding.sourceSha ||
    probe.targetBuildSha !== cell.binding.targetBuildSha ||
    probe.endpoint.host !== cell.binding.endpoint.host ||
    probe.endpoint.port !== cell.binding.endpoint.port
  )
    throw new Error("database_recovery_cell_capability_bindings_mismatch");
}
const cellIdentities =
  mode === "sweep"
    ? cellAdmins.map((row) => row.binding)
    : cellReadmitters.map((row) => row.binding);
const cellFor = (input: { nodeId: string; environment: string }) =>
  cellIdentities.find(
    (row) =>
      row.nodeId === input.nodeId && row.environment === input.environment
  );
const recoveryProbes =
  sharedRecoveryProbes && cellProbes
    ? {
        bindingFor: (
          input: Parameters<typeof sharedRecoveryProbes.bindingFor>[0]
        ) =>
          cellFor(input)
            ? cellProbes.bindingFor(input)
            : sharedRecoveryProbes.bindingFor(input),
        observe: (input: Parameters<typeof sharedRecoveryProbes.observe>[0]) =>
          cellFor(input)
            ? cellProbes.observe(input)
            : sharedRecoveryProbes.observe(input),
      }
    : null;
const recoveryVerifier =
  mode === "sweep" && adminDsn
    ? routeCellRecoveryVerification(
        new PostgresDatabaseRecoveryVerificationAdapter(
          new PostgresAdminSqlAdapter(adminDsn)
        ),
        cellAdmins
      )
    : null;
const recoveryBegin =
  mode === "readmit"
    ? routeCellRecoveryBegin(
        new PostgresDatabaseRecoveryBeginAdapter(
          new PostgresReadmitSqlAdapter(
            await credential("DATABASE_RELIABILITY_READMIT_URL")
          )
        ),
        cellReadmitters
      )
    : null;
const recoveryReader =
  mode === "readmit"
    ? new HttpReliabilityRecoveryAdapter({
        baseUrl: requiredEnv("DATABASE_RELIABILITY_ACTUATOR_URL"),
        bearerToken: statusToken,
      })
    : null;
const containment =
  recoveryProbes && recoveryVerifier
    ? new RecoveryLedgerDatabaseContainmentAdapter({
        ledger: recoveryVerifier,
        probe: recoveryProbes,
        audit: new PinoDatabaseContainmentAuditWriter(log),
        targetBuildShaFor: (input) => {
          const target = [...currentTargets.values()].find(
            (row) =>
              row.nodeId === input.nodeId &&
              row.environment === input.environment
          );
          if (!target)
            throw new Error("database_recovery_catalog_target_missing");
          return target.sourceSha;
        },
      })
    : null;

const statuses = new Map<string, ReliabilityStatusV1>();
let currentTargets = new Map<string, ReliabilityTarget>();
let lastCompleteSweepAt: number | null = null;
let sweepRunning = false;
let stopping = false;

const statusKey = (target: Pick<ReliabilityTarget, "environment" | "slug">) =>
  `${target.environment}/${target.slug}`;

function targetOrigin(target: ReliabilityTarget): string {
  return `https://${hostForEnv(target.slug, target.slug === reliabilityController.slug, target.environment, rootDomain)}`;
}

async function recoveryCheck(
  target: ReliabilityTarget,
  proofClass: ReliabilityRecoveryCheck["proofClass"]
): Promise<ReliabilityRecoveryCheck> {
  if (!recoveryProbes || !recoveryVerifier || !metrics)
    throw new Error("database_recovery_probe_unavailable");
  const binding = recoveryProbes.bindingFor({
    nodeId: target.nodeId,
    nodeSlug: target.slug,
    environment: target.environment,
  });
  const product =
    proofClass === "recovery-product"
      ? fetch(new URL("/readyz?deep=1", targetOrigin(target)), {
          redirect: "error",
          signal: AbortSignal.timeout(5_000),
        }).then(async (response) => {
          if (
            !response.ok ||
            !z
              .object({
                status: z.literal("healthy"),
                buildSha: z.literal(target.sourceSha),
              })
              .safeParse(await response.json()).success
          ) {
            throw new Error("database_recovery_product_unproved");
          }
        })
      : Promise.resolve();
  const [observation, incident, actualSha, substrate] = await Promise.all([
    recoveryProbes.observe({
      nodeId: target.nodeId,
      nodeSlug: target.slug,
      environment: target.environment,
    }),
    recoveryVerifier.current(target),
    readTargetBuildSha(target),
    target.desiredTier === "dedicated"
      ? Promise.resolve(null)
      : metrics.queryReliabilitySnapshot({
          nodeSlug: target.slug,
          environment: target.environment,
          databaseTier: target.desiredTier,
          budgetProfile: target.budgetProfile,
          substrateHost: binding.substrateHost,
        }),
    product,
  ]);
  if (
    !incident ||
    incident.targetBuildSha !== target.sourceSha ||
    actualSha !== incident.targetBuildSha ||
    incident.databaseSystemIdentifier !== observation.systemIdentifier ||
    !observation.systemTenantExists
  ) {
    throw new Error("database_recovery_identity_unproved");
  }
  const age = Date.now() - Date.parse(observation.observedAt);
  const health =
    target.desiredTier === "dedicated" ? observation.cellSubstrate : substrate;
  if (
    !health ||
    age < -15_000 ||
    age > RELIABILITY_EVIDENCE_TTL_MS ||
    (target.desiredTier === "shared" && substrate?.evidenceScope !== "node") ||
    health.ioPressurePct === null ||
    health.ioPressurePct >= 10 ||
    health.connectionPct === null ||
    health.connectionPct >= 60 ||
    health.memoryHeadroomPct === null ||
    health.memoryHeadroomPct <= 25 ||
    health.diskHeadroomPct === null ||
    health.diskHeadroomPct <= 25
  ) {
    throw new Error("database_recovery_substrate_unproved");
  }
  if (proofClass === "recovery") {
    if (
      incident.state !== "contained" ||
      !observation.runtimeRolesNoLogin ||
      observation.activeRuntimeSessions !== 0
    ) {
      throw new Error("database_recovery_runtime_not_fenced");
    }
  } else {
    if (
      !["recovering", "readmitted"].includes(incident.state) ||
      !observation.appRolesCanLogin
    ) {
      throw new Error("database_recovery_runtime_not_open");
    }
  }
  return {
    status: "healthy",
    buildSha: incident.targetBuildSha,
    databaseSystemIdentifier: observation.systemIdentifier,
    incidentId: incident.incidentId,
    proofClass,
  };
}

async function assertRecoveryWindow(
  target: ReliabilityTarget,
  incident: DatabaseRecoveryIncident,
  proofClass: ReliabilityRecoveryCheck["proofClass"]
): Promise<ReliabilityStatusV1["regionalReadiness"]> {
  if (!metrics) throw new Error("database_recovery_window_owner_unavailable");
  const end = new Date();
  const result = await metrics.queryRange({
    query: `min_over_time(probe_success{environment="${target.environment}",node_slug="${target.slug}",proof_class="${proofClass}",target_build_sha="${incident.targetBuildSha}",database_system_identifier="${incident.databaseSystemIdentifier}"}[1m])`,
    start: new Date(end.getTime() - 5 * 60_000),
    end,
    step: "60s",
  });
  if (
    !hasHealthyScopedRecoveryWindow({
      nowMs: end.getTime(),
      since:
        proofClass === "recovery"
          ? incident.containedAt
          : (incident.startedAt ?? ""),
      targetBuildSha: incident.targetBuildSha,
      databaseSystemIdentifier: incident.databaseSystemIdentifier,
      proofClass,
      series: result.result,
    })
  ) {
    throw new Error("database_readmission_evidence_incomplete");
  }
  return result.result.map((series) => ({
    region: series.metric.probe ?? series.metric.region ?? "",
    healthy: true,
    observedAt: new Date((series.values.at(-1)?.[0] ?? 0) * 1000).toISOString(),
  }));
}

let verificationRunning = false;
async function verifyPendingRecoveries(onlyNodeId?: string): Promise<void> {
  if (!recoveryVerifier || verificationRunning) return;
  verificationRunning = true;
  try {
    for (const incident of await recoveryVerifier.listPending({
      environment,
    })) {
      if (onlyNodeId && incident.nodeId !== onlyNodeId) continue;
      const target = currentTargets.get(
        `${incident.environment}/${incident.nodeSlug}`
      );
      try {
        const result = await verifyCurrentDatabaseRecovery({
          incident,
          ledger: recoveryVerifier,
          proveCurrentProduct: async () => {
            if (!target || target.sourceSha !== incident.targetBuildSha)
              return false;
            await recoveryCheck(target, "recovery-product");
            return true;
          },
          proveWindow: async () => {
            if (!target) return false;
            await assertRecoveryWindow(target, incident, "recovery-product");
            return true;
          },
        });
        if (result?.transitionApplied)
          log.info(
            {
              event: EVENT_NAMES.NODE_RELIABILITY_TRANSITION,
              action:
                result.state === "readmitted" ? "readmitted" : "recontained",
              ...result,
              occurredAt: result.verifiedAt ?? new Date().toISOString(),
            },
            EVENT_NAMES.NODE_RELIABILITY_TRANSITION
          );
      } catch (error) {
        log.warn({
          event: "feature.node_reliability.recovery.unproved",
          incidentId: incident.incidentId,
          error,
        });
      }
    }
  } finally {
    verificationRunning = false;
  }
}

async function readTargetBuildSha(
  target: ReliabilityTarget
): Promise<string | null> {
  try {
    const response = await fetch(new URL("/version", targetOrigin(target)), {
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;
    const result = z
      .object({ buildSha: z.string().regex(/^[0-9a-f]{40}$/) })
      .parse(await response.json());
    return result.buildSha;
  } catch {
    return null;
  }
}

async function listTargets(): Promise<readonly ReliabilityTarget[]> {
  const files = (await readdir(CATALOG_DIR)).filter((name) =>
    name.endsWith(".yaml")
  );
  const nodes = await Promise.all(
    files.map(async (name) =>
      CatalogEntrySchema.parse(
        parseYaml(await readFile(`${CATALOG_DIR}/${name}`, "utf8"))
      )
    )
  );
  return nodes.flatMap((node) => {
    if (node.type !== "node") return [];
    const placement = node.databasePlacements[environment];
    if (!placement || !node.deployEnvs.includes(environment)) return [];
    const nodeId =
      node.nodeId ??
      (node.isReliabilityController ? reliabilityController.nodeId : undefined);
    if (!nodeId)
      throw new Error(`reliability_catalog_node_id_missing:${node.slug}`);
    const cell = cellFor({ nodeId, environment });
    if (cell && (placement.tier !== "dedicated" || cell.nodeSlug !== node.slug))
      throw new Error("database_recovery_cell_catalog_identity_mismatch");
    const sourceSha =
      cell?.targetBuildSha ??
      node.sourceSha ??
      (node.isReliabilityController ? buildSha : undefined);
    if (!sourceSha)
      throw new Error(`reliability_catalog_source_sha_missing:${node.slug}`);
    let substrateHost: string | undefined;
    if (recoveryProbes) {
      try {
        substrateHost = recoveryProbes.bindingFor({
          nodeId,
          nodeSlug: node.slug,
          environment,
        }).substrateHost;
      } catch {
        log.warn(
          { nodeId, nodeSlug: node.slug, environment },
          "database_recovery_probe_binding_missing"
        );
      }
    }
    return [
      {
        nodeId,
        slug: node.slug,
        environment,
        desiredTier: placement.tier,
        budgetProfile: placement.budgetProfile,
        sourceSha,
        ...(substrateHost ? { substrateHost } : {}),
      },
    ];
  });
}

const CatalogEntrySchema = z
  .object({
    type: z.string(),
    name: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
    node_id: z.string().uuid().optional(),
    source_sha: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .optional(),
    reliability: z.object({ controller: z.boolean().optional() }).optional(),
    envs: z.array(z.enum(["candidate-a", "preview", "production"])).default([]),
    database: z
      .record(
        z.string(),
        z.object({
          tier: z.enum(["shared", "dedicated"]),
          budget_profile: z.string().min(1),
        })
      )
      .default({}),
  })
  .transform((value) => ({
    type: value.type,
    slug: value.name,
    nodeId: value.node_id,
    sourceSha: value.source_sha,
    isReliabilityController: value.reliability?.controller === true,
    deployEnvs: value.envs,
    databasePlacements: Object.fromEntries(
      Object.entries(value.database).map(([key, placement]) => [
        key,
        {
          tier: placement.tier,
          budgetProfile: placement.budget_profile,
        },
      ])
    ) as Partial<
      Record<
        Environment,
        { tier: "shared" | "dedicated"; budgetProfile: string }
      >
    >,
  }));

async function readDedicatedStatus(
  target: ReliabilityTarget
): Promise<ReliabilityStatusV1> {
  if (!recoveryProbes || !recoveryVerifier || !cellFor(target))
    throw new Error("database_recovery_cell_binding_missing");
  const [observation, incident, actualSha] = await Promise.all([
    recoveryProbes.observe({
      nodeId: target.nodeId,
      nodeSlug: target.slug,
      environment: target.environment,
    }),
    recoveryVerifier.current(target),
    readTargetBuildSha(target),
  ]);
  if (
    actualSha !== target.sourceSha ||
    (incident &&
      (incident.targetBuildSha !== target.sourceSha ||
        incident.databaseSystemIdentifier !== observation.systemIdentifier))
  )
    throw new Error("database_recovery_cell_status_identity_mismatch");
  const health = observation.cellSubstrate;
  if (!health) throw new Error("database_recovery_cell_substrate_missing");
  const contained =
    observation.runtimeRolesNoLogin && observation.activeRuntimeSessions === 0;
  let regionalReadiness: ReliabilityStatusV1["regionalReadiness"] = [];
  let healthy = false;
  if (
    incident?.state === "readmitted" &&
    incident.verifiedAt &&
    observation.appRolesCanLogin
  ) {
    await recoveryCheck(target, "recovery-product");
    regionalReadiness = await assertRecoveryWindow(
      target,
      incident,
      "recovery-product"
    );
    healthy = true;
  }
  return {
    version: "reliability-status.v1",
    nodeId: target.nodeId,
    slug: target.slug,
    environment: target.environment,
    buildSha: actualSha,
    databaseTier: "dedicated",
    budgetProfile: target.budgetProfile,
    state:
      incident?.state === "recovering"
        ? "recovering"
        : contained
          ? "contained"
          : healthy
            ? "healthy"
            : "unknown",
    regionalReadiness,
    utilization: {
      evidenceScope: "node",
      ioPressurePct: health.ioPressurePct,
      connectionPct: health.connectionPct,
      memoryHeadroomPct: health.memoryHeadroomPct,
      diskHeadroomPct: health.diskHeadroomPct,
      databaseShare5m: {
        backendsPct: null,
        physicalReadsPct: null,
        tempBytesPct: null,
      },
    },
    incidentId: incident?.incidentId ?? null,
    incidentReason:
      incident?.reason ?? "dedicated regional readiness remains unproved",
    observedAt: new Date().toISOString(),
    lastTransitionAt:
      incident?.verifiedAt ??
      incident?.startedAt ??
      incident?.containedAt ??
      null,
    evidenceQueryRefs: ["native:database_recovery_probe:dedicated-cell"],
  };
}

async function sweep(): Promise<void> {
  if (sweepRunning || stopping) return;
  if (!containment || !metrics)
    throw new Error("database_reliability_sweep_unavailable");
  sweepRunning = true;
  const startedAt = Date.now();
  try {
    const catalogTargets = (await listTargets()).filter((target) =>
      Boolean(target.substrateHost)
    );
    if (catalogTargets.length === 0)
      throw new Error("reliability_targets_empty");
    const nextTargets = new Map(
      catalogTargets.map((target) => [statusKey(target), target] as const)
    );
    currentTargets = nextTargets;
    await verifyPendingRecoveries();
    for (const key of statuses.keys()) {
      if (!nextTargets.has(key)) statuses.delete(key);
    }
    const minute = Math.floor(Date.now() / SWEEP_INTERVAL_MS);
    const results = [
      ...(await runReliabilitySweep(
        catalogTargets.filter((target) => target.desiredTier === "shared"),
        {
          metrics,
          containment,
          buildShaFor: async (target) => readTargetBuildSha(target),
          incidentIdFor: (target) =>
            `reliability.v1:${target.environment}:${target.nodeId}:${minute}`,
        }
      )),
    ];
    for (const target of catalogTargets.filter(
      (row) => row.desiredTier === "dedicated"
    )) {
      try {
        results.push({
          target,
          status: await readDedicatedStatus(target),
          error: null,
        });
      } catch (error) {
        results.push({
          target,
          status: null,
          error:
            error instanceof Error
              ? error.message
              : "database_recovery_cell_status_unproved",
        });
      }
    }
    for (const result of results) {
      if (result.status) statuses.set(statusKey(result.target), result.status);
      log[result.error ? "error" : "info"](
        {
          event: EVENT_NAMES.NODE_RELIABILITY_STATUS_COMPLETE,
          environment,
          nodeId: result.target.nodeId,
          nodeSlug: result.target.slug,
          buildSha: result.status?.buildSha ?? null,
          databaseTier:
            result.status?.databaseTier ?? result.target.desiredTier,
          budgetProfile:
            result.status?.budgetProfile ?? result.target.budgetProfile,
          state: result.status?.state ?? "unknown",
          evidenceScope:
            result.status?.utilization.evidenceScope ?? "environment-shared",
          databaseShare5m: result.status?.utilization.databaseShare5m ?? null,
          observedAt: result.status?.observedAt ?? null,
          outcome: result.error ? "error" : "success",
          reason: result.error,
        },
        EVENT_NAMES.NODE_RELIABILITY_STATUS_COMPLETE
      );
    }
    const complete = results.every(
      (result) => result.error === null && result.status !== null
    );
    lastCompleteSweepAt = complete ? Date.now() : null;
    log.info(
      {
        event: EVENT_NAMES.NODE_RELIABILITY_SWEEP_COMPLETE,
        environment,
        targets: catalogTargets.length,
        failures: results.filter((result) => result.error).length,
        durationMs: Date.now() - startedAt,
      },
      EVENT_NAMES.NODE_RELIABILITY_SWEEP_COMPLETE
    );
  } catch (error) {
    lastCompleteSweepAt = null;
    log.error(
      { event: EVENT_NAMES.NODE_RELIABILITY_SWEEP_FAILED, environment, error },
      EVENT_NAMES.NODE_RELIABILITY_SWEEP_FAILED
    );
  } finally {
    sweepRunning = false;
  }
}

const server = createServer(async (request, response) => {
  try {
    if (request.url === "/healthz") {
      response.writeHead(200).end("ok");
      return;
    }
    if (request.url === "/readyz") {
      if (mode === "readmit") {
        // Listener readiness is independent of the deliberately disabled LOGIN capability.
        response
          .writeHead(200)
          .end("ready; readmission disabled pending recovery proof");
        return;
      }
      const ready = isReliabilitySweepReady({
        nowMs: Date.now(),
        lastCompleteSweepAt,
        targetKeys: new Set(currentTargets.keys()),
        statusKeys: new Set(statuses.keys()),
      });
      response.writeHead(ready ? 200 : 503).end(ready ? "ready" : "not ready");
      return;
    }
    if (request.method === "GET" && request.url === "/version") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ buildSha }));
      return;
    }
    const url = new URL(request.url ?? "/", "http://actuator.invalid");
    const isPublicStatus =
      request.method === "GET" && url.pathname === "/v1/status";
    const isInternalStatus =
      request.method === "GET" && url.pathname === "/v1/internal/status";
    const isSubstrate =
      request.method === "GET" && url.pathname === "/v1/internal/substrate";
    const isRecovery =
      request.method === "GET" && url.pathname === "/v1/internal/recovery";
    const isRecoveryWindow =
      request.method === "GET" &&
      url.pathname === "/v1/internal/recovery-window";
    const isRecoveryVerify =
      request.method === "POST" &&
      url.pathname === "/v1/internal/recovery-verify";
    const isReadmit =
      request.method === "POST" && url.pathname === "/v1/readmit";
    const routeAllowed =
      (mode === "sweep" &&
        (isPublicStatus ||
          isInternalStatus ||
          isSubstrate ||
          isRecovery ||
          isRecoveryWindow ||
          isRecoveryVerify)) ||
      (mode === "readmit" && isReadmit);
    if (!routeAllowed) {
      response.writeHead(404).end("not found");
      return;
    }
    const requiredToken = mode === "sweep" ? statusToken : readmitToken;
    if (!requiredToken) {
      throw new Error("database_reliability_runtime_token_missing");
    }
    if (!authorized(request.headers.authorization, requiredToken)) {
      response.writeHead(401).end("unauthorized");
      return;
    }
    const nodeSlug = url.searchParams.get("node_slug");
    const nodeId = url.searchParams.get("node_id");
    const requestedEnvironment = url.searchParams.get("environment");
    const key = `${requestedEnvironment}/${nodeSlug}`;
    const target =
      nodeSlug && requestedEnvironment === environment
        ? mode === "sweep"
          ? currentTargets.get(key)
          : (await listTargets()).find(
              (candidate) => statusKey(candidate) === key
            )
        : undefined;
    const isBoundCellRead =
      isRecovery &&
      !nodeId &&
      target?.desiredTier === "dedicated" &&
      Boolean(cellFor(target));
    if (!target || (!isBoundCellRead && target.nodeId !== nodeId)) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "reliability_status_unavailable" }));
      return;
    }
    if (isRecovery || isRecoveryWindow) {
      const proof = url.searchParams.get("proof_class");
      if (proof !== "recovery" && proof !== "recovery-product") {
        response.writeHead(400).end("invalid recovery proof class");
        return;
      }
      const evidence = await recoveryCheck(target, proof);
      if (isRecoveryWindow) {
        const incident = await recoveryVerifier?.current(target);
        if (!incident || incident.incidentId !== evidence.incidentId)
          throw new Error("database_recovery_incident_changed");
        await assertRecoveryWindow(target, incident, proof);
      }
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(evidence));
      return;
    }
    if (isRecoveryVerify) {
      await verifyPendingRecoveries(target.nodeId);
      response.writeHead(202).end("verification requested");
      return;
    }
    if (isSubstrate) {
      if (!recoveryProbes)
        throw new Error("database_recovery_probe_unavailable");
      const startedAt = performance.now();
      const binding = recoveryProbes.bindingFor({
        nodeId: target.nodeId,
        nodeSlug: target.slug,
        environment,
      });
      const observed = await recoveryProbes.observe({
        nodeId: target.nodeId,
        nodeSlug: target.slug,
        environment,
      });
      if (!observed.systemTenantExists)
        throw new Error("database_recovery_system_tenant_missing");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          substrateHost: binding.substrateHost,
          databaseSystemIdentifier: observed.systemIdentifier,
          databaseName: observed.database,
          serverAddress: observed.serverAddress,
          serverPort: observed.serverPort,
          latencyMs: performance.now() - startedAt,
          observedAt: observed.observedAt,
        })
      );
      return;
    }
    if (isPublicStatus) {
      const status = statuses.get(key);
      const statusAgeMs = status
        ? Date.now() - Date.parse(status.observedAt)
        : Number.POSITIVE_INFINITY;
      if (
        !status ||
        statusAgeMs < -15_000 ||
        statusAgeMs > RELIABILITY_EVIDENCE_TTL_MS
      ) {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ error: "reliability_status_unavailable" })
        );
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(status));
      return;
    }

    const containmentInput = {
      nodeId: target.nodeId,
      nodeSlug: target.slug,
      environment: target.environment,
      desiredTier: target.desiredTier,
      budgetProfile: target.budgetProfile,
      ...(target.cellId ? { cellId: target.cellId } : {}),
    };
    if (isInternalStatus) {
      if (!containment) {
        throw new Error("database_reliability_sweep_unavailable");
      }
      const status = await containment.status(containmentInput);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(status));
      return;
    }

    const actorId = request.headers["x-cogni-actor-id"];
    const incidentId = request.headers["x-cogni-incident-id"];
    if (
      typeof actorId !== "string" ||
      !/^human:[a-zA-Z0-9._@:-]{1,120}$/.test(actorId) ||
      typeof incidentId !== "string" ||
      !/^reliability\.v1:[a-zA-Z0-9._:-]{1,180}$/.test(incidentId)
    ) {
      response.writeHead(400).end("invalid readmission attribution");
      return;
    }
    if (!recoveryBegin || !recoveryReader)
      throw new Error("database_recovery_unavailable");
    const current = await recoveryBegin.current(target);
    if (
      !current ||
      current.incidentId !== incidentId ||
      current.state === "recontained"
    ) {
      response
        .writeHead(409, { "content-type": "application/json" })
        .end(
          JSON.stringify({ error: "database_recovery_new_incident_required" })
        );
      return;
    }
    if (current.state === "recovering" || current.state === "readmitted") {
      response
        .writeHead(current.state === "recovering" ? 202 : 200, {
          "content-type": "application/json",
        })
        .end(
          JSON.stringify({
            phase: current.state === "recovering" ? "recovering" : "open",
            incidentId,
            deadlineAt: current.deadlineAt,
            lastTransitionAt: current.verifiedAt ?? current.startedAt,
          })
        );
      return;
    }
    const evidence = await recoveryReader.readWindow({
      nodeId: target.nodeId,
      nodeSlug: target.slug,
      environment,
      expectedBuildSha: current.targetBuildSha,
      proofClass: "recovery",
    });
    if (
      target.sourceSha !== current.targetBuildSha ||
      evidence.incidentId !== current.incidentId ||
      evidence.databaseSystemIdentifier !== current.databaseSystemIdentifier
    )
      throw new Error("database_recovery_identity_unproved");
    const result = await recoveryBegin.begin({
      nodeId: target.nodeId,
      nodeSlug: target.slug,
      environment,
      incidentId,
      actorId,
      targetBuildSha: current.targetBuildSha,
      databaseSystemIdentifier: current.databaseSystemIdentifier,
    });
    if (result.transitionApplied)
      log.info(
        {
          event: EVENT_NAMES.NODE_RELIABILITY_TRANSITION,
          action: "recovering",
          ...result,
          occurredAt: result.startedAt,
        },
        EVENT_NAMES.NODE_RELIABILITY_TRANSITION
      );
    // The readmitter requests observation only; the actuator owns every fence/completion decision.
    await recoveryReader.verify({
      nodeId: target.nodeId,
      nodeSlug: target.slug,
      environment,
    });
    const observed = await recoveryBegin.current(target);
    if (
      !observed ||
      observed.incidentId !== result.incidentId ||
      observed.state === "recontained"
    ) {
      response.writeHead(503, { "content-type": "application/json" }).end(
        JSON.stringify({
          error: "database_recovery_product_unproved",
          incidentId,
        })
      );
      return;
    }
    response.writeHead(202, { "content-type": "application/json" }).end(
      JSON.stringify({
        phase: "recovering",
        incidentId,
        deadlineAt: result.deadlineAt,
        lastTransitionAt: result.startedAt,
      })
    );
  } catch (error) {
    log.error(
      { event: EVENT_NAMES.NODE_RELIABILITY_HTTP_FAILED, error },
      EVENT_NAMES.NODE_RELIABILITY_HTTP_FAILED
    );
    if (!response.headersSent) {
      response.writeHead(503, { "content-type": "application/json" });
    }
    response.end(
      JSON.stringify({ error: "database_reliability_request_failed" })
    );
  }
});

server.listen(port, "0.0.0.0", () => {
  log.info(
    {
      event: EVENT_NAMES.NODE_RELIABILITY_ACTUATOR_STARTED,
      environment,
      buildSha,
    },
    EVENT_NAMES.NODE_RELIABILITY_ACTUATOR_STARTED
  );
  if (mode === "sweep") void sweep();
});
const interval =
  mode === "sweep" ? setInterval(() => void sweep(), SWEEP_INTERVAL_MS) : null;
const verificationInterval =
  mode === "sweep"
    ? setInterval(
        () =>
          void verifyPendingRecoveries().catch((error) =>
            log.error({
              event: "feature.node_reliability.recovery.verification_failed",
              error,
            })
          ),
        5_000
      )
    : null;

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  if (interval) clearInterval(interval);
  if (verificationInterval) clearInterval(verificationInterval);
  log.info(
    { event: EVENT_NAMES.NODE_RELIABILITY_ACTUATOR_STOPPING, signal },
    EVENT_NAMES.NODE_RELIABILITY_ACTUATOR_STOPPING
  );
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
