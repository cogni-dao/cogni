// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/container`
 * Purpose: Dependency injection container for application composition root with environment-based adapter selection.
 * Scope: Wire adapters to ports for runtime dependency injection. Provides webhookRegistrations for ingestion route, Temporal WorkflowClient singleton. Does not handle request-scoped lifecycle.
 * Invariants: All ports wired; single container instance per process; config.unhandledErrorPolicy set by env; webhookRegistrations lazy-initialized; Temporal connection singleton with race-safe init.
 * Side-effects: IO (initializes logger and emits startup log on first access)
 * Notes: LLM always uses LiteLlmAdapter; stack tests route to mock-openai-api. ContainerConfig controls wrapper behavior.
 * Links: Used by API routes and other entry points; configure adapters here for DI.
 * @public
 */

import type { ToolSourcePort } from "@cogni/ai-core";
import type {
  ComputeResourcePort,
  DeployCapability,
  EdoCapability,
  KnowledgeCapability,
  MetricsCapability,
  RepoCapability,
  VcsCapability,
  WebSearchCapability,
} from "@cogni/ai-tools";
import { CORE_TOOL_BUNDLE, VCS_TOOL_BUNDLE } from "@cogni/ai-tools";
import type { AttributionStore } from "@cogni/attribution-ledger";
import {
  type AuthorizationPort,
  OpenFgaAuthorizationAdapter,
} from "@cogni/authorization-core";
import { DrizzleAttributionAdapter } from "@cogni/db-client";
import type { FinancialLedgerPort } from "@cogni/financial-ledger";
import { createTigerBeetleAdapter } from "@cogni/financial-ledger/adapters";
import type { UserId } from "@cogni/ids";
import { toUserId, userActor } from "@cogni/ids";
import {
  type ContributionService,
  createContributionService,
  createEdoCapability,
  createKnowledgeCapability,
  defaultCanMergeKnowledge,
  type KnowledgeStorePort,
  shapeGate,
} from "@cogni/knowledge-store";
import {
  buildDoltgresClient,
  createDoltgresPusher,
  DoltgresEdoResolverAdapter,
  DoltgresKnowledgeContributionAdapter,
  DoltgresKnowledgeStoreAdapter,
  wrapPushSafe,
} from "@cogni/knowledge-store/adapters/doltgres";
import { parseMcpConfigFromEnv } from "@cogni/langgraph-graphs";
import {
  COGNI_SYSTEM_PRINCIPAL_USER_ID,
  initAnalytics,
  shutdownAnalytics,
} from "@cogni/node-shared";
import {
  type NodeStreamPort,
  RedisNodeStreamAdapter,
} from "@cogni/node-streams";
import { numberToPpm } from "@cogni/operator-wallet";
import { PrivyOperatorWalletAdapter } from "@cogni/operator-wallet/adapters/privy";
import type { ScheduleControlPort } from "@cogni/scheduler-core";
import type { WorkItemQueryPort } from "@cogni/work-items";
import { MarkdownWorkItemAdapter } from "@cogni/work-items/markdown";
import {
  Client as TemporalClient,
  Connection as TemporalConnection,
  type WorkflowClient,
} from "@temporalio/client";
import { eq, inArray } from "drizzle-orm";
import Redis from "ioredis";
import type { Logger } from "pino";
import {
  ALCHEMY_ADAPTER_VERSION,
  AlchemyWebhookNormalizer,
  type Database,
  DrizzleAiTelemetryAdapter,
  DrizzleConnectionBrokerAdapter,
  DrizzleExecutionGrantUserAdapter,
  DrizzleExecutionGrantWorkerAdapter,
  DrizzleExecutionRequestAdapter,
  DrizzleGovernanceStatusAdapter,
  DrizzleGraphRunAdapter,
  DrizzleScheduleUserAdapter,
  DrizzleThreadPersistenceAdapter,
  EvmRpcOnChainVerifierAdapter,
  GITHUB_ADAPTER_VERSION,
  GitHubWebhookNormalizer,
  getAppDb,
  LangfuseAdapter,
  LiteLlmAdapter,
  type MimirAdapterConfig,
  MimirMetricsAdapter,
  RedisRunStreamAdapter,
  SplitPaymentRailGuardAdapter,
  SystemClock,
  TemporalScheduleControlAdapter,
  UserDrizzleAccountService,
  UserDrizzlePaymentAttemptRepository,
  ViemEvmOnchainClient,
  ViemTreasuryAdapter,
} from "@/adapters/server";
import { ServiceDrizzleAccountService } from "@/adapters/server/accounts/drizzle.adapter";
import {
  AggregatingModelCatalog,
  ProviderResolver,
} from "@/adapters/server/ai/catalog";
import { mcpServersToCodexConfig } from "@/adapters/server/ai/codex/codex-mcp-config";
import {
  CodexModelProvider,
  OpenAiCompatibleModelProvider,
  PlatformModelProvider,
} from "@/adapters/server/ai/providers";
import {
  DoltgresNotConfiguredError,
  getDoltgresWorkItemsAdapter,
} from "@/adapters/server/db/doltgres/client";
import { getServiceDb } from "@/adapters/server/db/drizzle.service-client";
import { DrizzleWorkItemSessionAdapter } from "@/adapters/server/db/work-item-session.adapter";
import { CompositeNodeRegistryAdapter } from "@/adapters/server/node-registry/composite-node-registry.adapter";
import { DbNodeRegistryAdapter } from "@/adapters/server/node-registry/db-node-registry.adapter";
import { LiveNodeRegistryAdapter } from "@/adapters/server/node-registry/live-node-registry.adapter";
import { NETWORK_NODES } from "@/adapters/server/node-registry/network-nodes.data";
import { StaticNodeRegistryAdapter } from "@/adapters/server/node-registry/static-node-registry.adapter";
import { ServiceDrizzlePaymentAttemptRepository } from "@/adapters/server/payments/drizzle-payment-attempt.adapter";
import { SplitTreasurySettlementAdapter } from "@/adapters/server/treasury/split-treasury-settlement.adapter";
import {
  FakeMetricsAdapter,
  getTestEvmOnchainClient,
  getTestOnChainVerifier,
  getTestOperatorWallet,
} from "@/adapters/test";
import { createToolBindings } from "@/bootstrap/ai/tool-bindings";
import { createBoundToolSource } from "@/bootstrap/ai/tool-source.factory";
import { createComputeCapability } from "@/bootstrap/capabilities/compute";
import { createDeployCapability } from "@/bootstrap/capabilities/deploy";
import {
  createMetricsCapability,
  derivePrometheusQueryUrl,
} from "@/bootstrap/capabilities/metrics";
import { createLivenessAccessor } from "@/bootstrap/capabilities/node-registry";
import { createOperatorDeployPlane } from "@/bootstrap/capabilities/operator-deploy-plane";
import { createRepoCapability } from "@/bootstrap/capabilities/repo";
import { createScheduleCapability } from "@/bootstrap/capabilities/schedule";
import { createVcsCapability } from "@/bootstrap/capabilities/vcs";
import { createWebSearchCapability } from "@/bootstrap/capabilities/web-search";
import { createWorkItemCapability } from "@/bootstrap/capabilities/work-item";
import type { RateLimitBypassConfig } from "@/bootstrap/http/wrapPublicRoute";
import { resolveKnowledgeMirrorRemoteUrl } from "@/bootstrap/knowledge-mirror";
import { startProcessHealthPublisher } from "@/bootstrap/publishers";
import { startGovernanceSyncOnBoot } from "@/bootstrap/startup-reconcile";
import {
  type AttributionProfileResolver,
  createAttributionProfileResolver,
} from "@/features/nodes/attribution-profile-resolver";
import type {
  AccountService,
  AiTelemetryPort,
  Clock,
  ConnectionBrokerPort,
  DataSourceRegistration,
  GovernanceStatusPort,
  LangfusePort,
  LlmService,
  MetricsQueryPort,
  ModelCatalogPort,
  ModelProviderResolverPort,
  NodeRegistryPort,
  OnChainVerifier,
  OperatorWalletPort,
  PaymentAttemptServiceRepository,
  PaymentAttemptUserRepository,
  PaymentRailGuardPort,
  RunStreamPort,
  ServiceAccountService,
  ThreadPersistencePort,
  TreasuryReadPort,
  TreasurySettlementPort,
  WorkItemSessionPort,
} from "@/ports";
import { PaymentRailMisconfiguredPortError } from "@/ports";
import type {
  ExecutionGrantUserPort,
  ExecutionGrantWorkerPort,
  ExecutionRequestPort,
  GraphRunRepository,
  ScheduleUserPort,
  WorkItemsDoltgresPort,
} from "@/ports/server";
import {
  getDaoTreasuryAddress,
  getKnowledgeConfig,
  getNodeId,
  getOperatorWalletConfig,
  getPaymentConfig,
  getScopeId,
  getStewardWalletConfig,
} from "@/shared/config";
import { nodes } from "@/shared/db/nodes";
import { serverEnv } from "@/shared/env/server-env";
import { baseDomain } from "@/shared/node-registry/resolve";
import { makeLogger } from "@/shared/observability";
import { USDC_TOKEN_ADDRESS } from "@/shared/web3";
import type { EvmOnchainClient } from "@/shared/web3/onchain/evm-onchain-client.interface";

