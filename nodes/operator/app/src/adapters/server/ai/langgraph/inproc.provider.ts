// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/ai/langgraph/inproc.provider`
 * Purpose: LangGraph in-process graph provider for Next.js runtime.
 * Scope: Routes graph execution to package runner. Does NOT import @langchain/* directly — all LangChain in package.
 * Invariants:
 *   - NO_LANGCHAIN_IN_SRC: No @langchain imports; delegates to package runner
 *   - GRAPH_ID_NAMESPACED: graphId format is "langgraph:${graphName}"
 *   - CATALOG_SINGLE_SOURCE_OF_TRUTH: Uses catalog from @cogni/langgraph-graphs
 *   - NODE_BUNDLE_IS_CANONICAL: Resolves BoundTool from injected node bundle (CORE_TOOL_BUNDLE [+ POLY_TOOL_BUNDLE for poly]); never iterates the global TOOL_CATALOG (which is per-package and can drift behind per-node bundles).
 *   - DENY_BY_DEFAULT: Tool policy explicitly provided per graph
 *   - MCP_VIA_ASYNC_SOURCE: MCP tools resolved via async getMcpToolSource() function (shared cache with reconnect-on-error)
 *   - TOOL_AUTHZ_CONTEXT_ALWAYS_THREADED (authz v0): actor/tenant/graph/node/grant reach the tool runner with or
 *     without an authz adapter, plus one `ai.tool_authz.decision` log per evaluated call; `authz` only when installed.
 *   - CATALOG_REPORT_SEAM: a catalog entry's `report` (not a graph name) decides whether the run's structured
 *     telemetry is logged as registered events and echoed onto the stream; graphs never touch the logger or ALS.
 *   - LINKED_NODE_RUN_IS_CODE_TOOLS_ONLY (story.0038): when the run's host-validated `codeSubject` names a
 *     node other than this one, the host reads that node's grounding through its X-issued key (never a
 *     tool), the model's tool list is the two code tools only (knowledge and work-item tools would read
 *     THIS node's hub, not X's), and the tool authz check runs on the reviewed node.
 * Side-effects: IO (executes graphs via package runner, MCP tool resolution via HTTP)
 * Notes: Discovery is in LangGraphInProcAgentCatalogProvider, not here.
 * Links: GRAPH_EXECUTION.md, LANGGRAPH_AI.md
 * @internal
 */

import type { AiEvent, BoundToolRuntime, ToolSourcePort } from "@cogni/ai-core";
import {
  createStaticToolSourceFromRecord,
  createToolAllowlistPolicy,
  createToolRunner,
} from "@cogni/ai-core";
import {
  type CatalogBoundTool,
  NODE_CODE_LIST_NAME,
  NODE_CODE_READ_NAME,
} from "@cogni/ai-tools";
import type { AuthorizationPort } from "@cogni/authorization-core";
import {
  type CompletionFn,
  type CreateGraphFn,
  createInProcGraphRunner,
  GRAPH_REPORT_CLOSE,
  GRAPH_REPORT_OPEN,
  type GraphResult,
  type InProcGraphRequest,
  type ToolExecFn,
} from "@cogni/langgraph-graphs";
import { LANGGRAPH_CATALOG } from "@cogni/operator-graphs";
import { trace } from "@opentelemetry/api";
import type { Logger } from "pino";
import { getExecutionScope } from "@/adapters/server/ai/execution-scope";
import type {
  AiExecutionErrorCode,
  CompletionFinalResult,
  ExecutionContext,
  GraphExecutorPort,
  GraphFinal,
  GraphRunRequest,
  GraphRunResult,
  LinkedNodeSource,
  LinkedNodeSourceReader,
  LlmToolDefinition,
  Message,
} from "@/ports";
import { EVENT_NAMES, makeLogger } from "@/shared/observability";

import type { CompletionUnitParams } from "../inproc-completion-unit.adapter";

import type { LangGraphCatalog } from "./catalog";

