// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/scheduler-worker-service/bootstrap/container`
 * Purpose: Composition root — wires HTTP adapters (runs/grants) and optional Drizzle adapters (ledger only) to port interfaces.
 * Scope: All adapter construction lives here. Returns typed container against port interfaces. Does not export identity constants.
 * Invariants:
 * - Per SHARED_COMPUTE_HOLDS_NO_DB_CREDS (task.0280): scheduler path holds no DB credentials. createContainer() never touches DATABASE_URL; HttpGraphRunWriter + HttpExecutionGrantValidator route every call through the owning node's internal API.
 * - Only file that imports concrete adapter packages (@cogni/db-client for ledger only, @cogni/repo-spec, @cogni/attribution-pipeline-plugins)
 * - activities/ and workflows/ import ports only, never this module
 * - REPO_SPEC_AUTHORITY: identity (node_id, scope_id, chain_id) read from @cogni/repo-spec at bootstrap
 * - SOURCE_ADAPTER_COVERAGE: cross-checks repo-spec activity_sources against registered adapters; logs CONFIG_SOURCE_NO_ADAPTER at error level for each configured source missing an adapter
 * - CAPABILITY_REQUIRED: every DataSourceRegistration must have at least one of poll or webhook (throws at bootstrap)
 * Side-effects: createContainer() — none (HTTP clients, no DB). createAttributionContainer() — creates DB client when DATABASE_URL set; reads .cogni/repo-spec.yaml from disk.
 * Links: services/scheduler-worker/src/ports/index.ts, packages/repo-spec/
 * @internal
 */

import fs from "node:fs";
import path from "node:path";

import { createValidatedAttributionStore } from "@cogni/attribution-ledger";
import {
  createDefaultRegistries,
  type DefaultRegistries,
} from "@cogni/attribution-pipeline-plugins";
import { DrizzleAttributionAdapter } from "@cogni/db-client";
import { createServiceDbClient } from "@cogni/db-client/service";
import {
  extractChainId,
  extractLedgerConfig,
  extractNodeId,
  extractScopeId,
  parseRepoSpec,
} from "@cogni/repo-spec";
import {
  GitHubAppTokenProvider,
  GitHubSourceAdapter,
} from "../adapters/ingestion/index.js";
import { createSharedTokenNodePrincipalResolver } from "../adapters/node-principal.js";
import {
  createHttpExecutionGrantValidator,
  createHttpGraphRunWriter,
} from "../adapters/run-http.js";
import { logWorkerEvent, WORKER_EVENT_NAMES } from "../observability/index.js";
import type { Logger } from "../observability/logger.js";

import type {
  AttributionStore,
  DataSourceRegistration,
  ExecutionGrantHttpValidator,
  GraphRunHttpWriter,
  NodePrincipalResolver,
} from "../ports/index.js";
import type { Env } from "./env.js";

/**
 * Service container — all deps typed against port interfaces.
 * Passed to createActivities() and any future consumers.
 */
export interface ServiceContainer {
  grantAdapter: ExecutionGrantHttpValidator;
  runAdapter: GraphRunHttpWriter;
  /** Per-node dispatch principal (task.5034) — MVP resolves the shared SCHEDULER_API_TOKEN, identical to graph dispatch; per-node credential is the hardening for both paths. */
  nodePrincipalResolver: NodePrincipalResolver;
  config: {
    nodeEndpoints: Map<string, string>;
    schedulerApiToken: string;
  };
  logger: Logger;
}

/**
 * Parse COGNI_NODE_ENDPOINTS env var into a Map<nodeId, baseUrl>.
 * Format: "operator=http://operator-app:3000,poly=http://poly-app:3100"
 */
function parseNodeEndpoints(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of raw.split(",")) {
    const [key, ...rest] = pair.trim().split("=");
    const value = rest.join("="); // Handle URLs with = in them
    if (key && value) {
      map.set(key.trim(), value.trim());
    }
  }
  if (map.size === 0) {
    throw new Error(
      "COGNI_NODE_ENDPOINTS must contain at least one node=url pair"
    );
  }
  return map;
}

/**
 * Read and parse .cogni/repo-spec.yaml from the baked-in location.
 * In Docker: /app/.cogni/repo-spec.yaml (COPY'd in Dockerfile).
 * In dev: resolved relative to process.cwd() (repo root).
 */
function loadRepoSpecIdentity(): {
  nodeId: string;
  scopeId: string;
  chainId: number;
  configuredSources: string[];
  excludedLogins: string[];
} {
  // Try /app/.cogni first (Docker), then cwd (dev)
  const candidates = [
    path.join("/app", ".cogni", "repo-spec.yaml"),
    path.join(process.cwd(), ".cogni", "repo-spec.yaml"),
  ];

  let content: string | undefined;
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      content = fs.readFileSync(candidate, "utf8");
      break;
    }
  }

  if (!content) {
    throw new Error(
      `[repo-spec] Missing .cogni/repo-spec.yaml — searched: ${candidates.join(", ")}`
    );
  }

  const spec = parseRepoSpec(content);
  const ledgerConfig = extractLedgerConfig(spec);
  // Collect excluded logins from all activity sources
  const excludedLogins = ledgerConfig
    ? Object.values(ledgerConfig.activitySources).flatMap(
        (s) => s.excludedLogins ?? []
      )
    : [];
  return {
    nodeId: extractNodeId(spec),
    scopeId: extractScopeId(spec),
    chainId: extractChainId(spec),
    configuredSources: ledgerConfig
      ? Object.keys(ledgerConfig.activitySources)
      : [],
    excludedLogins,
  };
}

