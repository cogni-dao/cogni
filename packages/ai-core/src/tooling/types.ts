// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-core/tooling/types`
 * Purpose: Canonical semantic types for tool definitions, invocations, and execution.
 * Scope: Framework-agnostic types for tool definitions and execution. Does NOT import Zod — uses JSONSchema7 for wire formats.
 * Invariants:
 *   - TOOL_SEMANTICS_CANONICAL: These are the canonical types; wire formats are adapters
 *   - TOOL_EXEC_TYPES_IN_AI_CORE: ToolExecFn, ToolExecResult, EmitAiEvent defined here
 *   - EFFECT_TYPED: ToolEffect declares side-effect level for policy decisions
 *   - No Zod dependency — compiled from @cogni/ai-tools via toToolSpec()
 *   - ToolSpec uses JSONSchema7 for inputSchema (compiled from Zod)
 * Side-effects: none (types only)
 * Links: TOOL_USE_SPEC.md, GRAPH_EXECUTION.md
 * @public
 */

import type { JSONSchema7 } from "json-schema";

import type { AiEvent } from "../events/ai-events";

/**
 * Tool effect level for policy decisions.
 * Per EFFECT_TYPED invariant: every tool declares its side-effect level.
 */
export type ToolEffect = "read_only" | "state_change" | "external_side_effect";

/**
 * Redaction mode for tool output.
 * P0 supports only top_level_only — filter top-level keys by allowlist.
 */
export type RedactionMode = "top_level_only";

/**
 * Redaction configuration for tool output.
 */
export interface ToolRedactionConfig {
  /** Redaction strategy (P0: top_level_only) */
  readonly mode: RedactionMode;
  /** Fields that are safe to expose to UI/logs */
  readonly allowlist: readonly string[];
}

/**
 * Tool specification — canonical definition for wire formats.
 *
 * This is the compiled form of ToolContract (Zod → JSONSchema7).
 * Used by wire encoders (OpenAI, Anthropic) to emit tool definitions.
 *
 * Per TOOL_SEMANTICS_CANONICAL: inputSchema must conform to P0-supported
 * JSONSchema subset. Disallow oneOf/anyOf/allOf/not/if-then-else/patternProperties.
 */
export interface ToolSpec {
  /** Stable tool name (snake_case, namespaced: core:tool_name) */
  readonly name: string;
  /** Human-readable description for LLM */
  readonly description: string;
  /** JSONSchema7 for input validation (compiled from Zod) */
  readonly inputSchema: JSONSchema7;
  /** Side-effect level for policy decisions */
  readonly effect: ToolEffect;
  /** Redaction config for output */
  readonly redaction: ToolRedactionConfig;
  /**
   * Hash of the compiled schema for drift detection and promptHash computation.
   * Optional for P0. Compute in Node-only layer with stable stringify if needed.
   */
  readonly schemaHash?: string;
}

/**
 * Known error codes for tool execution failures.
 * Extensible union for future error types.
 */
export type ToolErrorCode =
  | "validation"
  | "execution"
  | "unavailable"
  | "redaction_failed"
  | "invalid_json"
  | "timeout"
  | "policy_denied"
  | "authz_denied"
  | "authz_unavailable";

/**
 * Tool invocation record — captures full lifecycle of a tool call.
 *
 * Used for:
 * - Telemetry/observability
 * - Passing tool results back to LLM
 * - Audit logging
 *
 * Per TOOL_SEMANTICS_CANONICAL: `raw` preserves provider-native payload
 * for observability only; must be redacted/omitted from UI/logs.
 */
export interface ToolInvocationRecord {
  /** Stable ID for this tool call (model-provided or UUID) */
  readonly toolCallId: string;
  /** Tool name that was invoked */
  readonly name: string;
  /** Parsed arguments passed to tool (flexible shape) */
  readonly args: unknown;
  /** Tool execution result (redacted for UI safety, flexible shape) */
  readonly result?: unknown;
  /** Error info if tool execution failed */
  readonly error?: {
    readonly code: ToolErrorCode;
    readonly message: string;
  };
  /** When tool execution started (epoch milliseconds for serialization) */
  readonly startedAtMs: number;
  /** When tool execution completed (epoch milliseconds) */
  readonly endedAtMs?: number;
  /**
   * Raw provider-native payload for observability.
   * Must be redacted/omitted from UI/logs. Never influences execution or billing.
   */
  readonly raw?: unknown;
}

// -----------------------------------------------------------------------------
// Tool Invocation Context (references only, NO secrets)
// Per NO_SECRETS_IN_CONTEXT invariant
// -----------------------------------------------------------------------------

/**
 * Context for tool invocation — references only, NO secrets.
 *
 * Per NO_SECRETS_IN_CONTEXT (TOOL_USE_SPEC.md #28):
 * This type must NEVER contain secrets (access tokens, API keys, refresh tokens,
 * Authorization headers, provider secret blobs). Only opaque reference IDs are permitted.
 *
 * FORBIDDEN fields: accessToken, apiKey, refreshToken, headers, secret, credential
 */