export type UnhandledErrorPolicy = "rethrow" | "respond_500";

export interface ContainerConfig {
  /** How to handle unhandled errors in route wrappers: rethrow for dev/test, respond_500 for production safety */
  unhandledErrorPolicy: UnhandledErrorPolicy;
  /** Rate limit bypass config for stack tests; only enabled when APP_ENV=test */
  rateLimitBypass: RateLimitBypassConfig;
  /** Deploy environment for metrics/logging (e.g., "local", "preview", "production") */
  DEPLOY_ENVIRONMENT: string;
}

export interface Container {
  log: Logger;
  config: ContainerConfig;
  llmService: LlmService;
  accountsForUser(userId: UserId): AccountService;
  serviceAccountService: ServiceAccountService;
  clock: Clock;
  paymentAttemptsForUser(userId: UserId): PaymentAttemptUserRepository;
  paymentAttemptServiceRepository: PaymentAttemptServiceRepository;
  onChainVerifier: OnChainVerifier;
  evmOnchainClient: EvmOnchainClient;
  /** True when repo-spec has payments_in config (receiving address + chain). False for nodes pending activation. */
  paymentRailsActive: boolean;
  /** Fail-closed guard for live payment rail activation before issuing payment intents. */
  paymentRailGuard: PaymentRailGuardPort;
  metricsQuery: MetricsQueryPort;
  treasuryReadPort: TreasuryReadPort;
  /** AI telemetry DB writer - always wired */
  aiTelemetry: AiTelemetryPort;
  /** Langfuse tracer - undefined when LANGFUSE_SECRET_KEY not set */
  langfuse: LangfusePort | undefined;
  nodeId: string;
  // Scheduling ports (split by trust boundary)
  scheduleControl: ScheduleControlPort;
  executionGrantPort: ExecutionGrantUserPort;
  executionGrantWorkerPort: ExecutionGrantWorkerPort;
  executionRequestPort: ExecutionRequestPort;
  graphRunRepository: GraphRunRepository;
  scheduleManager: ScheduleUserPort;
  /** Metrics capability for AI tools - requires PROMETHEUS_URL to be configured */
  metricsCapability: MetricsCapability;
  /** Compute-substrate balance reads (story.5011) — stub (empty) until CHERRY_AUTH_TOKEN is on the runtime */
  computeCapability: ComputeResourcePort;
  /** Web search capability for AI tools - requires TAVILY_API_KEY to be configured */
  webSearchCapability: WebSearchCapability;
  /** Repo capability for AI tools - requires COGNI_REPO_PATH */
  repoCapability: RepoCapability;
  /** VCS capability for GitHub operations - requires GH_REVIEW_APP_ID */
  vcsCapability: VcsCapability;
  /** Read-only deploy capability (SEE flow) — undefined when no base domain is configured */
  deployCapability: DeployCapability | undefined;
  /** Tool source with real implementations for AI tool execution */
  toolSource: ToolSourcePort;
  /** External-agent knowledge contribution service — undefined when DOLTGRES_URL is unset */
  knowledgeContributionService: ContributionService | undefined;
  /** Direct knowledge store port — exposed for the cookie-only browse endpoint. Undefined when DOLTGRES_URL is unset. */
  knowledgeStorePort: KnowledgeStorePort | undefined;
  /** EDO hypothesis-loop capability for the langgraph tool bindings AND the bearer-auth REST routes under /api/v1/edo. Always present (stubs throw when DOLTGRES_URL is unset). */
  edoCapability: EdoCapability;
  /** Thread persistence scoped to a user (RLS enforced) */
  threadPersistenceForUser(userId: UserId): ThreadPersistencePort;
  /** Governance status queries (system tenant scope) */
  governanceStatus: GovernanceStatusPort;
  /** Epoch ledger store — shared by app and scheduler-worker */
  attributionStore: AttributionStore;
  /** Work item queries — reads from markdown files via WorkItemQueryPort */
  workItemQuery: WorkItemQueryPort;
  /** Doltgres-backed work-items API surface — task.0423 v0. Throws if DOLTGRES_URL is unset. */
  doltgresWorkItems: WorkItemsDoltgresPort;
  /** Operator-local active work-item coordination sessions. */
  workItemSessions: WorkItemSessionPort;
  /** Run event streaming — publish/subscribe via Redis Streams */
  runStream: RunStreamPort;
  /** Node-level event streaming — undefined when REDIS_URL not set */
  nodeStream: NodeStreamPort | undefined;
  /** Webhook source registrations — normalizers for webhook ingestion */
  webhookRegistrations: ReadonlyMap<string, DataSourceRegistration>;
  /** Financial ledger — undefined when TIGERBEETLE_ADDRESS not set */
  financialLedger: FinancialLedgerPort | undefined;
  /** Operator wallet — undefined when PRIVY_APP_ID not set */
  operatorWallet: OperatorWalletPort | undefined;
  /** Treasury settlement — undefined when operator wallet not configured */
  treasurySettlement: TreasurySettlementPort | undefined;
  /** Connection broker — undefined when CONNECTIONS_ENCRYPTION_KEY not set */
  connectionBroker: ConnectionBrokerPort | undefined;
  /** Authorization port — undefined until OpenFGA env is configured */
  authorization: AuthorizationPort | undefined;
  /** Model catalog — aggregates all providers for model listing */
  modelCatalog: ModelCatalogPort;
  /** Provider resolver — resolves providerKey to ModelProviderPort for runtime dispatch */
  providerResolver: ModelProviderResolverPort;
}

