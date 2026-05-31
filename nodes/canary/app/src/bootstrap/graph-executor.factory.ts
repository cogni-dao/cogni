// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/graph-executor.factory`
 * Purpose: Factory for creating GraphExecutorPort implementations with observability and billing.
 * Scope: Bridges app layer (facades) to adapters layer via bootstrap. Does NOT contain business logic.
 * Invariants:
 *   - Facade NEVER imports adapters directly (use this factory)
 *   - Per UNIFIED_GRAPH_EXECUTOR: all graph execution flows through GraphExecutorPort
 *   - Per ROUTING_BY_NAMESPACE_ONLY: NamespaceGraphRouter routes by graphId prefix via Map
 *   - Per LANGFUSE_INTEGRATION: ObservabilityGraphExecutorDecorator wraps for Langfuse traces
 *   - Per CALLBACK_WRITES_PLATFORM_RECEIPTS: UsageCommitDecorator validates usage_report events. Platform receipts via LiteLLM callback; BYO receipts committed directly.
 *   - Per CREDITS_ENFORCED_AT_EXECUTION_PORT: PreflightCreditCheckDecorator rejects runs with insufficient credits
 *   - LAZY_SANDBOX_IMPORT: Sandbox provider loaded via dynamic import() to defer dockerode native addon chain (SandboxRunnerAdapter)
 *   - MCP_NOT_SINGLETON: MCP connections use McpConnectionCache with reconnect-on-error + TTL backstop
 *   - MCP_RECONNECT_ON_ERROR: ErrorDetectingMcpToolSource invalidates cache on transport-level connection errors
 * Side-effects: global (module-scoped McpConnectionCache, cached sandbox provider promise)
 * Links: container.ts, NamespaceGraphRouter, GRAPH_EXECUTION.md, OBSERVABILITY.md, mcp-control-plane.md
 * @public
 */

import type { SourceSystem, ToolSourcePort } from "@cogni/ai-core";
import { CORE_TOOL_BUNDLE } from "@cogni/ai-tools";
import type {
  ExecutionContext,
  GraphFinal,
  GraphRunRequest,
  GraphRunResult,
} from "@cogni/graph-execution-core";
import {
  BillingEnrichmentGraphExecutorDecorator,
  type CommitUsageFactFn,
  NamespaceGraphRouter,
  ObservabilityGraphExecutorDecorator,
  PreflightCreditCheckDecorator,
  UsageCommitDecorator,
} from "@cogni/graph-execution-host";
import type { UserId } from "@cogni/ids";
import {
  LANGGRAPH_CATALOG,
  loadMcpTools,
  McpToolSource,
  parseMcpConfigFromEnv,
} from "@cogni/langgraph-graphs";
import { trace } from "@opentelemetry/api";
import {
  type CompletionStreamFn,
  createLangGraphDevClient,
  InProcCompletionUnitAdapter,
  LangGraphDevProvider,
  LangGraphInProcProvider,
} from "@/adapters/server";
import { runInScope } from "@/adapters/server/ai/execution-scope";
import type {
  AiExecutionErrorCode,
  BillingContext,
  ConnectionBrokerPort,
  GraphExecutorPort,
  LlmService,
  ModelProviderResolverPort,
  PreflightCreditCheckFn,
} from "@/ports";
import { serverEnv } from "@/shared/env";
import { makeLogger } from "@/shared/observability";
import {
  type AiAdapterDeps,
  getContainer,
  resolveAiAdapterDeps,
} from "./container";

/**
 * Factory for creating NamespaceGraphRouter with all configured providers.
 * Per UNIFIED_GRAPH_EXECUTOR: all graph execution flows through GraphExecutorPort.
 * Per ROUTING_BY_NAMESPACE_ONLY: NamespaceGraphRouter routes by graphId namespace via Map.
 * Per CATALOG_SINGLE_SOURCE_OF_TRUTH: Provider imports catalog from @cogni/langgraph-graphs.
 * Per MUTUAL_EXCLUSION: Register exactly one langgraph provider (InProc XOR Dev) based on env.
 *
 * Architecture boundary: Facade calls this factory (app → bootstrap),
 * factory creates router (bootstrap → adapters). Facade never imports adapters.
 *
 * Static inner executor:
 *   NamespaceGraphRouter
 *
 * @param completionStreamFn - Feature function for LLM streaming (from features/ai)
 * @param userId - User ID for adapter dependency resolution
 * @returns GraphExecutorPort implementation with routing only
 */