/** Tools a linked-node run keeps: the two code tools only (story.0038). */
const LINKED_NODE_TOOL_IDS: ReadonlySet<string> = new Set([
  NODE_CODE_LIST_NAME,
  NODE_CODE_READ_NAME,
]);

/**
 * Provider ID for LangGraph in-process execution.
 */
export const LANGGRAPH_PROVIDER_ID = "langgraph" as const;

/**
 * Adapter interface for executing completion units.
 * Matches InProcCompletionUnitAdapter.executeCompletionUnit signature.
 */
export interface CompletionUnitAdapter {
  executeCompletionUnit(params: CompletionUnitParams): {
    stream: AsyncIterable<AiEvent>;
    final: Promise<CompletionFinalResult>;
  };
}

/**
 * Catalog entry shape (matches LangGraphCatalogEntry<CreateGraphFn>).
 * Per NODE_BUNDLE_IS_CANONICAL: tools referenced by ID, resolved from the injected node bundle.
 */
interface ProviderCatalogEntry {
  readonly program?: "cogni" | "work-review";
  readonly displayName: string;
  readonly description: string;
  readonly toolIds: readonly string[];
  readonly mcpServerIds?: readonly string[];
  readonly graphFactory: CreateGraphFn;
  readonly systemPrompt?: string;
  /** Graph-owned run report to log + echo on the stream (CatalogEntry.report). */
  readonly report?: GraphReportDecl;
  /** HOST_OWNED_ARCHITECT (task.5455): host injects the node's `*-architect` entry body. */
  readonly hostArchitect?: true;
}

/** Governing-index row fields architect selection needs. */
type ArchitectIndexRow = { readonly id: string };

/**
 * HOST_OWNED_ARCHITECT: pick the reviewed node's architect entry from the governing index.
 * Exactly one id ending in `-architect` wins; with several, `${nodeSlug}-architect` wins when a
 * slug is known; otherwise none (never guess between nodes).
 */
export function selectArchitectEntryId(
  index: ReadonlyArray<ArchitectIndexRow>,
  nodeSlug?: string
): string | null {
  const ids = index.map((r) => r.id).filter((id) => id.endsWith("-architect"));
  if (ids.length === 1) return ids[0] ?? null;
  if (ids.length > 1 && nodeSlug) {
    const want = `${nodeSlug}-architect`;
    return ids.includes(want) ? want : null;
  }
  return null;
}

/** Host-owned reader of one knowledge entry's full body (null when absent). */
export interface ArchitectBodyReader {
  /** Node slug used to break a tie between several `*-architect` entries. */
  readonly nodeSlug?: string;
  readonly read: (id: string) => Promise<string | null>;
}

/** CatalogEntry.report: the registered event name for the graph's telemetry. */
interface GraphReportDecl {
  readonly event: string;
}

/**
 * LangGraph in-process provider.
 *
 * Routes graph execution to package runner (createInProcGraphRunner).
 * All LangChain logic is in the package — this provider is LangChain-free.
 *
 * Per GRAPH_LLM_VIA_COMPLETION: all LLM calls go through adapter.executeCompletionUnit
 * for billing/telemetry centralization.
 *
 * Note: Discovery (listAgents) is in LangGraphInProcAgentCatalogProvider.
 */
export class LangGraphInProcProvider implements GraphExecutorPort {
  readonly providerId = LANGGRAPH_PROVIDER_ID;
  private readonly log: Logger;
  private readonly catalog: LangGraphCatalog<CreateGraphFn>;
  private readonly boundToolMap: ReadonlyMap<string, CatalogBoundTool>;

