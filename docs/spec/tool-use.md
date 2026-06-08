---
id: spec.tool-use
type: spec
title: Tool Use Specification
status: draft
spec_state: draft
trust: draft
summary: Canonical tool semantics, policy enforcement, wire adapters, capability injection, and execution pipeline invariants
read_when: Adding tools, modifying tool execution pipeline, implementing wire adapters, or changing policy enforcement
implements: []
owner: cogni-dev
created: 2026-02-02
verified: 2026-06-08
tags:
  - ai-graphs
  - tooling
---

# Tool Use Specification

## Context

Tools execute via `toolRunner.exec()` only. Route maps AiEvents to `assistant-stream` format via `controller.addToolCallPart()`. The tool system uses canonical semantic types (`ToolSpec`, `ToolInvocationRecord`) independent of wire formats, with policy enforcement at both catalog construction and runtime execution.

## Goal

Define the tool execution invariants, semantic types, wire format adapters, policy enforcement rules, capability injection patterns, and execution pipeline that govern all tool usage across all executors (InProc, LangGraph dev, server).

## Non-Goals

- MCP gateway integration (future — see [proj.tool-use-evolution](../../work/projects/proj.tool-use-evolution.md) P2)
- Graph-as-Tool subagents (future — see initiative P3)
- Multi-tool parallel execution (future — see initiative PX)

## Core Invariants

1. **TOOLS_VIA_TOOLRUNNER**: All tool execution flows through `toolRunner.exec()` for ALL executors (InProc, langgraph dev, server). LangChain tool wrappers (`@cogni/langgraph-graphs`) must delegate to `toolRunner.exec()` to preserve validation/redaction pipeline. No direct tool implementation calls. No executor-specific bypass paths. **Documented deviation:** Codex SDK (`CodexLlmAdapter`) calls MCP tools directly via its own agent loop (config.toml). Mitigated by: server-level scoping, $0 billing (user-funded), output stays in agent loop. See `INVARIANT_DEVIATION: TOOLS_VIA_TOOLRUNNER` in `codex-llm.adapter.ts`.

2. **TOOLS_IN_PACKAGES**: Cross-node `core__` tool contracts + implementations live in `@cogni/ai-tools` (operator domain — shared by all nodes). Node-scoped tool contracts + implementations live in that node's `@cogni/<node>-ai-tools` package at `nodes/<node>/packages/ai-tools/` (poly today via `@cogni/poly-ai-tools`; resy/node-template create their own when the first node-only tool ships). Semantic types (`ToolSpec`, `ToolInvocationRecord`) in `@cogni/ai-core/tooling/`. Wire adapters (OpenAI/Anthropic encoders/decoders) in adapters layer. LangChain wrappers in `@cogni/langgraph-graphs/runtime`. Binding in composition roots only. No tool definitions in `src/**`.

3. **TOOLS_IO_VIA_CAPABILITIES**: Tools receive IO capabilities as injected interfaces (defined in packages). No direct adapter/env imports in tool code. Capabilities are bound to adapters in composition roots.

4. **REDACTION_REQUIRED**: Every tool must define deterministic redaction for UI/telemetry outputs. Allowlist is the required mechanism—output fields not in allowlist are stripped. Missing redaction config = error event, not silent pass-through.

5. **TOOLCALLID_STABLE**: Same ID across start→result. Model-provided or UUID at boundary.

6. **LANGGRAPH_OWNS_GRAPHS**: Agentic loops via `@cogni/langgraph-graphs`. No `@langchain/*` imports in `src/**`. See [langgraph-patterns.md](./langgraph-patterns.md).

7. **STREAM_VIA_ASSISTANT_STREAM**: Use `assistant-stream` package only. No custom SSE.