/**
 * Ledger container — deps for ledger activities.
 * Created separately because ledger identity comes from repo-spec.
 */
export interface AttributionContainer {
  attributionStore: AttributionStore;
  sourceRegistrations: ReadonlyMap<string, DataSourceRegistration>;
  registries: DefaultRegistries;
  nodeId: string;
  scopeId: string;
  chainId: number;
  logger: Logger;
}

/**
 * Build the service container from validated env and logger.
 * This is the only place that instantiates concrete adapters.
 */
export function createContainer(config: Env, logger: Logger): ServiceContainer {
  // Per task.0280: the scheduler path holds no DB credentials. Grant validation,
  // graph_runs create/update all flow through the owning node's internal API,
  // authenticated by SCHEDULER_API_TOKEN. nodeId → nodeUrl lookup via the
  // COGNI_NODE_ENDPOINTS map, same one executeGraphActivity already uses.
  const nodeEndpoints = parseNodeEndpoints(config.COGNI_NODE_ENDPOINTS);
  const deps = {
    nodeEndpoints,
    schedulerApiToken: config.SCHEDULER_API_TOKEN,
    logger: logger.child?.({ component: "run-http" }) ?? logger,
  };
  return {
    grantAdapter: createHttpExecutionGrantValidator(deps),
    runAdapter: createHttpGraphRunWriter(deps),
    // MVP (task.5034): per-node dispatch principal = the shared SCHEDULER_API_TOKEN,
    // IDENTICAL to the credential the graph dispatch already uses in run-http.ts.
    // NodeTask is consistent with graphs (syntropy) and dispatch can succeed today.
    // The per-node credential is the hardening for BOTH paths (task.5033 +
    // secrets-on-spawn); the fail-closed resolver is built but intentionally not
    // wired until that credential store exists.
    nodePrincipalResolver: createSharedTokenNodePrincipalResolver(
      config.SCHEDULER_API_TOKEN
    ),
    config: {
      nodeEndpoints,
      schedulerApiToken: config.SCHEDULER_API_TOKEN,
    },
    logger,
  };
}

/**
 * Build ledger container. Reads identity from .cogni/repo-spec.yaml.
 * Returns null if repo-spec is missing scope_id (ledger requires scope identity).
 */
export function createAttributionContainer(
  config: Env,
  logger: Logger
): AttributionContainer | null {
  if (!config.DATABASE_URL) {
    logger.info(
      { reason: "no_database_url" },
      "Attribution/ledger container disabled — DATABASE_URL not set. This is the normal scheduler-only configuration per task.0280. Set DATABASE_URL only when this worker also runs the attribution pipeline."
    );
    return null;
  }

  const { nodeId, scopeId, chainId, configuredSources, excludedLogins } =
    loadRepoSpecIdentity();

  logWorkerEvent(logger, WORKER_EVENT_NAMES.LIFECYCLE_STARTING, {
    phase: "ledger_container",
    nodeId,
    scopeId,
    chainId,
    configuredSources,
  });

  const db = createServiceDbClient(config.DATABASE_URL);
  const attributionLogger = logger.child?.({ component: "ledger" }) ?? logger;

  const attributionStore = createValidatedAttributionStore(
    new DrizzleAttributionAdapter(db, scopeId)
  );

  // Build source registrations (CAPABILITY_REQUIRED: at least one of poll/webhook)
  const registrations = new Map<string, DataSourceRegistration>();

  if (config.GH_REVIEW_APP_ID && config.GH_REVIEW_APP_PRIVATE_KEY_BASE64) {
    const privateKey = Buffer.from(
      config.GH_REVIEW_APP_PRIVATE_KEY_BASE64,
      "base64"
    ).toString("utf-8");

    const tokenProvider = new GitHubAppTokenProvider({
      appId: config.GH_REVIEW_APP_ID,
      privateKey,
    });

    const repos =
      config.GH_REPOS?.split(",")
        .map((r) => r.trim())
        .filter(Boolean) ?? [];

    if (repos.length > 0) {
      const pollAdapter = new GitHubSourceAdapter(
        { tokenProvider, repos },
        attributionLogger
      );

      registrations.set("github", {
        source: "github",
        version: pollAdapter.version,
        poll: pollAdapter,
      });
    } else {
      logger.warn(
        "GH_REVIEW_APP_ID set but GH_REPOS empty — GitHub adapter skipped"
      );
    }
  }

  // CAPABILITY_REQUIRED: validate every registration has at least one capability
  for (const [name, reg] of registrations) {
    if (!reg.poll && !reg.webhook) {
      throw new Error(
        `[CAPABILITY_REQUIRED] DataSourceRegistration "${name}" has neither poll nor webhook capability`
      );
    }
  }

  // SOURCE_ADAPTER_COVERAGE: warn loudly for each configured source missing an adapter
  for (const source of configuredSources) {
    if (!registrations.has(source)) {
      logger.error(
        {
          event: WORKER_EVENT_NAMES.CONFIG_SOURCE_NO_ADAPTER,
          source,
          errorCode: "source_no_adapter",
        },
        `activity_sources.${source} is configured in repo-spec but no adapter was registered — check env vars (GH_REVIEW_APP_ID, GH_REVIEW_APP_PRIVATE_KEY_BASE64, GH_REPOS)`
      );
    }
  }

  return {
    attributionStore,
    sourceRegistrations: registrations,
    registries: createDefaultRegistries({ excludedLogins }),
    nodeId,
    scopeId,
    chainId,
    logger: attributionLogger,
  };
}