  constructor(
    private readonly adapter: CompletionUnitAdapter,
    private readonly toolSource: ToolSourcePort,
    private readonly getMcpToolSource: () => Promise<ToolSourcePort | null> = () =>
      Promise.resolve(null),
    nodeBundle: readonly CatalogBoundTool[] = [],
    private readonly authorization?: AuthorizationPort,
    private readonly nodeId?: string,
    private readonly nodeOrigin?: string,
    private readonly nodeMission?: {
      readonly content: string;
      readonly sourceRef: string;
      readonly buildSha: string | null;
    },
    /**
     * Host-owned governing-index reader (same `listGoverningIndex` the cognition bundle uses).
     * Read per run so a reviewed hub change is seen without an app rebuild; metadata only.
     */
    private readonly governingIndexReader?: () => Promise<
      ReadonlyArray<{
        readonly id: string;
        readonly domain: string;
        readonly entryType: string;
        readonly useWhen: string;
      }>
    >,
    /** Host-owned architect body reader; used only for catalog entries with `hostArchitect`. */
    private readonly architectReader?: ArchitectBodyReader,
    /** Host-owned reader of a linked node's grounding (story.0038); absent → linked runs fail closed. */
    private readonly linkedNodeSourceReader?: LinkedNodeSourceReader
  ) {
    this.log = makeLogger({
      component: "LangGraphInProcProvider",
      ...(nodeId ? { nodeId } : {}),
    });
    this.boundToolMap = new Map(nodeBundle.map((bt) => [bt.contract.name, bt]));

    // Use node graph package catalog (single source of truth for this runtime)
    this.catalog = LANGGRAPH_CATALOG as LangGraphCatalog<CreateGraphFn>;

    this.log.debug(
      {
        graphCount: Object.keys(this.catalog).length,
        graphs: Object.keys(this.catalog),
      },
      "LangGraphInProcProvider initialized"
    );
  }

