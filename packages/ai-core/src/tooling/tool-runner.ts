// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-core/tooling/tool-runner`
 * Purpose: Tool execution with AiEvent emission, policy enforcement, and payload redaction.
 * Scope: Sole owner of toolCallId generation; executes tools via injected implementations. Does not import from src/ or perform observability scrubbing.
 * Invariants:
 *   - GRAPHS_USE_TOOLRUNNER_ONLY: Graphs invoke tools exclusively through toolRunner.exec()
 *   - TOOLCALL_ID_STABLE: Same toolCallId across start→result
 *   - TOOLRUNNER_ALLOWLIST_HARD_FAIL: Missing allowlist or redaction failure → error event
 *   - TOOLRUNNER_RESULT_SHAPE: Returns {ok:true, value} | {ok:false, errorCode, safeMessage}
 *   - TOOLRUNNER_PIPELINE_ORDER: tool lookup → policy check → optional authz check → validate args → emit start → execute → validate result → redact → emit result → return
 *   - DENY_BY_DEFAULT: Default to DenyAllPolicy if no policy provided
 *   - AUTHZ_FAILS_CLOSED_BEFORE_EXEC: when authz is configured, missing identity, deny, or unavailable returns authz_* without executing the tool
 *   - SPAN_PORT_HANDLES_SCRUBBING: ai-core passes raw data to spanPort; adapter handles scrubbing/truncation
 * Side-effects: none (AiEvent emission via injected callback is caller's responsibility)
 * Links: @cogni/ai-tools, AI_SETUP_SPEC.md, TOOL_USE_SPEC.md
 * @public
 */

import type {
  AuthorizationPort,
  AuthzDecision,
  AuthzDecisionCode,
} from "@cogni/authorization-core";
import { authzToolResource } from "@cogni/authorization-core";
import type {
  ToolCallResultEvent,
  ToolCallStartEvent,
} from "../events/ai-events";
import type { AiSpanPort } from "./ai-span";
import type { ToolSourcePort } from "./ports/tool-source.port";
import {
  DENY_ALL_POLICY,
  type ToolPolicy,
  type ToolPolicyContext,
} from "./runtime/tool-policy";
import type { EmitAiEvent, ToolResult } from "./types";

/** Charset for provider-compatible tool call IDs */
const TOOL_ID_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Generate 9-char alphanumeric tool call ID (provider-compatible) */
function generateToolCallId(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  let id = "";
  for (const b of bytes) id += TOOL_ID_CHARS[b % TOOL_ID_CHARS.length];
  return id;
}

/**
 * Options for tool execution.
 */
export interface ToolExecOptions {
  /** Model-provided tool call ID (use this if available, else generate UUID) */
  readonly modelToolCallId?: string;
}

/**
 * Configuration for tool runner creation.
 */
export interface ToolRunnerConfig {
  /**
   * Policy for tool execution.
   * Default: DENY_ALL_POLICY (rejects all tools per DENY_BY_DEFAULT invariant)
   */
  readonly policy?: ToolPolicy;

  /**
   * Context for policy decisions.
   * Default: { runId: 'unknown' }
   */
  readonly ctx?: ToolPolicyContext;

  /** Optional shared authorization port. When provided, tool execution fails closed before validation/execution. */
  readonly authz?: AuthorizationPort;

  /** Actor performing tool execution. Required when authz is provided. */
  readonly actorId?: string;

  /** Tenant boundary for authz and audit. Required when authz is provided. */
  readonly tenantId?: string;

  /** Server-bound subject for on-behalf-of execution. */
  readonly subjectId?: string;

  /** Graph context for authz and audit. */
  readonly graphId?: string;

  /**
   * Optional span port for tool instrumentation.
   * Per SPAN_METADATA_ONLY: ai-core emits metadata-only spans by default.
   */
  readonly spanPort?: AiSpanPort;

  /**
   * Trace ID for span correlation.
   * Required if spanPort is provided.
   */
  readonly traceId?: string;

  /**
   * Optional hook to prepare span input payload.
   * If provided, adapter is responsible for scrubbing/size-capping.
   * Hook failures are swallowed (instrumentation must not break execution).
   */
  readonly spanInput?: (args: unknown) => unknown;

  /**
   * Optional hook to prepare span output payload.
   * If provided, adapter is responsible for scrubbing/size-capping.
   * Hook failures are swallowed (instrumentation must not break execution).
   */
  readonly spanOutput?: (result: unknown) => unknown;
}

/**
 * Create a tool runner instance with the given tool source.
 * The runner executes tools and emits AiEvents via the provided callback.
 *
 * Per TOOL_SOURCE_RETURNS_BOUND_TOOL: All tool lookups go through ToolSourcePort.
 * Per DENY_BY_DEFAULT: if no policy is provided, defaults to DENY_ALL_POLICY
 * which rejects all tool invocations. Callers must explicitly provide a policy
 * with allowedTools to enable tool execution.
 *
 * @param source - Tool source providing getBoundTool() lookup
 * @param emit - Callback to emit AiEvents
 * @param config - Optional configuration (policy, ctx)
 * @returns Tool runner with exec method
 */
export function createToolRunner(
  source: ToolSourcePort,
  emit: EmitAiEvent,
  config?: ToolRunnerConfig
) {
  // Default to DENY_ALL_POLICY per DENY_BY_DEFAULT invariant
  const policy = config?.policy ?? DENY_ALL_POLICY;
  // Default ctx for P0; P1+ will require explicit ctx for tenant/role-based policy
  const ctx = config?.ctx ?? { runId: "toolrunner_default" };
  // Span instrumentation (optional) - per SPAN_METADATA_ONLY, ai-core emits metadata only
  const spanPort = config?.spanPort;
  const traceId = config?.traceId;
  const spanInput = config?.spanInput;
  const spanOutput = config?.spanOutput;
  const authz = config?.authz;
  const actorId = config?.actorId;
  const tenantId = config?.tenantId;
  const subjectId = config?.subjectId;
  const graphId = config?.graphId;

  /**
   * Execute a tool by name with given arguments.
   * Follows fixed pipeline per TOOLRUNNER_PIPELINE_ORDER.
   * Creates span for tool visibility (if spanPort provided).
   *
   * @param toolName - Name of the tool to execute
   * @param rawArgs - Raw arguments to pass to the tool
   * @param options - Execution options (e.g., model-provided toolCallId)
   * @returns ToolResult with redacted value on success, error info on failure
   */
  async function exec(
    toolName: string,
    rawArgs: unknown,
    options?: ToolExecOptions
  ): Promise<ToolResult<Record<string, unknown>>> {
    // Generate stable toolCallId (model-provided or 9-char alphanumeric)
    const toolCallId = options?.modelToolCallId ?? generateToolCallId();
    const execStartTime = performance.now();

    // Create span for tool (if configured)
    // Per SPAN_METADATA_ONLY: metadata only by default; hook provides scrubbed payload
    let hookInput: unknown;
    let hookInputFailed = false;
    if (spanInput) {
      try {
        hookInput = spanInput(rawArgs);
      } catch {
        // Swallow hook failures - instrumentation must not break execution
        hookInputFailed = true;
      }
    }
    const span =
      spanPort && traceId
        ? spanPort.startSpan({
            traceId,
            name: `tool:${toolName}`,
            input: hookInput, // undefined if no hook or hook failed
            metadata: { toolCallId, hookInputFailed },
          })
        : undefined;

    /**
     * End Langfuse span with output and metadata.
     */
    const endSpan = (
      output: unknown,
      level: "DEFAULT" | "WARNING" | "ERROR" = "DEFAULT",
      extraMetadata?: Record<string, unknown>
    ): void => {
      if (!span) return;
      const durationMs = performance.now() - execStartTime;
      span.end({
        output,
        level,
        metadata: { durationMs, ...extraMetadata },
      });
    };

    // Look up bound tool via ToolSourcePort (per TOOL_SOURCE_RETURNS_BOUND_TOOL)
    const boundTool = source.getBoundTool(toolName);
    if (!boundTool) {
      const errorEvent: ToolCallResultEvent = {
        type: "tool_call_result",
        toolCallId,
        result: { error: `Tool '${toolName}' not found` },
        isError: true,
      };
      emit(errorEvent);
      endSpan({ errorCode: "unavailable" }, "ERROR");
      return {
        ok: false,
        errorCode: "unavailable",
        safeMessage: `Tool '${toolName}' is not available`,
      };
    }

    // 1. Policy check (DENY_BY_DEFAULT) — before any method calls
    const decision = policy.decide(ctx, toolName, boundTool.effect);
    if (decision === "deny" || decision === "require_approval") {
      // P0: require_approval treated as deny (human-in-the-loop is P1)
      const errorEvent: ToolCallResultEvent = {
        type: "tool_call_result",
        toolCallId,
        result: { error: `Tool '${toolName}' is not allowed by policy` },
        isError: true,
      };
      emit(errorEvent);
      // Per LANGFUSE_TOOL_VISIBILITY: record policy decision
      endSpan({ decision: "deny", reason: "policy_denied" }, "WARNING", {
        policyDecision: "deny",
        effect: boundTool.effect,
      });
      return {
        ok: false,
        errorCode: "policy_denied",
        safeMessage: `Tool '${toolName}' is not allowed by current policy`,
      };
    }

    if (authz) {
      if (!actorId || !tenantId) {
        const result = authzFailureEvent(
          toolCallId,
          toolName,
          "authz_unavailable",
          "Tool authorization context is incomplete"
        );
        emit(result.event);
        endSpan(
          { errorCode: "authz_unavailable", reason: "missing_identity" },
          "ERROR",
          {
            effect: boundTool.effect,
            authzDecision: "unavailable",
          }
        );
        return result.result;
      }

      const authzDecision = await authz.check({
        actorId,
        ...(subjectId !== undefined ? { subjectId } : {}),
        action: "tool.execute",
        resource: authzToolResource(toolName),
        context: {
          tenantId,
          runId: ctx.runId,
          toolCallId,
          ...(graphId !== undefined ? { graphId } : {}),
        },
      });

      if (authzDecision.decision === "deny") {
        const result = authzFailureEvent(
          toolCallId,
          toolName,
          authzDecision.code,
          authzSafeMessage(authzDecision)
        );
        emit(result.event);
        endSpan(
          { errorCode: authzDecision.code, reason: authzDecision.reason },
          authzDecision.code === "authz_unavailable" ? "ERROR" : "WARNING",
          {
            effect: boundTool.effect,
            authzDecision: authzDecision.code,
          }
        );
        return result.result;
      }
    }

    // 2. Validate args via boundTool.validateInput()
    // Per TOOL_SOURCE_RETURNS_BOUND_TOOL: BoundToolRuntime owns validation logic
    let validatedInput: unknown;
    try {
      validatedInput = boundTool.validateInput(rawArgs);
    } catch (err) {
      const safeMessage =
        err instanceof Error ? err.message : "Invalid tool arguments";
      const errorEvent: ToolCallResultEvent = {
        type: "tool_call_result",
        toolCallId,
        result: { error: safeMessage },
        isError: true,
      };
      emit(errorEvent);
      endSpan({ errorCode: "validation", message: safeMessage }, "ERROR");
      return {
        ok: false,
        errorCode: "validation",
        safeMessage,
      };
    }

    // 3. Emit tool_call_start with validated (possibly redacted) args
    const startEvent: ToolCallStartEvent = {
      type: "tool_call_start",
      toolCallId,
      toolName,
      args: validatedInput as Record<string, unknown>,
    };
    emit(startEvent);

    // 4. Build invocation context and capabilities
    // Per AUTH_VIA_CAPABILITY_INTERFACE: tools receive auth via capabilities, not context
    const invocationCtx = {
      runId: ctx.runId,
      toolCallId,
      actorId: actorId ?? "service:legacy_toolrunner",
      tenantId: tenantId ?? "tenant:legacy_toolrunner",
      ...(subjectId !== undefined ? { subjectId } : {}),
      ...(graphId !== undefined ? { graphId } : {}),
      // connectionId will be added in P1 when connection auth is implemented
    };
    // Per FIX_LAYERING_CAPABILITY_TYPES: capabilities is opaque to ai-core
    // Composition root (src/bootstrap/ai/tool-bindings.ts) provides concrete capabilities
    const capabilities = {};

    // 5. Execute tool via boundTool.exec()
    // Per TOOL_SOURCE_RETURNS_BOUND_TOOL: BoundToolRuntime owns execution logic
    let rawOutput: unknown;
    try {
      rawOutput = await boundTool.exec(
        validatedInput,
        invocationCtx,
        capabilities
      );
    } catch (err) {
      const safeMessage =
        err instanceof Error ? err.message : "Tool execution failed";
      const errorEvent: ToolCallResultEvent = {
        type: "tool_call_result",
        toolCallId,
        result: { error: safeMessage },
        isError: true,
      };
      emit(errorEvent);
      endSpan({ errorCode: "execution", message: safeMessage }, "ERROR", {
        effect: boundTool.effect,
      });
      return {
        ok: false,
        errorCode: "execution",
        safeMessage,
      };
    }

    // 6. Validate result via boundTool.validateOutput()
    // Per TOOL_SOURCE_RETURNS_BOUND_TOOL: BoundToolRuntime owns output validation
    let validatedOutput: unknown;
    try {
      validatedOutput = boundTool.validateOutput(rawOutput);
    } catch (err) {
      const safeMessage =
        err instanceof Error ? err.message : "Invalid tool output";
      const errorEvent: ToolCallResultEvent = {
        type: "tool_call_result",
        toolCallId,
        result: { error: safeMessage },
        isError: true,
      };
      emit(errorEvent);
      endSpan({ errorCode: "validation", message: safeMessage }, "ERROR");
      return {
        ok: false,
        errorCode: "validation",
        safeMessage,
      };
    }

    // 7. Redact output via boundTool.redact()
    // Per REDACTION_REQUIRED: no raw output may leak to UI/logs
    let redactedOutput: unknown;
    try {
      redactedOutput = boundTool.redact(validatedOutput);
    } catch (err) {
      const safeMessage =
        err instanceof Error ? err.message : "Redaction failed";
      const errorEvent: ToolCallResultEvent = {
        type: "tool_call_result",
        toolCallId,
        result: { error: "Internal error processing tool result" },
        isError: true,
      };
      emit(errorEvent);
      endSpan({ errorCode: "redaction_failed" }, "ERROR");
      return {
        ok: false,
        errorCode: "redaction_failed",
        safeMessage,
      };
    }

    // 8. Emit tool_call_result with redacted output
    // Cast: boundTool.redact is responsible for returning correct shape
    const safeResult = redactedOutput as Record<string, unknown>;
    const resultEvent: ToolCallResultEvent = {
      type: "tool_call_result",
      toolCallId,
      result: safeResult,
    };
    emit(resultEvent);

    // 9. End span with success
    // Per SPAN_METADATA_ONLY: metadata only by default; hook provides scrubbed payload
    let hookOutput: unknown;
    let hookOutputFailed = false;
    if (spanOutput) {
      try {
        hookOutput = spanOutput(redactedOutput);
      } catch {
        // Swallow hook failures - instrumentation must not break execution
        hookOutputFailed = true;
      }
    }
    endSpan(hookOutput, "DEFAULT", {
      effect: boundTool.effect,
      policyDecision: "allow",
      hookOutputFailed,
    });

    // 10. Return result
    return {
      ok: true,
      value: safeResult,
    };
  }

  return { exec };
}

/**
 * Type for the tool runner instance.
 */
export type ToolRunner = ReturnType<typeof createToolRunner>;

function authzFailureEvent(
  toolCallId: string,
  toolName: string,
  errorCode: Extract<AuthzDecisionCode, "authz_denied" | "authz_unavailable">,
  safeMessage: string
): {
  readonly event: ToolCallResultEvent;
  readonly result: ToolResult<Record<string, unknown>>;
} {
  return {
    event: {
      type: "tool_call_result",
      toolCallId,
      result: { error: safeMessage },
      isError: true,
    },
    result: {
      ok: false,
      errorCode,
      safeMessage: `Tool '${toolName}' is not authorized`,
    },
  };
}

function authzSafeMessage(
  decision: Extract<AuthzDecision, { readonly decision: "deny" }>
): string {
  return decision.code === "authz_unavailable"
    ? "Authorization service is unavailable"
    : "Tool execution is not authorized";
}