// Feature-specific dependency types
// AI adapter deps: used internally by createGraphExecutor
export type AiAdapterDeps = {
  llmService: LlmService;
  accountService: AccountService;
  clock: Clock;
  aiTelemetry: AiTelemetryPort;
  langfuse: LangfusePort | undefined;
  nodeId: string;
};

/**
 * Activity dashboard dependencies.
 * Per CHARGE_RECEIPTS_IS_LEDGER_TRUTH: charge_receipts is primary data source.
 * LLM detail (model/tokens) fetched via listLlmChargeDetails, merged in facade.
 */
export type ActivityDeps = {
  accountService: AccountService;
};

// Module-level singleton
let _container: Container | null = null;
let _temporalConnection: TemporalConnection | null = null;
let _workflowClient: WorkflowClient | null = null;
let _workflowClientPromise: Promise<{
  client: WorkflowClient;
  taskQueue: string;
}> | null = null;

/**
 * Get the singleton container instance.
 * Lazily initializes on first access.
 */
export function getContainer(): Container {
  if (!_container) {
    _container = createContainer();
    // First container init (e.g. the readyz probe) is the earliest in-bootstrap seam
    // to self-activate this deploy's governance schedules from repo-spec
    // (SELF_RECONCILE_ON_BOOT) — instrumentation.ts cannot import bootstrap. Detached,
    // fire-once, retry-until-Temporal-ready; never blocks the caller.
    startGovernanceSyncOnBoot();
  }
  return _container;
}

/**
 * Reset the singleton container.
 * For tests only - allows fresh container between test runs.
 */
export function resetContainer(): void {
  _container = null;
  _webhookRegistrations = null;
  if (_temporalConnection) {
    void _temporalConnection.close();
  }
  _temporalConnection = null;
  _workflowClient = null;
  _workflowClientPromise = null;
}

/**
 * Get a process-wide Temporal WorkflowClient singleton + task queue.
 * Avoids per-request Connection.connect() overhead on hot paths.
 * Returns both client and taskQueue so callers never need serverEnv() directly.
 */
export async function getTemporalWorkflowClient(): Promise<{
  client: WorkflowClient;
  taskQueue: string;
}> {
  // Per QUEUE_PER_NODE_ISOLATION (task.0280): submit to a per-node task queue
  // keyed on this node's UUID. The worker runs one Temporal Worker per node,
  // so one node's queue backlog does not starve the others.
  const perNodeTaskQueue = `${serverEnv().TEMPORAL_TASK_QUEUE}-${getNodeId()}`;
  if (_workflowClient) {
    return {
      client: _workflowClient,
      taskQueue: perNodeTaskQueue,
    };
  }
  if (!_workflowClientPromise) {
    _workflowClientPromise = (async () => {
      const env = serverEnv();
      const connection = await TemporalConnection.connect({
        address: env.TEMPORAL_ADDRESS,
      });
      const temporalClient = new TemporalClient({
        connection,
        namespace: env.TEMPORAL_NAMESPACE,
      });
      _temporalConnection = connection;
      _workflowClient = temporalClient.workflow;
      return { client: _workflowClient, taskQueue: perNodeTaskQueue };
    })();
  }
  return _workflowClientPromise;
}

/** Lazy singleton for webhook registrations (avoids import cost at container init). */
let _webhookRegistrations: ReadonlyMap<string, DataSourceRegistration> | null =
  null;

function getWebhookRegistrations(): ReadonlyMap<
  string,
  DataSourceRegistration
