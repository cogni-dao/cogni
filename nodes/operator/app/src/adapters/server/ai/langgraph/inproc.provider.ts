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
 *   - SUBJECT_IS_THE_REVIEWED_NODE (task.5448): when the run's host-validated `codeSubject` is ANOTHER node, the
 *     preamble sources (index, architect, mission, origin) come only from that node through the injected
 *     `SubjectGroundingLoader`; there is no operator-hub fallback. A grounding failure fails the run BEFORE any
 *     model call with its typed code. `work_item_read` leaves the tool ids and the allowlist, and the tool runner
 *     checks node authority on the SUBJECT node while `scope.nodeId` stays the operator. With no subject, or the
 *     operator itself as subject, behavior is exactly the local path.
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
  isAiExecutionError,
} from "@cogni/ai-core";
import { type CatalogBoundTool, WORK_ITEM_READ_NAME } from "@cogni/ai-tools";
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
import { CORE_TOOL_BUNDLE as RELEASED_TOOLS } from "@cogni/shared-ai-tools";
import { actingPrincipal } from "@cogni/work-items";
import {
  type GuardDeps,
  guardTools,
  offeredToolIds,
  ToolAuthorityError,
  type ToolRequires,
} from "@cogni-dao/agent-grants";
import { trace } from "@opentelemetry/api";
import type { Logger } from "pino";
import {
  type ExecutionCodeSubject,
  getExecutionScope,
  runInScope,
} from "@/adapters/server/ai/execution-scope";
import type {
  AiExecutionErrorCode,
  CompletionFinalResult,
  ExecutionContext,
  GraphExecutorPort,
  GraphFinal,
  GraphRunRequest,
  GraphRunResult,
  LlmToolDefinition,
  Message,
} from "@/ports";
import { EVENT_NAMES, makeLogger } from "@/shared/observability";

import type { CompletionUnitParams } from "../inproc-completion-unit.adapter";

import type { LangGraphCatalog } from "./catalog";

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

/**
 * The host-owned grounding of a review whose subject is ANOTHER node (task.5448): that node's index, its
 * architect entry (id taken from the index), its origin, and its mission with provenance from its repo-spec at
 * the base SHA. The loader throws on a failed read; an `AiExecutionError` carries the typed code.
 */
export interface SubjectGrounding {
  readonly nodeId: string;
  readonly origin: string;
  readonly mission: {
    readonly content: string;
    readonly sourceRef: string;
    readonly buildSha: string | null;
  };
  readonly governingIndex: ReadonlyArray<{
    readonly id: string;
    readonly domain: string;
    readonly entryType: string;
    readonly useWhen: string;
  }>;
  readonly architect?: {
    readonly id: string;
    readonly content: string;
    readonly sourceRef: string;
  };
}

export type SubjectGroundingLoader = (
  subject: ExecutionCodeSubject
) => Promise<SubjectGrounding>;

/**
 * The error code of a failure while setting a run up (MCP resolution, subject grounding): the typed code of an
 * `AiExecutionError` (a failed read of another node's hub is `remote_*`), `internal` for anything else.
 */