export function createGraphExecutor(
  completionStreamFn: CompletionStreamFn,
  userId: UserId
): GraphExecutorPort {
  const deps = resolveAiAdapterDeps(userId);

  // Per MUTUAL_EXCLUSION: choose provider based on LANGGRAPH_DEV_URL env
  const devUrl = serverEnv().LANGGRAPH_DEV_URL;
  const langGraphProvider = devUrl
    ? createDevProvider(devUrl)
    : createInProcProvider(deps, completionStreamFn);

  // Build namespace → provider map
  const env = serverEnv();
  // Both LangGraphInProcProvider and LangGraphDevProvider expose providerId
  const providerId = (langGraphProvider as LangGraphInProcProvider).providerId;
  const providers = new Map<string, GraphExecutorPort>([
    [providerId, langGraphProvider],
    [
      "sandbox",
      new LazySandboxGraphProvider(
        env.LITELLM_MASTER_KEY,
        env.OPENCLAW_GATEWAY_URL,
        env.OPENCLAW_GATEWAY_TOKEN
      ),
    ],
  ]);

  // Create namespace router with all configured providers
  const router = new NamespaceGraphRouter(
    providers,
    makeLogger({ component: "NamespaceGraphRouter" })
  );

  return router;
}

/**
 * Compose a per-run scoped executor.
 *
 * Bootstrap owns per-run wrapper composition so launchers do not construct ad hoc
 * scoped executors in facades or routes.
 *
 * Provider resolution happens here: the ModelProviderResolverPort resolves the
 * LlmService from req.modelRef BEFORE execution starts. No more llmServiceOverride
 * via AsyncLocalStorage — the resolved LlmService is set on the execution scope.
 */
export function createScopedGraphExecutor(params: {
  readonly executor: GraphExecutorPort;
  readonly billing: BillingContext;
  readonly preflightCheckFn: PreflightCreditCheckFn;
  readonly commitByoUsage: CommitUsageFactFn;
  readonly abortSignal?: AbortSignal;
  readonly broker?: ConnectionBrokerPort;
  readonly resolver: ModelProviderResolverPort;
  readonly actorId: string;
}): GraphExecutorPort {
  const container = getContainer();

  const enriched = new BillingEnrichmentGraphExecutorDecorator(
    params.executor,
    params.billing
  );

  // Validate usage_report events; commit BYO receipts directly, defer platform to callback.
  const billed = new UsageCommitDecorator(
    enriched,
    container.log,
    params.commitByoUsage
  );

  // Wrap with preflight credit check — uses provider resolver for billing policy
  const preflighted = new PreflightCreditCheckDecorator(
    billed,
    params.preflightCheckFn as import("@cogni/graph-execution-host").PreflightCreditCheckFn,
    params.billing.billingAccountId,
    params.resolver,
    container.log
  );

  // Wrap with observability decorator for Langfuse traces (outermost)
  const observed = new ObservabilityGraphExecutorDecorator(
    preflighted,
    container.langfuse,
    {
      finalizationTimeoutMs: 15_000,
      getTraceId: () =>
        trace.getActiveSpan()?.spanContext().traceId ??
        "00000000000000000000000000000000",
    },
    container.log,
    params.billing.billingAccountId
  );

  return {
    runGraph(req: GraphRunRequest, ctx?: ExecutionContext): GraphRunResult {
      // Resolve LlmService from provider BEFORE execution
      const provider = params.resolver.resolve(req.modelRef.providerKey);

      // Fail fast: connection-required providers must have connectionId + broker
      if (provider.requiresConnection) {
        if (!req.modelRef.connectionId) {
          throw new Error(
            `Provider "${req.modelRef.providerKey}" requires a connection but modelRef.connectionId is missing. ` +
              `Ensure the model picker sends connectionId and the status endpoint returns it.`
          );
        }
        if (!params.broker) {
          throw new Error(
            `Provider "${req.modelRef.providerKey}" requires a connection but ConnectionBroker is not configured. ` +
              `Set CONNECTIONS_ENCRYPTION_KEY to enable BYO-AI.`
          );
        }
      }

      if (
        provider.requiresConnection &&
        req.modelRef.connectionId &&
        params.broker
      ) {
        // BYO path: resolve credentials async, then run graph with provider's LlmService.
        const broker = params.broker;
        const connectionId = req.modelRef.connectionId;
        let innerResult: GraphRunResult | undefined;
        let resolveOuterFinal: ((v: GraphFinal) => void) | undefined;
        const outerFinal = new Promise<GraphFinal>((r) => {
          resolveOuterFinal = r;
        });

        const stream = (async function* () {
          let llmService: LlmService;
          try {
            const connection = await broker.resolve(connectionId, {
              actorId: params.actorId,
              tenantId: params.billing.billingAccountId,
            });
            llmService = provider.createLlmService(connection);
          } catch (err) {
            container.log.error(
              {
                connectionId,
                error: err instanceof Error ? err.message : String(err),
              },
              "Connection resolution failed"
            );
            yield {
              type: "error" as const,
              error:
                "internal" as import("@cogni/ai-core").AiExecutionErrorCode,
            };
            yield { type: "done" as const };
            // biome-ignore lint/style/noNonNullAssertion: assigned synchronously in Promise constructor
            resolveOuterFinal!({
              ok: false,
              runId: req.runId,
              requestId: ctx?.requestId ?? req.runId,
              error:
                "internal" as import("@cogni/ai-core").AiExecutionErrorCode,
            });
            return;
          }

          innerResult = runGraphWithScope({
            executor: observed,
            req,
            ...(ctx ? { ctx } : {}),
            billing: params.billing,
            llmService,
            usageSource: provider.usageSource,
            ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
          });

          yield* innerResult.stream;
          const f = await innerResult.final;
          // biome-ignore lint/style/noNonNullAssertion: assigned synchronously in Promise constructor
          resolveOuterFinal!(f);
        })();

        return { stream, final: outerFinal };
      }

      // Standard path: use provider's LlmService (no connection needed)
      const llmService = provider.createLlmService();
      return runGraphWithScope({
        executor: observed,
        req,
        ...(ctx ? { ctx } : {}),
        billing: params.billing,
        llmService,
        usageSource: provider.usageSource,
        ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
      });
    },
  };
}