> {
  if (!_webhookRegistrations) {
    const registrations = new Map<string, DataSourceRegistration>();
    registrations.set("github", {
      source: "github",
      version: GITHUB_ADAPTER_VERSION,
      webhook: new GitHubWebhookNormalizer(),
    });
    registrations.set("alchemy", {
      source: "alchemy",
      version: ALCHEMY_ADAPTER_VERSION,
      webhook: new AlchemyWebhookNormalizer(),
    });
    _webhookRegistrations = registrations;
  }
  return _webhookRegistrations;
}

function createContainer(): Container {
  const env = serverEnv();
  const nodeId = getNodeId();
  const db = getAppDb();
  const log = makeLogger({ service: "cogni-template", nodeId });

  // Startup log - confirm config in Loki (no URLs/secrets)
  log.info(
    {
      env: env.APP_ENV,
      logLevel: env.PINO_LOG_LEVEL,
      pretty: env.NODE_ENV === "development",
    },
    "container initialized"
  );

  // Initialize PostHog product analytics (required — env validated at boot)
  if (env.POSTHOG_API_KEY && env.POSTHOG_HOST) {
    initAnalytics({
      apiKey: env.POSTHOG_API_KEY,
      host: env.POSTHOG_HOST,
      appVersion: env.COGNI_REPO_SHA ?? "unknown",
      environment: env.DEPLOY_ENVIRONMENT ?? "local",
    });
    log.info("PostHog analytics initialized");
  } else {
    log.info("PostHog not configured — analytics disabled");
  }

  // Flush analytics events on graceful shutdown
  const flushOnExit = () => {
    shutdownAnalytics().catch(() => {});
  };
  process.on("SIGTERM", flushOnExit);
  process.on("SIGINT", flushOnExit);

  // LLM adapter: always LiteLlmAdapter (test stacks use mock-openai-api via litellm.test.config.yaml)
  const llmService = new LiteLlmAdapter();

  // EvmOnchainClient: test uses singleton fake (configurable from tests), production uses viem RPC
  const evmOnchainClient = env.isTestMode
    ? getTestEvmOnchainClient()
    : new ViemEvmOnchainClient();

  // OnChainVerifier: test uses singleton fake (configurable from tests), production uses EVM RPC verifier
  const onChainVerifier = env.isTestMode
    ? getTestOnChainVerifier()
    : new EvmRpcOnChainVerifierAdapter(evmOnchainClient);

  // MetricsQuery: test uses fake adapter, production uses Prometheus HTTP API
  // Not configured: stub that throws on use (deferred error, doesn't block startup)
  const metricsQuery: MetricsQueryPort = env.isTestMode
    ? new FakeMetricsAdapter()
    : (() => {
        const queryUrl = derivePrometheusQueryUrl(env);
        if (
          !queryUrl ||
          !env.PROMETHEUS_READ_USERNAME ||
          !env.PROMETHEUS_READ_PASSWORD
        ) {
          // Return stub that throws on use - allows app to start without metrics config
          const notConfiguredError = new Error(
            "MetricsQueryPort not configured. Set PROMETHEUS_QUERY_URL (or PROMETHEUS_REMOTE_WRITE_URL " +
              "ending in /api/prom/push) + PROMETHEUS_READ_USERNAME + PROMETHEUS_READ_PASSWORD."
          );
          return {
            queryRange: async () => {
              throw notConfiguredError;
            },
            queryInstant: async () => {
              throw notConfiguredError;
            },
            queryTemplate: async () => {
              throw notConfiguredError;
            },
          } satisfies MetricsQueryPort;
        }

        const mimirConfig: MimirAdapterConfig = {
          url: queryUrl,
          username: env.PROMETHEUS_READ_USERNAME,
          password: env.PROMETHEUS_READ_PASSWORD,
          timeoutMs: env.ANALYTICS_QUERY_TIMEOUT_MS,
        };
        return new MimirMetricsAdapter(mimirConfig);
      })();

  // FinancialLedger: optional — only when TIGERBEETLE_ADDRESS is configured
  // @cogni/financial-ledger/adapters is in serverExternalPackages (N-API addon, not bundleable)
  const financialLedger: FinancialLedgerPort | undefined = (() => {
    if (!env.TIGERBEETLE_ADDRESS) return undefined;
    try {
      const adapter = createTigerBeetleAdapter(env.TIGERBEETLE_ADDRESS);
      log.info(
        { address: env.TIGERBEETLE_ADDRESS },
        "TigerBeetle financial ledger connected"
      );
      return adapter;
    } catch (err) {
      log.warn(
        { err },
        "TigerBeetle client failed to initialize — financial ledger disabled"
      );
      return undefined;
    }
  })();

  // Always use real database adapters
  // Testing strategy: unit tests mock the port, integration tests use real DB
  const serviceAccountService = new ServiceDrizzleAccountService(
    getServiceDb(),
    financialLedger
  );
  // TreasuryReadPort: always uses ViemTreasuryAdapter (no test fake needed - mocked at port level in tests)
  const treasuryReadPort = new ViemTreasuryAdapter(evmOnchainClient);

  // AI Telemetry: DrizzleAiTelemetryAdapter always wired (per AI_SETUP_SPEC.md)
  const aiTelemetry = new DrizzleAiTelemetryAdapter(db);

  // Langfuse: only wired when LANGFUSE_SECRET_KEY is set (optional)
  // Environment read by SDK from LANGFUSE_TRACING_ENVIRONMENT env var
  const langfuse: Container["langfuse"] =
    env.LANGFUSE_SECRET_KEY && env.LANGFUSE_PUBLIC_KEY
      ? new LangfuseAdapter({
          publicKey: env.LANGFUSE_PUBLIC_KEY,
          secretKey: env.LANGFUSE_SECRET_KEY,
          ...(env.LANGFUSE_BASE_URL ? { baseUrl: env.LANGFUSE_BASE_URL } : {}),
        })
      : undefined;

  const clock = new SystemClock();

  // Scheduling adapters (from @cogni/db-client)
  // Per architecture rule: composition root injects loggers via child()

  // ScheduleControlPort: Temporal is required infrastructure
  // Per SCHEDULER_SPEC.md: TEMPORAL_ADDRESS + TEMPORAL_NAMESPACE must be configured
  if (!env.TEMPORAL_ADDRESS || !env.TEMPORAL_NAMESPACE) {
    throw new Error(
      "TEMPORAL_ADDRESS and TEMPORAL_NAMESPACE are required. " +
        "Start Temporal with: pnpm dev:infra"
    );
  }
  // Per QUEUE_PER_NODE_ISOLATION: Schedules submit to this node's per-node
  // queue. Existing schedules on the legacy queue keep firing until their
  // next update (drain Worker in scheduler-worker still polls the base name).
  const scheduleControl: ScheduleControlPort =
    new TemporalScheduleControlAdapter({
      address: env.TEMPORAL_ADDRESS,
      namespace: env.TEMPORAL_NAMESPACE,
      taskQueue: `${env.TEMPORAL_TASK_QUEUE}-${getNodeId()}`,
    });

  // Service DB (BYPASSRLS) for worker adapters
  const serviceDb = getServiceDb();
  const paymentAttemptServiceRepository =
    new ServiceDrizzlePaymentAttemptRepository(serviceDb);
  const workItemSessions = new DrizzleWorkItemSessionAdapter(serviceDb);

  // User-facing scheduling (appDb, RLS enforced)
  const executionGrantPort = new DrizzleExecutionGrantUserAdapter(
    db,
    log.child({ component: "DrizzleExecutionGrantUserAdapter" })
  );
  const scheduleManager = new DrizzleScheduleUserAdapter(
    db,
    scheduleControl,
    executionGrantPort,
    log.child({ component: "DrizzleScheduleUserAdapter" })
  );

  // Worker scheduling (serviceDb, BYPASSRLS)
  const executionGrantWorkerPort = new DrizzleExecutionGrantWorkerAdapter(
    serviceDb,
    log.child({ component: "DrizzleExecutionGrantWorkerAdapter" })
  );
  const graphRunRepository = new DrizzleGraphRunAdapter(
    serviceDb,
    log.child({ component: "DrizzleGraphRunAdapter" })
  );

  // Execution request port (not user-scoped — exempt from RLS)
  const executionRequestPort = new DrizzleExecutionRequestAdapter(
    db,
    log.child({ component: "DrizzleExecutionRequestAdapter" })
  );

  // MetricsCapability for AI tools (requires PROMETHEUS_URL)
  const metricsCapability = createMetricsCapability(env);

  // ComputeResourcePort balance reads (requires CHERRY_AUTH_TOKEN; empty stub otherwise)
  const computeCapability = createComputeCapability(env);

  // WebSearchCapability for AI tools (requires TAVILY_API_KEY)
  const webSearchCapability = createWebSearchCapability(env);

  // RepoCapability for AI tools (requires COGNI_REPO_PATH)
  const repoCapability = createRepoCapability(env);

  // WorkItemCapability for AI tools (delegates to markdown adapter ports)
  const workItemAdapter = new MarkdownWorkItemAdapter(
    env.COGNI_REPO_ROOT ?? "/nonexistent"
  );
  const workItemCapability = createWorkItemCapability({
    workItemQuery: workItemAdapter,
    workItemCommand: workItemAdapter,
  });

  // ScheduleCapability for AI tools (reads actorUserId from ALS at invocation time)
  const scheduleCapability = createScheduleCapability({
    scheduleManager,
    getOrCreateBillingAccountId: async (userId) => {
      const accountService = new UserDrizzleAccountService(
        db,
        userId,
        financialLedger
      );
      const account = await accountService.getOrCreateBillingAccountForUser({
        userId: userId as string,
      });
      return account.id;
    },
  });

  // VcsCapability for AI tools (requires GH_REVIEW_APP_ID)
  const vcsCapability = createVcsCapability(env);

  // DeployCapability (read-only SEE flow) — probe-backed v0; undefined when no base domain.
  const deployCapability = createDeployCapability(env);

  // KnowledgeCapability + EdoCapability for AI tools (require DOLTGRES_URL)
  let knowledgeCapability: KnowledgeCapability;
  let edoCapability: EdoCapability;
  let knowledgeContributionService: ContributionService | undefined;
  let knowledgeStorePort: KnowledgeStorePort | undefined;
  if (env.DOLTGRES_URL) {
    const doltClient = buildDoltgresClient({
      connectionString: env.DOLTGRES_URL,
      applicationName: `cogni_knowledge_${env.SERVICE_NAME ?? "app"}`,
    });
    const knowledgePort = new DoltgresKnowledgeStoreAdapter({
      sql: doltClient,
    });
    knowledgeStorePort = knowledgePort;
    knowledgeCapability = createKnowledgeCapability(knowledgePort);
    const edoResolver = new DoltgresEdoResolverAdapter({
      sql: doltClient,
      store: knowledgePort,
    });
    edoCapability = createEdoCapability(knowledgePort, edoResolver);
    const contributionPort = new DoltgresKnowledgeContributionAdapter({
      sql: doltClient,
    });
    const remoteUrl = resolveKnowledgeMirrorRemoteUrl(getKnowledgeConfig());
    const pushMainOnMerge = remoteUrl
      ? wrapPushSafe(
          createDoltgresPusher({
            sql: doltClient,
            remoteName: "origin",
            remoteUrl,
          }),
          {
            onSuccess: () => log.info({ remote: remoteUrl }, "dolthub_push_ok"),
            onFailure: (err) =>
              log.warn({ err, remote: remoteUrl }, "dolthub_push_failed"),
          }
        )
      : undefined;
    knowledgeContributionService = createContributionService({
      port: contributionPort,
      canMergeKnowledge: defaultCanMergeKnowledge,
      rateLimit: { maxOpenPerPrincipal: 10 },
      // v0 write-pipeline: shape gate only on the contribution path.
      // Provenance is stamped by the adapter (`source_type='external'`,
      // `source_ref='contribution:<id>:<seq>'`), so the provenance gate is
      // reserved for internal `core__knowledge_write` where the caller
      // controls those fields. See work/projects/proj.knowledge-syntropy.md.
      gates: [shapeGate],
      ...(pushMainOnMerge ? { pushMainOnMerge } : {}),
    });
    log.info(
      { dolthubMirror: Boolean(remoteUrl) },
      "Knowledge store + EDO capability configured (Doltgres)"
    );
  } else {
    const notConfigured = () => {
      throw new Error("KnowledgeCapability not configured. Set DOLTGRES_URL.");
    };
    knowledgeCapability = {
      search: notConfigured,
      list: notConfigured,
      get: notConfigured,
      write: notConfigured,
    };
    edoCapability = {
      hypothesize: notConfigured,
      decide: notConfigured,
      recordOutcome: notConfigured,
      getChain: notConfigured,
    };
    knowledgeContributionService = undefined;
    knowledgeStorePort = undefined;
    log.warn("Knowledge store not configured (DOLTGRES_URL not set)");
  }

  let doltgresWorkItems: WorkItemsDoltgresPort;
  try {
    doltgresWorkItems = getDoltgresWorkItemsAdapter();
  } catch (e) {
    if (!(e instanceof DoltgresNotConfiguredError)) throw e;
    const notConfigured = () => {
      throw new DoltgresNotConfiguredError();
    };
    doltgresWorkItems = {
      get: notConfigured,
      list: notConfigured,
      create: notConfigured,
      patch: notConfigured,
      delete: notConfigured,
    };
  }

  // ToolSource with real implementations (per CAPABILITY_INJECTION)
  const toolBindings = createToolBindings({
    knowledgeCapability,
    edoCapability,
    metricsCapability,
    webSearchCapability,
    repoCapability,
    scheduleCapability,
    vcsCapability,
    workItemCapability,
  });
  const operatorToolBundle = [...CORE_TOOL_BUNDLE, ...VCS_TOOL_BUNDLE];
  const toolSource = createBoundToolSource(operatorToolBundle, toolBindings);

  // Config: rethrow in dev/test for diagnosis, respond_500 in production for safety
  const config: ContainerConfig = {
    unhandledErrorPolicy: env.isProd ? "respond_500" : "rethrow",
    // Rate limit bypass: only enabled in test mode (APP_ENV=test)
    // Security: Production builds will never enable bypass regardless of header
    rateLimitBypass: {
      enabled: env.isTestMode,
      headerName: "x-stack-test",
      headerValue: "1",
    },
    // Deploy environment for metrics/logging
    DEPLOY_ENVIRONMENT: env.DEPLOY_ENVIRONMENT ?? "local",
  };

  // OperatorWallet: test uses fake, production uses Privy (optional — only when configured)
  const operatorWalletConfig = getOperatorWalletConfig();
  const operatorWallet: OperatorWalletPort | undefined = env.isTestMode
    ? getTestOperatorWallet()
    : (() => {
        if (
          !env.PRIVY_APP_ID ||
          !env.PRIVY_APP_SECRET ||
          !env.PRIVY_SIGNING_KEY
        ) {
          return undefined;
        }
        if (!operatorWalletConfig) {
          log.warn(
            "PRIVY_APP_ID set but operator_wallet missing from repo-spec — skipping operator wallet"
          );
          return undefined;
        }
        const treasuryAddress = getDaoTreasuryAddress();
        if (!treasuryAddress) {
          log.warn(
            "operator_wallet configured but governance.dao_contract missing — skipping operator wallet"
          );
          return undefined;
        }
        const paymentConfig = getPaymentConfig();
        if (!paymentConfig) {
          log.warn(
            "PRIVY_APP_ID set but payments_in missing from repo-spec — run `pnpm node:activate-payments`"
          );
          return undefined;
        }
        if (!env.EVM_RPC_URL) {
          log.warn(
            "PRIVY_APP_ID set but EVM_RPC_URL missing — operator wallet requires RPC for tx confirmation"
          );
          return undefined;
        }
        // Steward wallet is optional — when payments_out is absent the adapter
        // fails closed on withdrawToSteward but inbound/distribute still work.
        const stewardWalletConfig = getStewardWalletConfig();
        return new PrivyOperatorWalletAdapter({
          appId: env.PRIVY_APP_ID,
          appSecret: env.PRIVY_APP_SECRET,
          signingKey: env.PRIVY_SIGNING_KEY,
          expectedAddress: operatorWalletConfig.address,
          splitAddress: paymentConfig.receivingAddress,
          treasuryAddress,
          markupPpm: numberToPpm(paymentConfig.markupFactor),
          revenueSharePpm: numberToPpm(paymentConfig.revenueShare),
          maxTopUpUsd: env.OPERATOR_MAX_TOPUP_USD,
          rpcUrl: env.EVM_RPC_URL,
          ...(stewardWalletConfig
            ? { stewardAddress: stewardWalletConfig.address }
            : {}),
        });
      })();

  const paymentRailGuard: PaymentRailGuardPort = (() => {
    if (env.isTestMode) {
      return { assertReady: async () => undefined };
    }

    const paymentConfig = getPaymentConfig();
    if (!paymentConfig) {
      return {
        assertReady: async () => {
          throw new PaymentRailMisconfiguredPortError(
            "PAYMENT_RAIL_UNCONFIGURED",
            "Payment rails not activated. Run `pnpm node:activate-payments` first."
          );
        },
      };
    }

    if (!operatorWalletConfig) {
      return {
        assertReady: async () => {
          throw new PaymentRailMisconfiguredPortError(
            "PAYMENT_RAIL_UNCONFIGURED",
            "Payment rails misconfigured: operator_wallet missing from repo-spec"
          );
        },
      };
    }

    const treasuryAddress = getDaoTreasuryAddress();
    if (!treasuryAddress) {
      return {
        assertReady: async () => {
          throw new PaymentRailMisconfiguredPortError(
            "PAYMENT_RAIL_UNCONFIGURED",
            "Payment rails misconfigured: governance.dao_contract missing from repo-spec"
          );
        },
      };
    }

    return new SplitPaymentRailGuardAdapter(evmOnchainClient, {
      operatorAddress: operatorWalletConfig.address,
      treasuryAddress,
    });
  })();

  // ProviderFunding (OpenRouter/Coinbase top-up) was retired — OpenRouter 410'd
  // programmatic crypto top-up. Outbound vendor funding now flows through the
  // operator wallet's withdrawToSteward + a manual human checkout. The post-credit
  // chain here is now just inbound credit + Split distribute (treasurySettlement below).

  // Connection broker — BYO-AI credential resolution
  // Undefined when CONNECTIONS_ENCRYPTION_KEY not set
  const connectionBroker: ConnectionBrokerPort | undefined = (() => {
    if (!env.CONNECTIONS_ENCRYPTION_KEY) return undefined;
    const keyBuf = Buffer.from(env.CONNECTIONS_ENCRYPTION_KEY, "hex");
    if (keyBuf.length !== 32) {
      log.warn(
        "CONNECTIONS_ENCRYPTION_KEY must be 64 hex chars (32 bytes). BYO-AI disabled."
      );
      return undefined;
    }
    return new DrizzleConnectionBrokerAdapter({
      db: db as unknown as import("drizzle-orm/node-postgres").NodePgDatabase,
      encryptionKey: keyBuf,
      encryptionKeyId: "v1",
      log,
    });
  })();

  const authorization: AuthorizationPort | undefined =
    env.OPENFGA_API_URL && env.OPENFGA_STORE_ID
      ? new OpenFgaAuthorizationAdapter({
          apiUrl: env.OPENFGA_API_URL,
          storeId: env.OPENFGA_STORE_ID,
          ...(env.OPENFGA_API_TOKEN !== undefined
            ? { apiToken: env.OPENFGA_API_TOKEN }
            : {}),
          ...(env.OPENFGA_AUTHORIZATION_MODEL_ID !== undefined
            ? { authorizationModelId: env.OPENFGA_AUTHORIZATION_MODEL_ID }
            : {}),
        })
      : undefined;

  // Redis client for run event streaming (ephemeral stream plane)
  // Per REDIS_IS_STREAM_PLANE: only transient data, no durable state
  const redisClient = new Redis(env.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
  });
  const runStream = new RedisRunStreamAdapter(redisClient);
  const nodeStream = new RedisNodeStreamAdapter(redisClient);

  // Process health publisher (node-local metrics only — external sources use Temporal)
  const publisherAbort = new AbortController();
  process.on("SIGTERM", () => publisherAbort.abort());
  process.on("SIGINT", () => publisherAbort.abort());
  startProcessHealthPublisher({
    port: nodeStream,
    streamKey: `node:${nodeId}:events`,
    signal: publisherAbort.signal,
    logger: log,
    environment: env.DEPLOY_ENVIRONMENT ?? "local",
  });

  return {
    log,
    config,
    llmService,
    accountsForUser: (userId: UserId) =>
      new UserDrizzleAccountService(db, userId, financialLedger),
    serviceAccountService,
    clock,
    paymentAttemptsForUser: (userId: UserId) =>
      new UserDrizzlePaymentAttemptRepository(db, userId),
    paymentAttemptServiceRepository,
    onChainVerifier,
    evmOnchainClient,
    paymentRailsActive: !!getPaymentConfig(),
    paymentRailGuard,
    metricsQuery,
    treasuryReadPort,
    aiTelemetry,
    langfuse,
    nodeId,
    scheduleControl,
    executionGrantPort,
    executionGrantWorkerPort,
    executionRequestPort,
    graphRunRepository,
    scheduleManager,
    metricsCapability,
    computeCapability,
    webSearchCapability,
    repoCapability,
    vcsCapability,
    deployCapability,
    toolSource,
    knowledgeContributionService,
    knowledgeStorePort,
    edoCapability,
    threadPersistenceForUser: (userId: UserId) =>
      new DrizzleThreadPersistenceAdapter(db, userActor(userId)),
    governanceStatus: new DrizzleGovernanceStatusAdapter(
      db,
      userActor(toUserId(COGNI_SYSTEM_PRINCIPAL_USER_ID))
    ),
    attributionStore: new DrizzleAttributionAdapter(serviceDb, getScopeId()),
    workItemQuery: workItemAdapter,
    doltgresWorkItems,
    workItemSessions,
    runStream,
    nodeStream,
    get webhookRegistrations() {
      return getWebhookRegistrations();
    },
    financialLedger,
    operatorWallet,
    treasurySettlement: operatorWallet
      ? new SplitTreasurySettlementAdapter(operatorWallet, USDC_TOKEN_ADDRESS)
      : undefined,
    connectionBroker,
    authorization,
    // Multi-provider model ports
    ...(() => {
      const platformProvider = new PlatformModelProvider(llmService);
      // Parse MCP server config for Codex native MCP support (bug.0232).
      // parseMcpConfigFromEnv is synchronous (reads file + env vars).
      const codexMcpConfig = mcpServersToCodexConfig(parseMcpConfigFromEnv());
      const codexProvider = new CodexModelProvider(codexMcpConfig);
      const openAiCompatibleProvider = new OpenAiCompatibleModelProvider(
        connectionBroker,
        resolveAppDb
      );
      const providers = [
        platformProvider,
        codexProvider,
        openAiCompatibleProvider,
      ];
      return {
        modelCatalog: new AggregatingModelCatalog(providers),
        providerResolver: new ProviderResolver(providers),
      };
    })(),
  };
}