  runGraph(req: GraphRunRequest, ctx?: ExecutionContext): GraphRunResult {
    const { runId, messages, modelRef, graphId } = req;
    const model = modelRef.modelId;
    const scope = getExecutionScope();
    const requestId = ctx?.requestId ?? req.runId;

    // Extract graph name from graphId (e.g., "langgraph:poet" → "poet")
    const graphName = this.extractGraphName(graphId);
    if (!graphName) {
      this.log.error({ runId, graphId }, "Invalid graphId format");
      // Client error: malformed graphId
      return this.createErrorResult(runId, requestId, "invalid_request");
    }

    const entry = this.catalog[graphName] as ProviderCatalogEntry | undefined;
    if (!entry) {
      this.log.error({ runId, graphName }, "Graph not found in catalog");
      // Client error: graph doesn't exist
      return this.createErrorResult(runId, requestId, "not_found");
    }

    this.log.debug(
      { runId, graphName, model, messageCount: messages.length },
      "LangGraphInProcProvider.runGraph routing to package runner"
    );

    // Create completion function wrapping adapter
    const completionFn = this.createCompletionFn(req);

    // LINKED_NODE_RUN_IS_CODE_TOOLS_ONLY: the reviewed node differs from this one.
    const linkedSubject =
      scope.codeSubject !== undefined &&
      this.nodeId !== undefined &&
      scope.codeSubject.nodeId !== this.nodeId
        ? scope.codeSubject
        : undefined;
    const onlyCodeTools = (ids: readonly string[]): readonly string[] =>
      linkedSubject ? ids.filter((id) => LINKED_NODE_TOOL_IDS.has(id)) : ids;

    // P0 Contract: undefined => catalog default, [] => deny-all, [...] => exact
    const catalogToolIds = entry.toolIds;
    const toolIds: readonly string[] = onlyCodeTools(
      req.toolIds ?? catalogToolIds
    );
    if (req.toolIds === undefined) {
      this.log.debug(
        { runId, graphName, catalogToolIds },
        "toolIds undefined; using catalog default per P0 contract"
      );
    }

    const authzNodeId = scope.codeSubject?.nodeId ?? scope.nodeId;

    // Resolve BoundToolRuntime from injected toolSource (per TOOL_SOURCE_RETURNS_BOUND_TOOL)
    // Per CAPABILITY_INJECTION: toolSource contains real implementations with I/O
    const runtimeTools: Record<string, BoundToolRuntime> = {};
    for (const toolId of catalogToolIds) {
      const runtime = this.toolSource.getBoundTool(toolId);
      if (runtime) {
        runtimeTools[toolId] = runtime;
      } else {
        this.log.error(
          { runId, graphName, toolId },
          "Tool not found in toolSource; graph misconfigured"
        );
      }
    }

    // Resolve MCP tools if this graph declares mcpServerIds.
    // getMcpToolSource() is async (shared cache with reconnect-on-error),
    // so we wrap the graph execution in a promise and stream from it.
    const mcpServerIds = entry.mcpServerIds ?? [];

    // Async helper: resolve MCP tools then execute graph
    const resolveMcpAndExecute = async (): Promise<{
      stream: AsyncIterable<AiEvent>;
      final: Promise<GraphResult>;
    }> => {
      const mcpToolIds: string[] = [];
      if (mcpServerIds.length > 0) {
        const mcpToolSource = await this.getMcpToolSource();
        if (mcpToolSource) {
          for (const serverId of mcpServerIds) {
            for (const spec of mcpToolSource.listToolSpecs()) {
              if (spec.name.startsWith(`${serverId}__`)) {
                const runtime = mcpToolSource.getBoundTool(spec.name);
                if (runtime) {
                  runtimeTools[spec.name] = runtime;
                  mcpToolIds.push(spec.name);
                }
              }
            }
          }
          if (mcpToolIds.length > 0) {
            this.log.debug(
              {
                runId,
                graphName,
                mcpServerIds,
                mcpToolCount: mcpToolIds.length,
              },
              "Resolved MCP tools for graph"
            );
          }
        }
      }

      // Combined tool IDs for allowlist: native catalog tools + MCP tools
      const allToolIds = [...toolIds, ...mcpToolIds];

      // Get catalog tools for contract extraction from the injected node bundle
      // (per NODE_BUNDLE_IS_CANONICAL — TOOL_CATALOG only has core tools post-bug.0319 ckpt 2)
      const catalogTools = onlyCodeTools(catalogToolIds)
        .map((id) => this.boundToolMap.get(id))
        .filter((bt): bt is NonNullable<typeof bt> => bt !== undefined);

      // Create tool execution function factory
      // Policy allowlist includes both native and MCP tool IDs
      const createToolExecFn = (emit: (e: AiEvent) => void): ToolExecFn => {
        const policy = createToolAllowlistPolicy(allToolIds);
        const source = createStaticToolSourceFromRecord(runtimeTools);
        const actorId =
          scope.actorUserId !== undefined
            ? `user:${scope.actorUserId}`
            : undefined;
        const tenantId = scope.billing.billingAccountId;
        const toolRunner = createToolRunner(source, emit, {
          policy,
          ctx: { runId },
          // authz v0: trusted identity + audit flow regardless of adapter presence — declared
          // node policies are evaluated with or without OpenFGA; `authz` only when installed.
          // Undeclared tools keep the legacy path (authz-checked only when an adapter exists).
          ...(actorId !== undefined ? { actorId } : {}),
          tenantId,
          graphId,
          // authz runs on the REVIEWED node: a developer of X holds node.flight on X (story.0038).
          ...(authzNodeId !== undefined ? { nodeId: authzNodeId } : {}),
          ...(scope.grantId !== undefined ? { grantId: scope.grantId } : {}),
          onAuthzDecision: (record) => {
            const fields = {
              event: EVENT_NAMES.AI_TOOL_AUTHZ_DECISION,
              runId,
              graphName,
              tool: record.toolName,
              toolCallId: record.toolCallId,
              decision: record.decision,
              code: record.code,
              policy: record.policy,
              ...(record.reason !== undefined && {
                reason: record.reason.slice(0, 200),
              }),
              actorId: record.actorId,
              nodeId: record.nodeId,
              graphId: record.graphId,
              grantId: record.grantId,
            };
            if (record.decision === "allow") {
              this.log.info(fields, "tool authz decision");
            } else {
              this.log.warn(fields, "tool authz decision");
            }
          },
          ...(this.authorization !== undefined
            ? { authz: this.authorization }
            : {}),
        });

        return async (name, args, toolCallId) => {
          const result =
            toolCallId !== undefined
              ? await toolRunner.exec(name, args, {
                  modelToolCallId: toolCallId,
                })
              : await toolRunner.exec(name, args);
          if (!result.ok) {
            this.log.warn(
              {
                event: EVENT_NAMES.AI_TOOL_CALL_ERROR,
                runId,
                graphName,
                tool: name,
                errorCode: result.errorCode,
                safeMessage: result.safeMessage.slice(0, 300),
              },
              "tool call failed"
            );
          }
          return result;
        };
      };

      const toolContracts = catalogTools.map((bt) => bt.contract);

      const mcpToolSpecs = mcpToolIds
        .map((id) => runtimeTools[id]?.spec)
        .filter((s): s is NonNullable<typeof s> => s !== undefined);

      const traceId =
        trace.getActiveSpan()?.spanContext().traceId ??
        "00000000000000000000000000000000";
      const runnerRequest: InProcGraphRequest = {
        runId,
        messages: messages as InProcGraphRequest["messages"],
        ...(scope.abortSignal !== undefined && {
          abortSignal: scope.abortSignal,
        }),
        ...(traceId !== undefined && { traceId }),
        ...(requestId !== undefined && { ingressRequestId: requestId }),
        configurable: {
          model,
          toolIds,
          ...(scope.actorUserId !== undefined
            ? { actorId: `user:${scope.actorUserId}` }
            : {}),
          tenantId: scope.billing.billingAccountId,
          graphId,
          // Scheduled-run signal for graphs (absent for API/chat runs).
          ...(scope.grantId !== undefined ? { grantId: scope.grantId } : {}),
        },
      };

      // LINKED_NODE_RUN: node X's grounding, read by the host through X's key. A failure rejects this
      // async setup, so the run ends with an internal error and the review reports "could not evaluate".
      let linked: LinkedNodeSource | undefined;
      if (linkedSubject) {
        if (!this.linkedNodeSourceReader) {
          throw new Error("linked_node_source_unavailable");
        }
        linked = await this.linkedNodeSourceReader(linkedSubject);
      }

      // Host-owned governing index, read per run (best-effort) so a reviewed hub change is
      // seen without a rebuild. Held in the agent's context; the agent reads bodies on demand.
      const governingIndex = linked
        ? linked.governingIndex
        : this.governingIndexReader
          ? await this.governingIndexReader().catch((error) => {
              this.log.warn(
                { err: error },
                "governing index read failed; proceeding without it"
              );
              return [];
            })
          : [];
      // HOST_OWNED_ARCHITECT (task.5455): opt-in graphs get the node's architect body from the
      // host, so grounding does not depend on the model choosing to read it. Best-effort: any
      // failure omits it (one structured warn) and the review proceeds without.
      let architect:
        | { id: string; content: string; sourceRef: string }
        | undefined;
      if (!linked && entry.hostArchitect === true && this.architectReader) {
        const architectId = selectArchitectEntryId(
          governingIndex,
          this.architectReader.nodeSlug
        );
        let reason: string | undefined;
        let readError: unknown;
        if (!architectId) {
          reason = "no_unique_architect_entry";
        } else {
          try {
            const content = await this.architectReader.read(architectId);
            if (content?.trim()) {
              architect = {
                id: architectId,
                content,
                sourceRef: `hub:${architectId}`,
              };
            } else {
              reason = "empty_body";
            }
          } catch (error) {
            reason = "read_failed";
            readError = error;
          }
        }
        if (reason) {
          this.log.warn(
            {
              runId,
              graphName,
              reason,
              ...(architectId ? { architectId } : {}),
              ...(readError ? { err: readError } : {}),
            },
            "host architect not injected; proceeding without it"
          );
        }
      }
      const runner = createInProcGraphRunner({
        createGraph: entry.graphFactory,
        ...(linked && linkedSubject
          ? {
              sourceContext: {
                nodeId: linkedSubject.nodeId,
                origin: linked.origin,
                mission: linked.mission,
                ...(linked.governingIndex.length
                  ? { governingIndex: linked.governingIndex }
                  : {}),
                ...(linked.architect ? { architect: linked.architect } : {}),
                ...(linked.rules.length ? { rules: linked.rules } : {}),
              },
            }
          : this.nodeId && this.nodeOrigin
            ? {
                sourceContext: {
                  nodeId: this.nodeId,
                  origin: this.nodeOrigin,
                  ...(this.nodeMission ? { mission: this.nodeMission } : {}),
                  ...(governingIndex.length ? { governingIndex } : {}),
                  ...(architect ? { architect } : {}),
                },
              }
            : {}),
        ...(entry.program !== undefined && { program: entry.program }),
        completionFn,
        createToolExecFn,
        toolContracts,
        ...(mcpToolSpecs.length > 0 && { mcpToolSpecs }),
        request: runnerRequest,
        ...(req.responseFormat !== undefined && {
          responseFormat: req.responseFormat,
        }),
        ...(entry.systemPrompt !== undefined && {
          systemPrompt: entry.systemPrompt,
        }),
      });
      // CatalogEntry.report: the graph's own report → registry events (graphs have no logger).
      const report = entry.report;
      if (report) {
        void runner.final
          .then((result) => {
            for (const fields of graphReportLogFields(
              report,
              runId,
              result.structuredOutput
            )) {
              this.log.info(fields, "graph report");
            }
          })
          .catch(() => {
            // Run failure is already logged by the inproc error path.
          });
      }
      return runner;
    };

    // Execute: resolve MCP (if needed) then run graph.
    // Returns {stream, final} synchronously per GraphRunResult contract;
    // the inner async generator awaits the promise.
    const innerResult = resolveMcpAndExecute();
    const report = entry.report;

    const stream = (async function* () {
      let inner: Awaited<ReturnType<typeof resolveMcpAndExecute>>;
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
      for await (const event of inner.stream) {
        // CatalogEntry.report: echo the telemetry as one text delta just before `done`.
        if (event.type === "done" && report && !entry.program) {
          const delta = graphReportDelta((await inner.final).structuredOutput);
          if (delta) yield { type: "text_delta" as const, delta };
        }
        yield event;
      }
    })();

    const final = innerResult.then(
      (r) => this.mapToGraphFinal(r.final, runId, requestId, graphName),
      () =>
        ({
          ok: false as const,
          runId,
          requestId,
          error: "internal",
        }) as const
    );

    // mapToGraphFinal returns Promise<GraphFinal>, so final is Promise<Promise<GraphFinal> | GraphFinal>
    // Flatten with .then()
    const flatFinal = final.then((f) => f);

    return { stream, final: flatFinal };
  }