8. **DECODER_ASSEMBLES_TOOLCALLS**: For non-LangGraph streaming executors, wire decoders (e.g., `OpenAIToolDecoder`) are the single assemblers of streamed tool deltas into `ToolInvocationRecord`. `litellm.adapter.ts` delegates to the decoder; it does not implement assembly logic itself. Assembly state is scoped to a single decode session and reset between calls. Graph executes tools only from decoded records, never from raw deltas. _(P0 uses LangGraph's internal assembly; explicit decoders are P1.)_

9. **BINDING_IN_COMPOSITION_ROOT**: Tool binding (connecting contracts to ports/deps) occurs only in composition roots: `nodes/<node>/app/src/bootstrap/**` (per-node Next.js apps) or `packages/langgraph-graphs/src/runtime/{core,cogni}/` (shared runtime helpers). Features and packages never instantiate bound tools.

10. **TOOL_SEMANTICS_CANONICAL**: The canonical tool types are semantic, not wire-format-specific:
    - `ToolSpec { name, description, inputSchema: JSONSchema7, redaction, effect }` — tool definition (compiled schema, no Zod runtime)
    - `ToolEffect = 'read_only' | 'state_change' | 'external_side_effect'` — side-effect level for policy
    - `ToolInvocationRecord { toolCallId, name, args, result, error, startedAt, endedAt, raw?: unknown }` — execution record
      `inputSchema` uses `JSONSchema7` type for compatibility; P1 enforces a restricted subset (disallows `oneOf`/`anyOf`/`allOf`/`not`/`if-then-else`/`patternProperties`/complex `$ref`) via `validateToolSchemaP0()` tests.
      `raw` preserves provider-native payload for observability only; must be redacted/omitted from UI/logs, and must never influence execution or billing.
      These live in `@cogni/ai-core/tooling/`. Zod stays in `@cogni/ai-tools`; compile to JSONSchema7 before passing to core.

11. **WIRE_FORMATS_ARE_ADAPTERS**: Wire DTOs (OpenAI function-calling, Anthropic tool_use/tool_result) are adapter concerns, not core types. Encoders convert `ToolSpec` → provider wire format. Decoders convert provider responses → `ToolInvocationRecord` + tool AiEvents. This enables Anthropic richness (attachments, content blocks) without core rewrites.

12. **OPENAI_WIRE_V1_SUPPORTED**: OpenAI function-calling format is the P0 wire protocol (via LiteLLM). For non-LangGraph streaming executors, `OpenAIToolEncoder(ToolSpec)` produces `tools[]` and `OpenAIToolDecoder(stream)` assembles deltas into `ToolInvocationRecord`. Anthropic wire support is P1. _(P0 uses LangGraph's internal wire handling; explicit encoder/decoder are P1.)_

13. **JSON_SCHEMA7_PARAMETERS**: Tool definition `parameters` field uses `JSONSchema7` type. Tool input schemas must compile deterministically from Zod → JSON Schema for wire emission via `zod-to-json-schema`. P1 adds runtime validation rejecting unsupported constructs (see #10).

14. **NO_MANUAL_SCHEMA_DUPLICATION**: No hand-written JSON Schema objects alongside Zod schemas. The `parameters` field in wire DTOs must be derived from the contract's Zod schema via `getToolJsonSchema(contract)`. Manual duplication causes drift.

15. **GOLDEN_FIXTURES_ENFORCE_WIRE_FORMAT**: For non-LangGraph streaming executors, golden fixture tests enforce wire conformance per adapter: exact key sets (no extra keys), required fields for tool definitions, correct delta assembly, and correct result message formation. Tests assert structure, not JSON key ordering. _(P1: when explicit encoder/decoder are implemented.)_

16. **TOOL_ID_NAMESPACED**: Tool IDs use namespaced format to prevent collisions: `core__get_current_time`, `mcp__<server>__<tool>`. Uses double-underscore `__` separator for LLM provider compatibility (OpenAI allows only `[a-zA-Z0-9_-]+`). Core tools use `core__` prefix. MCP-discovered tools use `mcp__<serverId>__<toolName>`. This enables safe aggregation from multiple tool sources.

17. **EFFECT_TYPED**: Every `ToolContract` declares its effect level via `effect: ToolEffect`:
    - `read_only` — pure computation or read-only data access
    - `state_change` — modifies application state (DB writes, file writes)
    - `external_side_effect` — calls external services, sends emails, triggers webhooks
      Policy may require approval for `state_change` or `external_side_effect` tools.

18. **CATALOG_IS_EXPLICIT**: The model only sees tools from the `ToolCatalog` compiled at request time. Graphs define their `graphTools[]`; bootstrap compiles these into a catalog. No tools outside the catalog are exposed to the LLM.

19. **POLICY_IS_DATA**: Enabling/disabling a tool is a config change, not a code change. `ToolPolicy` is a data structure with explicit allowlists and limits. No bespoke conditionals scattered across tool code.

20. **DENY_BY_DEFAULT**: If a tool is not explicitly enabled by `ToolPolicy.allowedTools`, `toolRunner.exec()` rejects the call with error code `policy_denied`. Unknown or disabled tools fail loudly, never pass silently.

21. **MCP_UNTRUSTED_BY_DEFAULT**: MCP-discovered tools are treated as untrusted. They must be explicitly allowlisted per server and per tool. Newly discovered tools (via `tools/list_changed`) are NOT auto-enabled; policy must be updated explicitly. See [MCP security guidance](https://modelcontextprotocol.io/docs/concepts/security).

22. **TOOL_ID_STABILITY**: Tool IDs in `TOOL_CONTRACTS` are canonical and stable. ID collisions throw at catalog construction time. Never silently overwrite. Format: `core__<tool_name>` for core tools, `mcp__<server>__<tool>` for MCP tools.

23. **TOOL_CONFIG_PROPAGATION**: LangChain tool wrappers receive `RunnableConfig` as 3rd parameter. Wrappers MUST accept and use config for per-run authorization via `configurable.toolIds`. Same policy/redaction path for all executors (InProc, langgraph dev, server).

24. **TOOL_CONTRACTS_ARE_CANONICAL**: Tool contracts (name, schema, effect, redaction) live in tool-source packages. `@cogni/ai-tools` exports `CORE_TOOL_BUNDLE` (cross-node `core__` tools; single hand-maintained list). Each node may also expose `@cogni/<node>-ai-tools` exporting its own `<NODE>_TOOL_BUNDLE` (e.g. `POLY_TOOL_BUNDLE`). The full canonical surface for a node is the union of `CORE_TOOL_BUNDLE` and any node-scoped bundles it imports. None of these packages export a default executable catalog (per **NO_DEFAULT_EXECUTABLE_CATALOG** and **NODE_OWNED_TOOL_PACKAGES**); each runtime builds its own `ToolSourcePort` by composing the bundles its node owns and binding capabilities in its composition root. `langgraph-graphs` wraps tools from the runtime-bound source; it does not define tool contracts.

24a. **NODE_OWNED_TOOL_PACKAGES**: Tools that only one node consumes live inside that node's domain at `nodes/<node>/packages/ai-tools/` (e.g. `@cogni/poly-ai-tools`), never in the shared `packages/ai-tools/`. This satisfies `SINGLE_DOMAIN_HARD_FAIL` (see [node-ci-cd-contract.md](./node-ci-cd-contract.md#single-domain-scope)) — adding a poly-only tool then touches only `nodes/poly/**`. Each node-scoped package exports its own `<NODE>_TOOL_BUNDLE` for composition; the per-node bootstrap concatenates `CORE_TOOL_BUNDLE` + the node's bundles before passing them to `createBoundToolSource`. A non-poly node MUST NOT import `@cogni/poly-ai-tools` (enforced by `.dependency-cruiser.cjs`). Promoting a node-scoped tool to cross-node is a deliberate substrate-migration PR: hoist its file to `packages/ai-tools/` and append it to `CORE_TOOL_BUNDLE`.

24b. **TOOL_CATALOG_DERIVES_FROM_BUNDLE**: The id-keyed `TOOL_CATALOG` view in `@cogni/ai-tools/catalog.ts` is derived from `CORE_TOOL_BUNDLE` via `createToolCatalog(CORE_TOOL_BUNDLE)`, never maintained as a parallel hand-written list. This prevents drift between the bundle (consumed by `createBoundToolSource` for open-world per-node composition) and the id-keyed view (consumed by `@cogni/langgraph-graphs/runtime/{core/make-server-graph,cogni/make-cogni-graph}` for `FAIL_FAST_ON_MISSING_TOOLS` lookup). Per-node tool packages follow the same pattern with their own `<NODE>_TOOL_BUNDLE`.

24c. **NODE_BUNDLE_IS_CANONICAL_AT_RESOLUTION**: Every site that resolves a tool ID to a `BoundTool` (LangChain wrapper construction, contract extraction for the LLM tool list, etc.) MUST resolve against the per-node bundle (`CORE_TOOL_BUNDLE [+ <NODE>_TOOL_BUNDLE]`), NOT against the singleton `TOOL_CATALOG`. After the per-node ai-tools split, `TOOL_CATALOG` only contains the core subset; resolving via `TOOL_CATALOG[id]` silently drops node-only tools and presents an incomplete tool surface to the LLM (the LLM then "rationally" picks the only research-y tool it sees, often `core__web_search`). Symmetric across all nodes — operator/resy/node-template only dodge this trap today because their toolIds happen to all live in `CORE_TOOL_BUNDLE`. Verified during PR #1080 validation. See `nodes/<node>/app/src/adapters/server/ai/langgraph/inproc.provider.ts` for the canonical resolution pattern (4th constructor arg is the node bundle).

25. **TOOL_SAME_PATH_ALL_EXECUTORS**: Same policy/redaction/audit path for dev, server, and InProc. No executor-specific bypass paths (e.g., no dev.ts that skips policy). `toLangChainTool` wrapper enforces `configurable.toolIds` allowlist for all executors.

26. **CONNECTION_ID_ONLY**: Tools requiring external auth receive `connectionId` (opaque reference), never raw credentials. Connection Broker resolves tokens at invocation time. No secrets in `configurable`, `ToolPolicyContext`, or ALS context. Applies to all authenticated tools regardless of source (`@cogni/ai-tools` or MCP). See [tenant-connections.md](./tenant-connections.md).

26a. **CONNECTION_ID_VIA_CONTEXT**: `connectionId` is passed exclusively via `ToolInvocationContext.connectionId`, never in tool input args. Tools declaring `requiresConnection: true` must receive `ctx.connectionId`; missing = `validation_error`. Tool input schemas must NOT define `connectionId` properties; `toToolSpec()` rejects schemas containing `connectionId` at tool-spec derivation/registration time (not execution time). See [tenant-connections.md](./tenant-connections.md).

27. **TOOL_SOURCE_RETURNS_BOUND_TOOL**: `ToolSourcePort.getBoundTool(toolId)` returns a `BoundToolRuntime` object that owns validation, execution, and redaction logic. `toolRunner` orchestrates the pipeline (policy → validate → exec → validate output → redact → emit events) but never imports Zod or performs schema operations directly. This keeps `@cogni/ai-core` semantic-only while `@cogni/ai-tools` owns schema logic.

28. **NO_SECRETS_IN_CONTEXT**: `ToolInvocationContext`, `RunnableConfig.configurable`, and ALS context must NEVER contain secrets (access tokens, API keys, refresh tokens, Authorization headers, provider secret blobs). Only opaque reference IDs (`connectionId`, `virtualKeyId`) are permitted. Secrets resolved via capability interfaces at invocation time. Enforced by negative test cases + static checks.

29. **AUTH_VIA_CAPABILITY_INTERFACE**: Tools requiring external auth receive credentials through injected capability interfaces, NOT via context fields. This prevents secret leakage into logs/traces/exceptions. Capabilities are injected at composition root; tools declare capability dependencies in contract.

29a. **AUTH_CAPABILITY_INVOCATION_SCOPED**: `AuthCapability` is constructed inside `toolRunner.exec()` per invocation, bound to `ctx.connectionId`. Methods take NO connectionId parameter—the capability is pre-bound to the single authorized connection. Never cache or reuse across invocations. Tool cannot request credentials for a different connectionId than the one validated via grant intersection.

30. **GRANT_INTERSECTION_REQUIRED**: `toolRunner.exec()` computes `effectiveConnectionIds = grant.allowedConnectionIds ∩ request.connectionIds`. Tool invocation's `connectionId` must be in this intersection BEFORE broker resolution or external calls. Missing/empty intersection = `policy_denied`. Prevents confused-deputy and UI-driven escalation attacks.

31. **ARCH_SINGLE_EXECUTION_PATH**: All tool implementations execute ONLY through `toolRunner.exec()`. No direct `tool.func()` calls in LangChain wrappers, no direct MCP `callTool()` invocations, no executor-specific bypass paths. Enforced by architectural grep tests that fail on bypass patterns.

32. **TOOL_FILE_PURITY**: Tool files must not read env, instantiate clients, import `src/**`, or access secrets. All I/O through capabilities passed to `execute(validatedArgs, ctx, caps)`.

33. **NO_DEFAULT_EXECUTABLE_CATALOG**: `@cogni/ai-tools` exports `TOOL_CATALOG` as an id-keyed view of `CORE_TOOL_BUNDLE` (per #24b) — but the entries are unbound `BoundTool` definitions (contract + stub implementation), not runnable graphs. "Executable" means capability-injected via the per-node bootstrap, which only happens at composition root. The package MUST NOT export a runtime-ready catalog with real capabilities pre-wired. Every runtime (per-node Next.js apps, langgraph dev/server, sandbox) builds its own `ToolSourcePort` by composing per-node bundles and binding real capabilities in its composition root. Per-node tool packages (e.g. `@cogni/poly-ai-tools`) follow the same rule for their `<NODE>_TOOL_BUNDLE` exports.

34. **RUNTIME_BINDS_ALL**: Every runtime executing tools must implement `createCapabilities(env)` and `createToolSource(contracts, caps)`. No tool execution without capability binding.

---

### Authorization Invariants

The `tool.execute` RBAC check is active when an `AuthorizationPort` is supplied
to `createToolRunner()`. Connection broker and graph-entry checks remain P1
hardening.

F1. **AUTHZ_CHECK_BEFORE_TOOL_EXEC**: `toolRunner.exec()` calls `AuthorizationPort.check(actor, subject?, 'tool.execute', tool:{toolId}, ctx)` after ToolPolicy and before validation/execution when authz is configured. Missing identity, deny, or unavailable returns `authz_*` without executing the tool. When subject is present (agent acting on behalf of user), both permission AND delegation are verified. See [rbac.md](./rbac.md).

F2. **CONTEXT_HAS_IDENTITY**: Authz-enabled tool execution requires `{ actorId, tenantId }` and optionally `{ subjectId, graphId }`. No anonymous tool execution when authz is configured. `subjectId` is set ONLY by server (not from request params) per OBO_SUBJECT_MUST_BE_BOUND. These fields are references only — no secrets.

F3. **CAPABILITY_OWNS_SECRETS**: Capabilities are injectable interfaces. Secrets/env access only inside runtime composition roots, never in tool files or ai-tools package.

P1. **AUTHZ_CHECK_BEFORE_TOKEN_MINT**: `ConnectionBroker.resolveForTool()` checks `connection.use` before token materialization.

P1. **AUTHZ_CHECK_BEFORE_GRAPH_INVOKE**: `GraphExecutorPort.runGraph()` checks `graph.invoke` before starting a model/tool loop.

## Design

### Key Decisions

#### 1. Tool Architecture

| Layer            | Location                                                                                                                                                | Owns                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Semantic types   | `@cogni/ai-core/tooling/types.ts`                                                                                                                       | `ToolSpec`, `ToolEffect`, `ToolExecResult`, `ToolInvocationRecord` — no Zod             |
| Core contracts   | `@cogni/ai-tools/tools/*.ts`                                                                                                                            | Zod schema, allowlist, name, description, effect, redaction (cross-node `core__` tools) |
| Node contracts   | `nodes/<node>/packages/ai-tools/src/tools/*.ts`                                                                                                         | Same shape, scoped to one node (e.g. `@cogni/poly-ai-tools`)                            |
| Core bundle      | `@cogni/ai-tools/catalog.ts`                                                                                                                            | `CORE_TOOL_BUNDLE` (source of truth) + derived `TOOL_CATALOG` view                      |
| Node bundles     | `nodes/<node>/packages/ai-tools/src/index.ts`                                                                                                           | `<NODE>_TOOL_BUNDLE` (e.g. `POLY_TOOL_BUNDLE`)                                          |
| Implementation   | adjacent to its contract file                                                                                                                           | `execute(ctx, args)` — IO via injected capabilities                                     |
| Schema compiler  | `@cogni/ai-tools/schema.ts`                                                                                                                             | `toToolSpec(contract)` — compiles Zod → ToolSpec with JSONSchema7                       |
| Wire encoder     | `nodes/<node>/app/src/adapters/server/ai/*-encoder.ts`                                                                                                  | `ToolSpec` → provider wire format (OpenAI, Anthropic) (P1, may not yet exist per-node)  |
| Wire decoder     | `nodes/<node>/app/src/adapters/server/ai/*-decoder.ts`                                                                                                  | Provider response → `ToolInvocationRecord` + AiEvents (P1)                              |
| Policy           | `@cogni/ai-core/tooling/runtime/tool-policy.ts`                                                                                                         | `ToolPolicy` — allowlist, effect requirements, budgets                                  |
| Catalog          | `packages/node-shared/src/ai/tool-catalog.ts` (interface) + `packages/ai-tools/src/catalog.ts` (createToolCatalog impl + CORE_TOOL_BUNDLE/TOOL_CATALOG) | `ToolCatalog` type + core bundle                                                        |
| Runner           | `@cogni/ai-core/tooling/tool-runner.ts`                                                                                                                 | `createToolRunner` — canonical execution pipeline                                       |
| Capability iface | `@cogni/ai-tools/capabilities/*.ts`                                                                                                                     | Minimal interfaces tools depend on (e.g., Clock)                                        |
| LangChain wrap   | `@cogni/langgraph-graphs/runtime/`                                                                                                                      | `toLangChainTool()` converter (delegates to toolRunner)                                 |
| Binding (Next)   | `nodes/<node>/app/src/bootstrap/**`                                                                                                                     | Wire capabilities → adapters for Next.js runtime                                        |
| Binding (Server) | `packages/langgraph-graphs/src/runtime/{core,cogni}/`                                                                                                   | Wire capabilities → adapters for LangGraph Server                                       |
| IO Adapter       | `nodes/<node>/app/src/adapters/server/**`                                                                                                               | Capability implementation                                                               |

**Rules:**

- Semantic types (`ToolSpec`, `ToolInvocationRecord`) in `@cogni/ai-core` — no Zod runtime dependency.
- Tool contracts (with Zod) in `@cogni/ai-tools`; compile to `ToolSpec` before passing to core.
- Wire formats (OpenAI, Anthropic) are adapter concerns — encoders/decoders in `src/adapters/`.
- IO allowed only via injected capabilities — no adapter/env imports in tools.
- Binding in composition roots only.

**Note:** Per **TOOL_SEMANTICS_CANONICAL** and **WIRE_FORMATS_ARE_ADAPTERS**, the canonical types are semantic (not wire-format-specific). OpenAI function-calling is P0 via `OpenAIToolEncoder`/`OpenAIToolDecoder`. Future Anthropic adapter would add `AnthropicToolEncoder`/`AnthropicToolDecoder` mapping `tool_use`/`tool_result` content blocks to the same `ToolInvocationRecord`, preserving rich attachments in `raw`.

#### 2. Tool Policy Architecture (P0)

> ⚠️ STALE — see [code: packages/ai-tools/src/catalog.ts](../../packages/ai-tools/src/catalog.ts) for the actual `createToolCatalog` signature (`createToolCatalog(tools: readonly CatalogBoundTool[]): ToolCatalog`). The `createToolCatalog(source, policy, ctx)` pattern and the `ToolCatalog { source, tools, get, list }` interface described in the code block below are partially aspirational (P1). Policy filtering at catalog derivation time is not yet implemented; allowlist enforcement happens at LangChain wrapper construction time via `createToolAllowlistPolicy` in `nodes/<node>/app/src/adapters/server/ai/langgraph/inproc.provider.ts`.

Per invariants EFFECT_TYPED, CATALOG_IS_EXPLICIT, POLICY_IS_DATA, DENY_BY_DEFAULT:

```typescript
// @cogni/ai-core/tooling/types.ts
type ToolEffect = 'read_only' | 'state_change' | 'external_side_effect';

/** Result of toolRunner.exec() — includes toolCallId for correlation */
interface ToolExecResult {
  readonly toolCallId: string;  // Always present (generated if not provided)
  readonly ok: boolean;
  readonly value?: unknown;     // Any JSON-serializable value (not Record<string, unknown>)
  readonly errorCode?: ToolErrorCode;
  readonly safeMessage?: string;
}

// @cogni/ai-tools/types.ts (ToolContract adds effect)
interface ToolContract<...> {
  name: string;
  description: string;
  inputSchema: ZodSchema;
  outputSchema: ZodSchema;
  effect: ToolEffect;         // NEW: required
  redaction: RedactionConfig;
}

// @cogni/ai-core/tooling/runtime/tool-policy.ts (canonical location)
type ToolPolicyDecision = 'allow' | 'deny' | 'require_approval';

/** Minimal context for policy decisions. P0: runId only. P1+: add caller, tenant, role. */
interface ToolPolicyContext {
  readonly runId: string;
}

interface ToolPolicy {
  /** Explicit allowlist of tool IDs that may execute */
  allowedTools: readonly string[];
  /** Effects that require approval before execution (P1: human-in-the-loop) */
  requireApprovalForEffects?: readonly ToolEffect[];
  /** Runtime budgets per tool invocation */
  budgets?: {
    maxRuntimeMs?: number;
    maxResultBytes?: number;
  };
  /** Decide if a tool invocation is allowed. Called by createToolCatalog() and toolRunner.exec(). */
  decide(ctx: ToolPolicyContext, toolId: string, effect: ToolEffect): ToolPolicyDecision;
}

// packages/node-shared/src/ai/tool-catalog.ts (interface; P1 aspirational shape)
/**
 * ToolCatalog: derived exclusively from ToolSourcePort + ToolPolicy.
 * Single derivation path: createToolCatalog(source, policy, ctx).
 * The model ONLY sees tools where policy.decide() returns 'allow'.
 * P0: Both 'deny' and 'require_approval' exclude tools from catalog.
 * NOTE: The actual shipped createToolCatalog (packages/ai-tools/src/catalog.ts)
 * takes (tools: readonly CatalogBoundTool[]) and returns a frozen Record.
 * The interface below describes a P1+ design target.
 */
interface ToolCatalog {
  /** The source this catalog was derived from (single-source) */
  readonly source: ToolSourcePort;
  /** Tools exposed to the model for this request (post-policy filtering) */
  readonly tools: ReadonlyMap<string, ToolSpec>;
  /** Get tool by ID; returns undefined if not in catalog */
  get(toolId: string): ToolSpec | undefined;
  /** List all tool specs (for LLM tool parameter) */
  list(): readonly ToolSpec[];
}
```

**P0 workflow (as shipped):**

1. Each graph declares its `toolIds: readonly string[]` by importing tool name constants from `@cogni/ai-tools` (cross-node) and/or `@cogni/<node>-ai-tools` (node-scoped — e.g. `@cogni/poly-ai-tools` for poly).
2. Each node's `nodes/<node>/app/src/bootstrap/container.ts` composes its node bundle: `[...CORE_TOOL_BUNDLE]` for non-poly, `[...CORE_TOOL_BUNDLE, ...POLY_TOOL_BUNDLE]` for poly. The bundle is passed both to `createBoundToolSource` (runtime execution) and to `LangGraphInProcProvider` (LLM tool-list resolution per #24c).
3. `createToolCatalog(tools: readonly CatalogBoundTool[])` (in `packages/ai-tools/src/catalog.ts`) is a thin id-keying utility — it does NOT filter by policy. The shipped `TOOL_CATALOG` is `createToolCatalog(CORE_TOOL_BUNDLE)`.
4. Policy filtering happens at LangChain wrapper construction time inside the per-node `inproc.provider.ts` via `createToolAllowlistPolicy(allToolIds)`. The LLM only sees the intersection of the graph's declared `toolIds` and the policy's allowlist.
5. `toolRunner.exec(toolId, args)` enforces policy a second time at runtime (defense in depth):
   - `allow` → execute tool
   - `deny` → error code `policy_denied`
   - `require_approval` → P0: treated as deny; P1: human-in-the-loop interrupt

**Double enforcement:** Catalog filters visibility; toolRunner enforces at runtime (defense in depth).

**No tool registry service in P0.** Graphs import their tools directly. Tool bindings live in composition roots (`nodes/<node>/app/src/bootstrap/ai/tool-bindings.ts`), not adapter-scoped files.

#### 2b. ToolSourcePort + BoundToolRuntime Architecture

Per invariants TOOL_SOURCE_RETURNS_BOUND_TOOL, NO_SECRETS_IN_CONTEXT, AUTH_VIA_CAPABILITY_INTERFACE:

```typescript
// @cogni/ai-core/tooling/ports/tool-source.port.ts
interface ToolSourcePort {
  /** Get executable tool by ID; returns undefined if not found */
  getBoundTool(toolId: string): BoundToolRuntime | undefined;
  /** List all tool specs for LLM exposure (derived from BoundToolRuntime.spec) */
  listToolSpecs(): readonly ToolSpec[];
}

// @cogni/ai-core/tooling/types.ts
interface BoundToolRuntime {
  /** Namespaced tool ID (e.g., core__get_current_time) */
  readonly id: string;
  /** Tool spec for LLM exposure (compiled from Zod, no runtime) */
  readonly spec: ToolSpec;
  /** Side-effect level for policy decisions */
  readonly effect: ToolEffect;
  /** Whether tool requires authenticated connection */
  readonly requiresConnection: boolean;
  /** Capability dependencies (e.g., ['auth', 'clock']) */
  readonly capabilities: readonly string[];

  /** Validate input args; throws ZodError on failure. Zod stays in ai-tools. */
  validateInput(rawArgs: unknown): unknown;
  /** Execute tool with validated args + context + capabilities */
  exec(
    validatedArgs: unknown,
    ctx: ToolInvocationContext,
    capabilities: ToolCapabilities
  ): Promise<unknown>;
  /** Validate output; throws on failure */
  validateOutput(rawOutput: unknown): unknown;
  /** Redact output for UI/telemetry; allowlist-based */
  redact(validatedOutput: unknown): unknown;
}

/** Context for tool invocation — references only, NO secrets */
interface ToolInvocationContext {
  readonly runId: string;
  readonly toolCallId: string;
  // Identity fields (per CONTEXT_HAS_IDENTITY, RBAC_SPEC.md)
  readonly actorId: string; // "user:{wallet}" | "agent:{id}" | "service:{name}"
  readonly subjectId?: string; // "user:{wallet}" — OBO only, server-bound
  readonly tenantId: string; // Tenant/billing account scope
  readonly graphId?: string; // Graph context for authz
  // Connection reference (per CONNECTION_IN_CONTEXT_NOT_ARGS)
  readonly connectionId?: string; // Out-of-band, not in tool args
  // FORBIDDEN: accessToken, apiKey, refreshToken, headers, secrets
}

/** Capabilities injected by toolRunner; backed by broker */
interface ToolCapabilities {
  readonly auth?: AuthCapability;
  readonly clock?: ClockCapability;
  // Extensible for future capabilities
}

/** Invocation-scoped capability — bound to ctx.connectionId, no param needed */
interface AuthCapability {
  /** Get access token for the bound connection (per AUTH_CAPABILITY_INVOCATION_SCOPED) */
  getAccessToken(): Promise<string>;
  /** Get auth headers for the bound connection */
  getAuthHeaders(): Promise<Record<string, string>>;
}
```

**toolRunner pipeline with ToolSourcePort:**

```
toolRunner.exec(toolId, rawArgs, ctx)
    │
    ├─ 1. source.getBoundTool(toolId) → boundTool | undefined
    │      └─ undefined → { ok: false, errorCode: 'unavailable' }
    │
    ├─ 2. policy.decide(ctx, toolId, boundTool.effect)           ← ToolPolicy (cheap, deny-fast)
    │      └─ deny/require_approval → { ok: false, errorCode: 'policy_denied' }
    │
    ├─ 3. If authz configured: authz.check(actor, subject?, 'tool.execute', tool:{id}) ← OpenFGA
    │      └─ deny/unavailable/missing identity → { ok: false, errorCode: 'authz_*' }
    │
    ├─ 4. If boundTool.requiresConnection:
    │      ├─ Validate ctx.connectionId exists (uuid-validated at boundary)
    │      ├─ Check connectionId ∈ effectiveConnectionIds (grant ∩ request)
    │      └─ Fail fast → { ok: false, errorCode: 'policy_denied' }
    │
    ├─ 5. boundTool.validateInput(rawArgs) → validatedArgs
    │      └─ ZodError → { ok: false, errorCode: 'validation' }
    │
    ├─ 6. Resolve capabilities (auth via broker if needed)
    │      └─ P1: authz.check for connection.use happens inside broker
    │
    ├─ 7. emit('tool_call_start', { toolCallId, args: validatedArgs })
    │
    ├─ 8. boundTool.exec(validatedArgs, ctx, capabilities) → rawOutput
    │      └─ Error → { ok: false, errorCode: 'execution' }
    │
    ├─ 9. boundTool.validateOutput(rawOutput) → validatedOutput
    │
    ├─ 10. boundTool.redact(validatedOutput) → safeOutput
    │       └─ Error → { ok: false, errorCode: 'redaction_failed' }
    │
    ├─ 11. emit('tool_call_result', { toolCallId, result: safeOutput })
    │
    └─ 12. { ok: true, value: safeOutput }
```

**Key design points:**

- `@cogni/ai-core` stays semantic-only (no Zod imports)
- `BoundToolRuntime` owns validation/redaction logic; implemented in `@cogni/ai-tools`
- Secrets never touch context; resolved via `AuthCapability` at step 6
- Grant intersection checked at step 4, BEFORE broker resolve (step 6)
- OpenFGA `tool.execute` authz runs at step 3 when `AuthorizationPort` is configured

#### 3. assistant-stream Tool API

Route uses `assistant-stream` controller API. See `finalizeToolCall()` in `route.ts` for the correct pattern.

**Critical:** `setResponse()` alone does NOT finalize the substream. Must call `close()` after. See Open Questions.

**Never** invent custom SSE events. Use official helper only.

#### 4. Agentic Loop (chat.graph.ts)

**Critical:** Graph calls `completion.executeStream()`, never `llmService` directly. This keeps billing/telemetry/promptHash centralized.

**Critical:** Graph reads tool calls from `final.toolCalls` only—never from raw `tool_call_delta` events. The adapter assembles deltas; graph consumes assembled results.

```
┌─────────────────────────────────────────────────────────────────────┐
│ LLM Call via completion.executeStream()                              │
│ - Yield text_delta events for content                                │
│ - Adapter accumulates delta.tool_calls internally                    │
│ - Await final: { toolCalls, finishReason, ... }                      │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼ (if final.finishReason == "tool_calls")
┌─────────────────────────────────────────────────────────────────────┐
│ Tool Execution via toolRunner.exec() for each final.toolCalls[]      │
│ - Yield tool_call_start event (same toolCallId)                      │
│ - Parse args JSON, execute tool (or emit error if invalid)           │
│ - Yield tool_call_result event (same toolCallId)                     │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼ (feed results back)
┌─────────────────────────────────────────────────────────────────────┐
│ Next LLM Call with tool results in messages                          │
│ - Include assistant message with tool_calls                          │
│ - Include tool messages with results                                 │
│ - Repeat until final.finishReason != "tool_calls"                    │
└─────────────────────────────────────────────────────────────────────┘
```

**Finalization:** Emit exactly one `done` event and resolve `final` exactly once—regardless of how many tool loops occurred. No side effects attached to stream iteration.

#### 5. OpenAI Tool Call SSE Format

LiteLLM streams tool calls as incremental deltas:

```json
// First chunk: ID + name
{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_xxx","function":{"name":"generate_title","arguments":""},"type":"function"}]}}]}

// Subsequent chunks: argument fragments
{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"mes"}}]}}]}
{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"sage\":\"hi\"}"}}]}}]}
```

Accumulate by `index`, parse complete JSON when done.

#### 6. Tool UI Location

Tool components in `features/ai/components/tools/`. Kit cannot import features.

Register via `makeAssistantToolUI` keyed by tool name:

```typescript
export const GenerateTitleToolUI = makeAssistantToolUI({
  toolName: "generate_title",
  render: ({ args, result, status }) => { ... }
});
```

#### 7. Completion Contract for Tool Calls

The `LlmCompletionResult` contract for tool calls:

- `toolCalls` is present iff `finishReason === "tool_calls"`
- Each `LlmToolCall.function.arguments` is a fully assembled JSON string (not fragments)
- Graph must NOT attempt to parse or execute tools until `final` resolves
- Adapter resets assembly state between `completionStream()` calls (per **ADAPTER_ASSEMBLES_TOOLCALLS**)

#### 8. Tool Argument Parse Errors

When `toolCall.function.arguments` is invalid JSON:

1. Graph emits `tool_call_start` with the malformed toolCallId (per **TOOLCALLID_STABLE**)
2. Graph emits `tool_call_result` with error payload:
   ```typescript
   {
     ok: false,
     errorCode: "invalid_json",
     message: "Invalid tool arguments JSON"  // Safe message, no raw args leaked
   }
   ```
3. Graph continues: feed error result back to LLM as tool message for self-correction (do NOT halt)
4. LLM may retry with corrected arguments or respond with explanation

### Existing Infrastructure

| Component                | Location                                                  | Status                                                 |
| ------------------------ | --------------------------------------------------------- | ------------------------------------------------------ |
| AiEvent types            | `@cogni/ai-core`                                          | Complete                                               |
| ToolContract, BoundTool  | `@cogni/ai-tools`                                         | Complete                                               |
| get_current_time tool    | `@cogni/ai-tools/tools/`                                  | Complete                                               |
| tool-runner.ts           | `@cogni/ai-core/tooling/tool-runner.ts`                   | Complete pipeline (canonical location)                 |
| tool-policy.ts           | `@cogni/ai-core/tooling/runtime/tool-policy.ts`           | ToolPolicy, createToolAllowlistPolicy                  |
| Route tool handling      | `nodes/<node>/app/src/app/api/v1/ai/chat/route.ts`        | Active (per-node)                                      |
| completion.ts            | `nodes/<node>/app/src/features/ai/services/completion.ts` | Uses GraphExecutorPort; ai_runtime.ts no longer exists |
| LlmCaller/GraphLlmCaller | `nodes/<node>/app/src/ports/llm.port.ts`                  | Types defined                                          |

### File Pointers

| File                                                 | Purpose                                                                    |
| ---------------------------------------------------- | -------------------------------------------------------------------------- |
| `@cogni/ai-core/tooling/types.ts`                    | Canonical semantic types (ToolSpec, ToolInvocationRecord)                  |
| `@cogni/ai-core/tooling/tool-runner.ts`              | Canonical execution pipeline                                               |
| `@cogni/ai-core/tooling/runtime/tool-policy.ts`      | ToolPolicy, createToolAllowlistPolicy                                      |
| `@cogni/ai-core/tooling/ports/tool-source.port.ts`   | ToolSourcePort interface                                                   |
| `@cogni/ai-core/tooling/sources/static.source.ts`    | StaticToolSource implementation                                            |
| `@cogni/ai-tools/tools/*.ts`                         | Cross-node `core__` tool contracts + implementations                       |
| `@cogni/ai-tools/catalog.ts`                         | `CORE_TOOL_BUNDLE` (source of truth) + derived `TOOL_CATALOG`              |
| `nodes/<node>/packages/ai-tools/src/tools/*.ts`      | Node-scoped tool contracts + implementations (e.g. `@cogni/poly-ai-tools`) |
| `nodes/<node>/packages/ai-tools/src/index.ts`        | `<NODE>_TOOL_BUNDLE` for per-node composition                              |
| `@cogni/ai-tools/schema.ts`                          | toToolSpec() — Zod → ToolSpec compiler                                     |
| `@cogni/ai-tools/capabilities/*.ts`                  | Capability interfaces (Clock, Auth)                                        |
| `@cogni/langgraph-graphs/runtime/langchain-tools.ts` | toLangChainTool() wrapper                                                  |
| `nodes/<node>/app/src/bootstrap/ai/tool-bindings.ts` | Capability → adapter binding for Next.js (per-node)                        |
| `packages/node-shared/src/ai/tool-catalog.ts`        | ToolCatalog type interface                                                 |
| `nodes/<node>/app/src/app/api/v1/ai/chat/route.ts`   | Route tool handling (addToolCallPart) (per-node)                           |

## Acceptance Checks

**Automated:**

- `nodes/operator/app/tests/unit/features/ai/tool-runner.test.ts` — deny-by-default, policy filter, require_approval (per-node — same shape under each node's `app/tests/`)
- `nodes/operator/app/tests/unit/shared/ai/tool-catalog.test.ts` — catalog filtering via policy.decide() (per-node)
- `nodes/operator/app/tests/contract/ai.chat.v1.contract.test.ts` — tool message validation (per-node)
- `nodes/operator/app/tests/stack/ai/chat-tool-replay.stack.test.ts` — tool replay end-to-end (per-node)

**Manual:**

1. Verify all tool execution flows through `toolRunner.exec()` (grep for bypass patterns)
2. Verify no `@langchain/*` imports in `nodes/<node>/app/src/**`

## Open Questions

- [ ] **assistant-stream API footgun**: `setResponse()` does not finalize tool-call substream; `close()` must be called after. Current workaround: `finalizeToolCall()` helper in `route.ts`. Upstream fix pending.
- [ ] **assistant-stream chunk ordering**: Async merger does not guarantee ToolCallResult precedes FinishMessage. Chunks exist but may arrive out of order. Upstream fix needed. See `tests/stack/ai/chat-tool-replay.stack.test.ts`.

## Related

- [tools-authoring.md](../guides/tools-authoring.md) — Practical guide: how to add a new tool
- [ai-setup.md](./ai-setup.md) — Correlation IDs, telemetry invariants
- [langgraph-patterns.md](./langgraph-patterns.md) — Architecture, anti-patterns
- [Graph Execution](graph-execution.md) — GraphExecutorPort, billing, pump+fanout
- [tenant-connections.md](./tenant-connections.md) — Authenticated tool connections
- [Project: Tool Use Evolution](../../work/projects/proj.tool-use-evolution.md)