/**
 * Resolves dependencies for AI adapter construction.
 * Used by graph-executor.factory.ts.
 */
export function resolveAiAdapterDeps(userId: UserId): AiAdapterDeps {
  const container = getContainer();
  return {
    llmService: container.llmService,
    accountService: container.accountsForUser(userId),
    clock: container.clock,
    aiTelemetry: container.aiTelemetry,
    langfuse: container.langfuse,
    nodeId: container.nodeId,
  };
}

export function resolveActivityDeps(userId: UserId): ActivityDeps {
  const container = getContainer();
  return {
    accountService: container.accountsForUser(userId),
  };
}

/**
 * Scheduling dependencies for CRUD operations.
 * Used by schedule routes.
 */
export type SchedulingDeps = Pick<
  Container,
  | "scheduleControl"
  | "executionGrantPort"
  | "executionGrantWorkerPort"
  | "graphRunRepository"
  | "scheduleManager"
>;

export function resolveSchedulingDeps(): SchedulingDeps {
  const container = getContainer();
  return {
    scheduleControl: container.scheduleControl,
    executionGrantPort: container.executionGrantPort,
    executionGrantWorkerPort: container.executionGrantWorkerPort,
    graphRunRepository: container.graphRunRepository,
    scheduleManager: container.scheduleManager,
  };
}