  /**
   * Extract graph name from namespaced graphId.
   * Per GRAPH_ID_NAMESPACED: "langgraph:poet" → "poet"
   */
  private extractGraphName(graphId: string): string | undefined {
    const prefix = `${this.providerId}:`;
    if (graphId.startsWith(prefix)) {
      return graphId.slice(prefix.length);
    }

    return undefined;
  }

  /**
   * Create completion function wrapping adapter.executeCompletionUnit.
   */
  private createCompletionFn(
    req: GraphRunRequest
  ): CompletionFn<LlmToolDefinition> {
    const { runId, graphId } = req;
    const attempt = 0; // P0_ATTEMPT_FREEZE

    return (params: {
      messages: Message[];
      model: string;
      tools?: readonly LlmToolDefinition[];
      toolChoice?: import("@/ports").LlmToolChoice;
      abortSignal?: AbortSignal;
    }) => {
      const result = this.adapter.executeCompletionUnit({
        messages: params.messages as GraphRunRequest["messages"],
        model: params.model,
        runContext: { runId, attempt, graphId },
        ...(params.abortSignal && { abortSignal: params.abortSignal }),
        ...(params.tools?.length && { tools: [...params.tools] }),
        ...(params.toolChoice && { toolChoice: params.toolChoice }),
      });

      return {
        stream: result.stream,
        final: result.final.then((r) => {
          if (!r.ok) return { ok: false as const, error: r.error };
          return {
            ok: true as const,
            content: r.content ?? "",
            ...(r.toolCalls && { toolCalls: r.toolCalls }),
            ...(r.usage && { usage: r.usage }),
            ...(r.finishReason && { finishReason: r.finishReason }),
          };
        }),
      };
    };
  }