function setupFailureCode(error: unknown): AiExecutionErrorCode {
  return isAiExecutionError(error) ? error.code : "internal";
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
    /** Grounding of a review whose code subject is ANOTHER node (task.5448); absent = such a run fails closed. */
    private readonly subjectGroundingLoader?: SubjectGroundingLoader,
    private readonly writerAuthority?: GuardDeps
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

    // SUBJECT_IS_THE_REVIEWED_NODE (task.5448): a run whose host-validated subject is ANOTHER node. The
    // operator's work items are not that node's, so `work_item_read` leaves the tool ids and the allowlist.
    // Fail closed: without this node's own id a subject is never assumed to be self.
    const otherSubject =
      scope.codeSubject !== undefined &&
      (this.nodeId === undefined || scope.codeSubject.nodeId !== this.nodeId)
        ? scope.codeSubject
        : undefined;
    const forSubject = (ids: readonly string[]): readonly string[] =>
      otherSubject ? ids.filter((id) => id !== WORK_ITEM_READ_NAME) : ids;

    // P0 Contract: undefined => catalog default, [] => deny-all, [...] => exact
    const catalogToolIds = forSubject(entry.toolIds);
    const toolIds: readonly string[] = forSubject(
      req.toolIds ?? catalogToolIds
    );
    if (req.toolIds === undefined) {
      this.log.debug(
        { runId, graphName, catalogToolIds },
        "toolIds undefined; using catalog default per P0 contract"
      );
    }

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
    const deniedRun = new AbortController();
    let terminalDenial: ToolAuthorityError["receipt"] | undefined;
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

      // The migrated writers use published principal/subject locks in addition to the
      // operator's existing tool-runner policies. No seeds, grants or admin rights are created here.
      const writerIds = new Set([
        "core__work_item_update",
        "core__edo_decide",
        "core__edo_hypothesize",
        "core__edo_record_outcome",
      ]);
      const requiresById: Record<string, ToolRequires> = {};
      for (const tool of RELEASED_TOOLS) {
        if (writerIds.has(tool.contract.name) && tool.contract.requires) {
          requiresById[tool.contract.name] = tool.contract.requires;
        }
      }
      const writers: Record<string, BoundToolRuntime> = {};
      for (const [id, runtime] of Object.entries(runtimeTools)) {
        if (!writerIds.has(id)) continue;
        writers[id] = {
          ...runtime,
          exec: (args, ctx, capabilities) => {
            const current = getExecutionScope();
            return runtime.exec(
              args,
              {
                ...ctx,
                actorId: `agent:${actingPrincipal(current)}`,
                ...(current.subjectUserId
                  ? { subjectId: `user:${current.subjectUserId}` }
                  : {}),
              },
              capabilities
            );
          },
        };
      }
      const authority: GuardDeps = this.writerAuthority ?? {
        withStore: async () => {
          throw new Error("writer authority unavailable");
        },
        adminCheck: async () => "unavailable",
      };
      const guardScope = {
        principalId: scope.principalId,
        subjectUserId: scope.subjectUserId,
        accountId: scope.billing.billingAccountId,
        payer: scope.billing.billingAccountId,
        runId,
      };
      Object.assign(
        runtimeTools,
        guardTools(writers, requiresById, guardScope, {
          ...authority,
          runAs: (identity, fn) => runInScope({ ...scope, ...identity }, fn),
          onTerminalDenial: (denial) => {
            terminalDenial = new ToolAuthorityError(
              denial.code,
              denial.tool,
              requiresById[denial.tool]?.scope ?? null
            ).receipt;
            deniedRun.abort();
          },
        })
      );
      const offered = await offeredToolIds(
        Object.values(writers),
        requiresById,
        guardScope,
        authority
      );
      const permitted = (id: string) =>
        !writerIds.has(id) || offered.offered.includes(id);
      const offeredIds = toolIds.filter(permitted);
      const allToolIds = [...offeredIds, ...mcpToolIds];

      // Get catalog tools for contract extraction from the injected node bundle
      // (per NODE_BUNDLE_IS_CANONICAL — TOOL_CATALOG only has core tools post-bug.0319 ckpt 2)
      const catalogTools = catalogToolIds
        .filter(permitted)
        .map((id) => this.boundToolMap.get(id))
        .filter((bt): bt is NonNullable<typeof bt> => bt !== undefined);

      // Create tool execution function factory
      // Policy allowlist includes both native and MCP tool IDs
      const createToolExecFn = (emit: (e: AiEvent) => void): ToolExecFn => {
        const policy = createToolAllowlistPolicy(allToolIds);
        const source = createStaticToolSourceFromRecord(runtimeTools);
        const actorId =
          scope.principalId !== undefined
            ? `agent:${scope.principalId}`
            : undefined;
        const tenantId = scope.billing.billingAccountId;
        // Authority is checked on the REVIEWED node (`node_code_*` needs `node.flight` there); `scope.nodeId`
        // stays the operator everywhere else (task.5448).
        const authzNodeId = otherSubject?.nodeId ?? scope.nodeId;
        const toolRunner = createToolRunner(source, emit, {
          policy,
          ctx: { runId },
          // authz v0: trusted identity + audit flow regardless of adapter presence — declared
          // node policies are evaluated with or without OpenFGA; `authz` only when installed.
          // Undeclared tools keep the legacy path (authz-checked only when an adapter exists).
          ...(actorId !== undefined ? { actorId } : {}),
          ...(scope.subjectUserId !== undefined
            ? { subjectId: `user:${scope.subjectUserId}` }
            : {}),
          tenantId,
          graphId,
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
              principalId: scope.principalId,
              subjectUserId: scope.subjectUserId,
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
        abortSignal: scope.abortSignal
          ? AbortSignal.any([scope.abortSignal, deniedRun.signal])
          : deniedRun.signal,
        ...(traceId !== undefined && { traceId }),
        ...(requestId !== undefined && { ingressRequestId: requestId }),
        configurable: {
          model,
          toolIds: offeredIds,
          ...(scope.principalId !== undefined
            ? { actorId: `agent:${scope.principalId}` }
            : {}),
          tenantId: scope.billing.billingAccountId,
          graphId,
          // Scheduled-run signal for graphs (absent for API/chat runs).
          ...(scope.grantId !== undefined ? { grantId: scope.grantId } : {}),
        },
      };

      // SUBJECT_IS_THE_REVIEWED_NODE (task.5448): a review of ANOTHER node takes its whole preamble from
      // that node, before any model call. A failed read throws here (never `.catch(() => [])`), so the run
      // fails with the typed code. Without a loader the run fails closed: no operator fallback.
      let subjectGrounding: SubjectGrounding | undefined;
      if (otherSubject) {
        if (!this.subjectGroundingLoader)
          throw new Error("subject_grounding_unavailable");
        try {
          subjectGrounding = await this.subjectGroundingLoader(otherSubject);
        } catch (error) {
          this.log.warn(
            {
              runId,
              graphName,
              errorCode: setupFailureCode(error),
            },
            "subject grounding failed; run fails before any model call"
          );
          throw error;
        }
      }

      // Host-owned governing index, read per run (best-effort) so a reviewed hub change is
      // seen without a rebuild. Held in the agent's context; the agent reads bodies on demand.
      const governingIndex = subjectGrounding
        ? subjectGrounding.governingIndex
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
        | undefined = subjectGrounding?.architect;
      if (
        !subjectGrounding &&
        entry.hostArchitect === true &&
        this.architectReader
      ) {
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
        ...(subjectGrounding
          ? {
              sourceContext: {
                nodeId: subjectGrounding.nodeId,
                origin: subjectGrounding.origin,
                mission: subjectGrounding.mission,
                ...(governingIndex.length ? { governingIndex } : {}),
                ...(architect ? { architect } : {}),
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
      } catch (error) {
        yield {
          type: "error" as const,
          error: setupFailureCode(error),
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
        if (terminalDenial && event.type === "error") continue;
        if (terminalDenial && event.type === "done") {
          yield {
            type: "text_delta" as const,
            delta: "Tool execution stopped by its authority check.",
          };
        }
        yield event;
      }
    })();

    const final = innerResult.then(
      async (r) => {
        const result = await r.final;
        if (terminalDenial)
          return {
            ok: true,
            runId,
            requestId,
            finishReason: "stop" as const,
            content: "Tool execution stopped by its authority check.",
            structuredOutput: terminalDenial,
            ...(result.usage ? { usage: result.usage } : {}),
          };
        return this.mapToGraphFinal(
          Promise.resolve(result),
          runId,
          requestId,
          graphName
        );
      },
      (error) =>
        ({
          ok: false as const,
          runId,
          requestId,
          error: setupFailureCode(error),
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
      maxTokens?: number;
    }) => {
      const result = this.adapter.executeCompletionUnit({
        messages: params.messages as GraphRunRequest["messages"],
        model: params.model,
        runContext: { runId, attempt, graphId },
        ...(params.abortSignal && { abortSignal: params.abortSignal }),
        ...(params.tools?.length && { tools: [...params.tools] }),
        ...(params.toolChoice && { toolChoice: params.toolChoice }),
        ...(params.maxTokens !== undefined && { maxTokens: params.maxTokens }),
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