/**
 * Resolve appDb for facade-level queries that don't need a full port abstraction.
 * Uses appDb (RLS-scoped) — caller must be authenticated.
 */
export function resolveAppDb(): Database {
  return getAppDb();
}

/**
 * Resolve serviceDb for pre-auth or system-level writes that must bypass RLS.
 */
export function resolveServiceDb(): Database {
  return getServiceDb();
}

/**
 * Module-singleton cached liveness+identity accessor for the public gallery. Built once (not per request)
 * so the short-TTL single-flight cache is shared across all homepage renders — concurrent/repeat
 * callers share one refresh and NEVER probe the network inline. `undefined` when no base domain is
 * configured, in which case the gallery skips the liveness+identity enrichment rather than blanking.
 */
let cachedLivenessAccessor:
  | ReturnType<typeof createLivenessAccessor>
  | undefined;
let livenessAccessorBuilt = false;

function getLivenessAccessor(): ReturnType<typeof createLivenessAccessor> {
  if (!livenessAccessorBuilt) {
    cachedLivenessAccessor = createLivenessAccessor(serverEnv());
    livenessAccessorBuilt = true;
  }
  return cachedLivenessAccessor;
}

/**
 * Resolve the public node registry: the SELF-DESCRIBED gallery. The candidate roster (operator's bundled
 * catalog nodes + the DB wizard projection, `status='active'`) is ENRICHED from a CACHED per-slug probe
 * that reads each node's liveness (`/readyz`) AND self-described identity (`/.well-known/agent.json`). So
 * the gallery shows the full roster, each card's title/tagline/thumbnail/color coming from the node's OWN
 * repo-spec projection (zero operator-side identity literals) plus an honest live/down health badge.
 * Service-role (non-RLS) DB read; both the DB adapter and the enrichment degrade gracefully so the
 * homepage never breaks on a transient infra blip.
 */