  /**
   * Map package GraphResult to port GraphFinal.
   * GraphResult.error is now AiExecutionErrorCode - direct passthrough.
   * Logs errors at adapter boundary for debugging.
   */
  private async mapToGraphFinal(
    final: Promise<GraphResult>,
    runId: string,
    requestId: string,
    graphName: string
  ): Promise<GraphFinal> {
    const result = await final;

    if (!result.ok) {
      // Log error at adapter boundary (per OBSERVABILITY.md: adapter ERROR log)
      this.log.error(
        {
          runId,
          reqId: requestId,
          graphName,
          errorCode: result.error ?? "internal",
          errorMessage: result.errorMessage,
          event: EVENT_NAMES.ADAPTER_LANGGRAPH_INPROC_ERROR,
        },
        EVENT_NAMES.ADAPTER_LANGGRAPH_INPROC_ERROR
      );

      // Direct passthrough - GraphResult.error is already AiExecutionErrorCode
      return { ok: false, runId, requestId, error: result.error ?? "internal" };
    }

    // Conditional spreads for exactOptionalPropertyTypes
    return {
      ok: true,
      runId,
      requestId,
      finishReason: "stop",
      ...(result.usage !== undefined && { usage: result.usage }),
      ...(result.content !== undefined && { content: result.content }),
      ...(result.structuredOutput !== undefined && {
        structuredOutput: result.structuredOutput,
      }),
    };
  }