/**
 * Run a graph within an execution scope.
 *
 * This is the ONLY app-local launch entrypoint. Every launcher (chat, schedule,
 * webhook, review) calls this — never executor.runGraph() directly.
 *
 * Sets AsyncLocalStorage scope so static inner providers can read billing context
 * and the resolved LlmService.
 */
export function runGraphWithScope(params: {
  readonly executor: GraphExecutorPort;
  readonly req: GraphRunRequest;
  readonly ctx?: ExecutionContext;
  readonly billing: BillingContext;
  readonly llmService: LlmService;
  readonly usageSource: SourceSystem;
  readonly abortSignal?: AbortSignal;
}): GraphRunResult {
  const { executor, req, ctx, billing, llmService, usageSource } = params;
  return runInScope(
    {
      billing,
      llmService,
      usageSource,
      ...(ctx?.actorUserId ? { actorUserId: ctx.actorUserId } : {}),
      ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
    },
    () => executor.runGraph(req, ctx)
  );
}

// ---------------------------------------------------------------------------
// MCP connection cache — shared connection with reconnect-on-error + TTL backstop
// ---------------------------------------------------------------------------

const mcpLog = makeLogger({ component: "mcp-bootstrap" });

/**
 * Shared MCP connection cache with reconnect-on-error (correctness) and
 * TTL backstop (cleanup insurance for silent session expiry).
 *
 * This is the MVP seam — not the final control plane. Phase 1 replaces
 * `parseMcpConfigFromEnv()` with DB registry reads. The `getSource()` interface
 * stays the same. See docs/spec/mcp-control-plane.md.
 *
 * Invariants:
 *   - MCP_NOT_SINGLETON: Connections have bounded lifetime, not forever cache
 *   - MCP_RECONNECT_ON_ERROR: Connection errors invalidate cache; next call reconnects
 *   - GRACEFUL_DEGRADATION: Failed connections → null → agents work without MCP tools
 */
class McpConnectionCache {
  private state: {
    source: ToolSourcePort;
    close: () => Promise<void>;
    createdAt: number;
  } | null = null;
  private connecting: Promise<ToolSourcePort | null> | null = null;

  constructor(private readonly ttlMs: number = 5 * 60 * 1000) {}