export function resolveNodeRegistry(): NodeRegistryPort {
  const domain = baseDomain(serverEnv());
  const log = makeLogger({ service: "cogni-template", nodeId: getNodeId() });
  const inner = new CompositeNodeRegistryAdapter([
    new StaticNodeRegistryAdapter(NETWORK_NODES, domain),
    new DbNodeRegistryAdapter({
      listListedNodes: async () => {
        try {
          const rows = await resolveServiceDb()
            .select({
              id: nodes.id,
              slug: nodes.slug,
              repoOwner: nodes.repoOwner,
              repoName: nodes.repoName,
              repoUrl: nodes.repoUrl,
            })
            .from(nodes)
            .where(eq(nodes.status, "active"));
          return rows;
        } catch (err) {
          // Don't let a projection-read failure blank the homepage silently.
          log.warn({ err }, "node_registry_projection_read_failed");
          return [];
        }
      },
      domain,
    }),
  ]);

  const getLiveness = getLivenessAccessor();
  if (!getLiveness) return inner; // No base domain ⇒ no liveness/identity enrichment (dev/local).

  return new LiveNodeRegistryAdapter({ inner, getLiveness });
}

/**
 * Statuses a node must be in to route git-attribution webhooks: a node dev's node is `published`
 * (repo-spec + catalog exist) well before it is promoted to `active`, and both should attribute
 * receipts from their declared repos. Narrower than the gallery's `active`-only projection.
 */