  /**
   * Create error result for invalid requests.
   * Per ERROR_NORMALIZATION: details logged, stream gets code only.
   */
  private createErrorResult(
    runId: string,
    requestId: string,
    code: AiExecutionErrorCode = "internal"
  ): GraphRunResult {
    const errorStream = (async function* () {
      yield { type: "error" as const, error: code };
      yield { type: "done" as const };
    })();

    return {
      stream: errorStream,
      final: Promise.resolve({
        ok: false as const,
        runId,
        requestId,
        error: code,
      }),
    };
  }
}

/**
 * Log lines for a catalog-declared report: one `report.event` from `structuredOutput.telemetry`. Empty when
 * the output carries none.
 */
export function graphReportLogFields(
  report: GraphReportDecl,
  runId: string,
  structuredOutput: Record<string, unknown> | undefined
): Record<string, unknown>[] {
  const telemetry = structuredOutput?.telemetry;
  return telemetry && typeof telemetry === "object"
    ? [{ event: report.event, runId, ...telemetry }]
    : [];
}

/** The stream echo of a catalog-declared report (`<graph_report>{telemetry}</graph_report>`), or null. */
export function graphReportDelta(
  structuredOutput: Record<string, unknown> | undefined
): string | null {
  const telemetry = structuredOutput?.telemetry;
  return telemetry && typeof telemetry === "object"
    ? `\n${GRAPH_REPORT_OPEN}${JSON.stringify(telemetry)}${GRAPH_REPORT_CLOSE}\n`
    : null;
}