  /**
   * Get MCP tool source, reconnecting if stale or on first access.
   * Cache hit returns immediately. Cache miss or TTL expiry triggers reconnect.
   * Concurrent callers coalesce on a single reconnect attempt.
   */
  async getSource(): Promise<ToolSourcePort | null> {
    // Fast path: cached and within TTL
    if (this.state && Date.now() - this.state.createdAt < this.ttlMs) {
      return this.state.source;
    }
    // Coalesce concurrent reconnect attempts
    if (!this.connecting) {
      this.connecting = this.connect().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  /**
   * Invalidate cached connection. Called on connection errors during tool exec.
   * Next `getSource()` call will reconnect.
   */
  invalidate(): void {
    if (this.state) {
      const { close } = this.state;
      this.state = null;
      // Fire-and-forget close of dead connection
      close().catch((err) =>
        mcpLog.warn({ err }, "Error closing stale MCP connection")
      );
    }
  }

  /** Graceful shutdown. Call on SIGTERM/SIGINT. */
  async close(): Promise<void> {
    if (this.state) {
      mcpLog.info("Closing MCP server connections");
      try {
        await this.state.close();
      } catch (err) {
        mcpLog.error({ err }, "Error closing MCP connections");
      }
      this.state = null;
    }
  }

  private async connect(): Promise<ToolSourcePort | null> {
    // Close previous connection if any
    this.invalidate();

    const config = parseMcpConfigFromEnv();
    const serverNames = Object.keys(config);
    if (serverNames.length === 0) {
      mcpLog.warn(
        "No MCP servers configured — agents with mcpServerIds will have no tools"
      );
      return null;
    }

    mcpLog.info({ servers: serverNames }, "Connecting to MCP servers");
    try {
      const result = await loadMcpTools(config);
      const innerSource = new McpToolSource(result.tools);

      // Wrap with error detection — connection errors trigger cache invalidation
      const source = new ErrorDetectingMcpToolSource(innerSource, () =>
        this.invalidate()
      );

      this.state = {
        source,
        close: () => result.close(),
        createdAt: Date.now(),
      };
      mcpLog.info(
        {
          toolCount: result.tools.length,
          toolNames: result.tools.map((t) => t.name),
        },
        "MCP tools connected"
      );
      return source;
    } catch (err) {
      mcpLog.error({ err }, "Failed to connect MCP tools; continuing without");
      return null;
    }
  }
}

/**
 * ToolSourcePort wrapper that detects connection errors during tool exec
 * and triggers cache invalidation for reconnect-on-error.
 *
 * The error is still thrown (toolRunner handles it) — but the cache is
 * invalidated so the next request gets a fresh connection.
 */
class ErrorDetectingMcpToolSource implements ToolSourcePort {
  constructor(
    private readonly delegate: McpToolSource,
    private readonly onConnectionError: () => void
  ) {}

  getBoundTool(
    toolId: string
  ): import("@cogni/ai-core").BoundToolRuntime | undefined {
    const bound = this.delegate.getBoundTool(toolId);
    if (!bound) return undefined;

    const onErr = this.onConnectionError;
    return {
      ...bound,
      async exec(
        args: unknown,
        ctx: import("@cogni/ai-core").ToolInvocationContext,
        caps: import("@cogni/ai-core").ToolCapabilities
      ): Promise<unknown> {
        try {
          return await bound.exec(args, ctx, caps);
        } catch (err) {
          if (isConnectionError(err)) {
            mcpLog.warn(
              { toolId, err },
              "MCP connection error — invalidating cache for reconnect"
            );
            onErr();
          }
          throw err;
        }
      },
    };
  }

  listToolSpecs(): readonly import("@cogni/ai-core").ToolSpec[] {
    return this.delegate.listToolSpecs();
  }

  hasToolId(toolId: string): boolean {
    return this.delegate.hasToolId(toolId);
  }
}

/** Detect transport-level connection errors (not application errors from MCP tools). */
function isConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = err.message.toLowerCase();
  return (
    m.includes("econnrefused") ||
    m.includes("econnreset") ||
    m.includes("socket hang up") ||
    m.includes("fetch failed") ||
    m.includes("network error") ||
    m.includes("session not found")
  );
}

/** Module-scoped MCP cache instance */
let _mcpCache: McpConnectionCache | null = null;

function getMcpCache(): McpConnectionCache {
  if (!_mcpCache) {
    _mcpCache = new McpConnectionCache();
  }
  return _mcpCache;
}

/**
 * Close all MCP server connections. Call on process shutdown.
 * With HTTP transport, this disconnects the client (no subprocess cleanup needed).
 */
export async function closeMcpConnections(): Promise<void> {
  if (_mcpCache) {
    await _mcpCache.close();
    _mcpCache = null;
  }
}

/**
 * Create InProc provider for in-process graph execution.
 * Per CAPABILITY_INJECTION: toolSource contains real implementations with I/O.
 * MCP tools resolved via shared cache with reconnect-on-error.
 */
function createInProcProvider(
  deps: AiAdapterDeps,
  completionStreamFn: CompletionStreamFn
): GraphExecutorPort {
  const container = getContainer();
  const inprocAdapter = new InProcCompletionUnitAdapter(
    deps,
    completionStreamFn
  );

  const cache = getMcpCache();
  return new LangGraphInProcProvider(
    inprocAdapter,
    container.toolSource,
    () => cache.getSource(),
    [...CORE_TOOL_BUNDLE]
  );
}

/**
 * Create Dev provider for langgraph dev server execution.
 * Per MVP_DEV_ONLY: connects to langgraph dev (port 2024).
 */
function createDevProvider(apiUrl: string): LangGraphDevProvider {
  const client = createLangGraphDevClient({ apiUrl });
  const availableGraphs = Object.keys(LANGGRAPH_CATALOG);
  return new LangGraphDevProvider(client, { availableGraphs });
}

// ---------------------------------------------------------------------------
// Lazy sandbox provider — defers dockerode import to first runGraph() call
// ---------------------------------------------------------------------------

/** Module-scoped singleton: caches the dynamic import + provider construction */
let _sandboxProvider: Promise<GraphExecutorPort> | null = null;

function loadSandboxProvider(
  litellmMasterKey: string,
  gatewayUrl: string,
  gatewayToken: string
): Promise<GraphExecutorPort> {
  if (!_sandboxProvider) {
    _sandboxProvider = import("@/adapters/server/sandbox").then(
      ({
        SandboxRunnerAdapter,
        SandboxGraphProvider,
        OpenClawGatewayClient,
      }) => {
        const runner = new SandboxRunnerAdapter({ litellmMasterKey });

        // Gateway client for OpenClaw gateway mode
        // Billing: handled by LiteLLM generic_api callback (NO_ZERO_RECEIPTS_FOR_PAID_MODELS)
        const gatewayClient = new OpenClawGatewayClient(
          gatewayUrl,
          gatewayToken
        );

        return new SandboxGraphProvider(
          runner,
          gatewayClient
        ) as GraphExecutorPort;
      }
    );
  }
  return _sandboxProvider;
}

/**
 * GraphExecutorPort that lazy-loads SandboxGraphProvider on first use.
 *
 * Avoids top-level import of dockerode → ssh2 → cpu-features (native addon)
 * which breaks Turbopack bundling when the barrel re-exports it.
 *
 * Per LAZY_SANDBOX_IMPORT: runGraph() returns {stream, final} synchronously;
 * the async generator inside awaits the cached import before delegating.
 */
class LazySandboxGraphProvider implements GraphExecutorPort {
  private readonly delegate: Promise<GraphExecutorPort>;

  constructor(
    litellmMasterKey: string,
    gatewayUrl: string,
    gatewayToken: string
  ) {
    this.delegate = loadSandboxProvider(
      litellmMasterKey,
      gatewayUrl,
      gatewayToken
    );
  }

  runGraph(req: GraphRunRequest, ctx?: ExecutionContext): GraphRunResult {
    const delegate = this.delegate;

    // Shared promise: resolves to delegate's runGraph result once module loads
    const innerResult = delegate.then((p) => p.runGraph(req, ctx));

    const stream = (async function* () {
      let inner: GraphRunResult;
      try {
        inner = await innerResult;
      } catch {
        yield {
          type: "error" as const,
          error: "internal" as AiExecutionErrorCode,
        };
        yield { type: "done" as const };
        return;
      }
      yield* inner.stream;
    })();

    const final = innerResult.then(
      (r) => r.final,
      () =>
        ({
          ok: false,
          runId: req.runId,
          requestId: ctx?.requestId ?? req.runId,
          error: "internal",
        }) as const
    );

    return { stream, final };
  }
}