const ROUTABLE_NODE_STATUSES = ["published", "active"] as const;

/**
 * List every node eligible for git-attribution routing — service-role (non-RLS) read of `{id, slug}`
 * for nodes in `('published','active')`. Sibling to the gallery's `listListedNodes` (active-only);
 * kept separate because routing must include pre-activation `published` nodes.
 */
async function listRoutableNodes(): Promise<{ id: string; slug: string }[]> {
  return resolveServiceDb()
    .select({ id: nodes.id, slug: nodes.slug })
    .from(nodes)
    .where(inArray(nodes.status, [...ROUTABLE_NODE_STATUSES]));
}

/**
 * Module-singleton attribution-profile resolver. Built once so its short-TTL single-flight index
 * cache is shared across all concurrent webhook requests (never a per-request rebuild). Wires the
 * real deploy plane (App-reads `infra/catalog/<slug>.yaml` + each node's repo-spec) to the pure
 * `buildRepoIndex`; the deployment parent monorepo comes from the env-scoped submodule-parent vars.
 */
let cachedAttributionProfileResolver: AttributionProfileResolver | undefined;

export function resolveAttributionProfileResolver(): AttributionProfileResolver {
  if (cachedAttributionProfileResolver) return cachedAttributionProfileResolver;
  const env = serverEnv();
  const plane = createOperatorDeployPlane(env);
  // The env-scoped deployment parent (Cogni-DAO/cogni in prod; cogni-test-org/cogni-monorepo in test).
  const parentOwner = env.NODE_SUBMODULE_PARENT_OWNER ?? "";
  const parentRepo = env.NODE_SUBMODULE_PARENT_REPO ?? "";

  cachedAttributionProfileResolver = createAttributionProfileResolver({
    listRoutableNodes,
    resolveNodeRepo: (slug) =>
      plane.resolveNodeRepo({ parentOwner, parentRepo, slug }),
    // In-repo node → `nodes/<slug>/.cogni/repo-spec.yaml` under the parent monorepo;
    // fork → `.cogni/repo-spec.yaml` at the fork root. Mirrors prepareNodeRefCandidateFlight.
    fetchRepoSpecText: ({ owner, repo, isInRepo, slug }) =>
      plane.fetchFileText({
        owner,
        repo,
        path: isInRepo
          ? `nodes/${slug}/.cogni/repo-spec.yaml`
          : ".cogni/repo-spec.yaml",
        ref: "main",
      }),
    parentOwner,
    parentRepo,
  });
  return cachedAttributionProfileResolver;
}