export interface ToolInvocationContext {
  /** Graph run ID for correlation */
  readonly runId: string;
  /** Stable tool call ID (model-provided or generated) */
  readonly toolCallId: string;
  /** Actor performing the invocation, e.g. user:{id}, agent:{id}, or service:{name}. */
  readonly actorId: string;
  /** Tenant/billing account boundary for authz and audit. */
  readonly tenantId: string;
  /** User subject for on-behalf-of execution; server-bound only. */
  readonly subjectId?: string;
  /** Graph context for authorization and audit. */
  readonly graphId?: string;
  /**
   * Connection ID for authenticated tools (out-of-band, not in tool args).
   * Per CONNECTION_IN_CONTEXT_NOT_ARGS: connectionId in context, not tool schemas.
   */
  readonly connectionId?: string;
}

// -----------------------------------------------------------------------------
// Tool Capabilities Type
// Per FIX_LAYERING_CAPABILITY_TYPES: interfaces live in ai-tools, ai-core uses opaque
// -----------------------------------------------------------------------------

/**
 * Capabilities type alias for ai-core.
 *
 * Per FIX_LAYERING_CAPABILITY_TYPES (Architecture eval):
 * - Concrete capability interfaces (AuthCapability, ClockCapability) live in @cogni/ai-tools
 * - ai-core treats capabilities as opaque Record to avoid pulling tool-domain interfaces
 * - Composition root binds concrete capability implementations
 *
 * @see @cogni/ai-tools/capabilities for concrete interfaces
 */
export type ToolCapabilities = Record<string, unknown>;

// -----------------------------------------------------------------------------
// Tool Contract Runtime Types (minimal interface for tool-runner)
// -----------------------------------------------------------------------------

/**
 * Minimal schema interface for tool-runner.
 * Compatible with Zod schemas but doesn't require Zod import.
 */
export interface ParseableSchema {
  parse(input: unknown): unknown;
}

/**
 * Bound tool runtime interface.
 *
 * Per TOOL_SOURCE_RETURNS_BOUND_TOOL (TOOL_USE_SPEC.md #27):
 * This interface owns validation, execution, and redaction logic.
 * toolRunner orchestrates the pipeline but never imports Zod.
 *
 * Implementations live in @cogni/ai-tools (which has Zod).
 * ai-core only sees this semantic interface.
 */
export interface BoundToolRuntime {
  /** Namespaced tool ID (e.g., "core__get_current_time") */
  readonly id: string;

  /** Tool spec for LLM exposure (compiled from Zod, no runtime) */
  readonly spec: ToolSpec;

  /** Side-effect level for policy decisions */
  readonly effect: ToolEffect;

  /** Whether tool requires authenticated connection */
  readonly requiresConnection: boolean;

  /** Capability dependencies (e.g., ['auth', 'clock']) */
  readonly capabilities: readonly string[];

  // --- Method-based interface ---

  /**
   * Validate input args.
   * Throws validation error on failure (Zod stays in ai-tools).
   *
   * @param rawArgs - Raw arguments from LLM
   * @returns Validated and typed arguments
   * @throws ZodError or similar on validation failure
   */
  validateInput(rawArgs: unknown): unknown;

  /**
   * Execute tool with validated args, context, and capabilities.
   *
   * Per AUTH_VIA_CAPABILITY_INTERFACE: auth is provided via capabilities,
   * not via raw secrets in context.
   *
   * @param validatedArgs - Arguments validated by validateInput()
   * @param ctx - Invocation context (references only)
   * @param capabilities - Injected capabilities (auth, clock, etc.)
   * @returns Raw tool output (before validation/redaction)
   */
  exec(
    validatedArgs: unknown,
    ctx: ToolInvocationContext,
    capabilities: ToolCapabilities
  ): Promise<unknown>;

  /**
   * Validate output from tool execution.
   *
   * @param rawOutput - Output from exec()
   * @returns Validated output
   * @throws On validation failure
   */
  validateOutput(rawOutput: unknown): unknown;

  /**
   * Redact output for UI/telemetry.
   * Per REDACTION_REQUIRED: allowlist-based, missing fields stripped.
   *
   * @param validatedOutput - Output validated by validateOutput()
   * @returns Redacted output safe for UI/logs
   */
  redact(validatedOutput: unknown): unknown;
}

/**
 * Tool result from implementation (pre-redaction).
 * Structurally identical to ToolExecResult but semantically distinct layer.
 */
export type ToolResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly errorCode: ToolErrorCode;
      readonly safeMessage: string;
    };

// -----------------------------------------------------------------------------
// Tool Execution Types (canonical location per TOOL_EXEC_TYPES_IN_AI_CORE)
// -----------------------------------------------------------------------------

/**
 * Callback for emitting AiEvents during tool execution.
 * Used by tool-runner to stream events to runtime.
 * Per TOOL_EXEC_TYPES_IN_AI_CORE: canonical definition in @cogni/ai-core.
 */
export type EmitAiEvent = (event: AiEvent) => void;

/**
 * Tool execution result shape.
 * Per TOOLRUNNER_RESULT_SHAPE: exec() returns this discriminated union.
 */
export type ToolExecResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly errorCode: ToolErrorCode;
      readonly safeMessage: string;
    };

/**
 * Tool execution function signature.
 * Used by graphs to invoke tools via toolRunner.
 *
 * @param toolName - Namespaced tool name (e.g., "core:get_current_time")
 * @param args - Tool arguments (validated by caller)
 * @param toolCallId - Optional model-provided tool call ID
 * @returns Tool result with redacted value on success, error info on failure
 */
export type ToolExecFn = (
  toolName: string,
  args: unknown,
  toolCallId?: string
) => Promise<ToolExecResult<Record<string, unknown>>>;
