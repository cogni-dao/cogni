// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-core`
 * Purpose: Barrel export for executor-agnostic AI primitives.
 * Scope: Re-exports all public types from submodules. Does NOT implement logic.
 * Invariants: SINGLE_SOURCE_OF_TRUTH - these are the canonical definitions.
 * Side-effects: none
 * Links: LANGGRAPH_SERVER.md, GRAPH_EXECUTION.md
 * @public
 */

// Billing types
export { SOURCE_SYSTEMS, type SourceSystem } from "./billing/source-system";
// Configurable types
export {
  AUTORESEARCH_RUN_SPEC_VERSION,
  AutoresearchMemoryLayerSchema,
  AutoresearchMutableSurfaceSchema,
  AutoresearchRewardSourceSchema,
  type AutoresearchRunSpec,
  AutoresearchRunSpecSchema,
  AutoresearchSelectionPolicySchema,
  AutoresearchStopCriterionSchema,
} from "./configurable/autoresearch-run-spec";
export {
  type GraphRunConfig,
  GraphRunConfigSchema,
  type PartialGraphRunConfig,
} from "./configurable/graph-run-config";
// Context types
export type { RunContext } from "./context/run-context";
// Event types
export type {
  AiEvent,
  AssistantFinalEvent,
  DoneEvent,
  ErrorEvent,
  RunFinalSummary,
  StatusEvent,
  TextDeltaEvent,
  ToolCallResultEvent,
  ToolCallStartEvent,
  UsageReportEvent,
} from "./events/ai-events";
// Execution types and utilities
export {
  AI_EXECUTION_ERROR_CODES,
  AiExecutionError,
  type AiExecutionErrorCode,
  isAiExecutionError,
  isAiExecutionErrorCode,
  normalizeErrorToExecutionCode,
} from "./execution/error-codes";
// LLM error types (thrown by adapters, classified by normalizer)
export {
  classifyLlmErrorFromStatus,
  isLlmError,
  LlmError,
  type LlmErrorKind,
} from "./execution/llm-errors";
// Graph types
export type { GraphId } from "./graph/graph-id";
// Message types (canonical LLM input/output)
export type {
  Message,
  MessageRole,
  MessageToolCall,
} from "./message/types";
// Model types
export type { ModelCapabilities, ModelRef } from "./model/model-ref";
export { ModelCapabilitiesSchema, ModelRefSchema } from "./model/model-ref";
// Span types (observability)
export type { AiSpanHandle, AiSpanPort } from "./tooling/ai-span";
// Tool source port
export type { ToolSourcePort } from "./tooling/ports/tool-source.port";
// Tool policy (runtime)
export {
  createToolAllowlistPolicy,
  DENY_ALL_POLICY,
  type ToolPolicy,
  type ToolPolicyContext,
  type ToolPolicyDecision,
} from "./tooling/runtime/tool-policy";
// Tool sources
export {
  createStaticToolSource,
  createStaticToolSourceFromRecord,
  StaticToolSource,
} from "./tooling/sources/static.source";
// Tool runner
export {
  createToolRunner,
  type ToolExecOptions,
  type ToolRunner,
  type ToolRunnerConfig,
} from "./tooling/tool-runner";
// Tooling types
// NOTE: Per FIX_LAYERING_CAPABILITY_TYPES, AuthCapability/ClockCapability are in @cogni/ai-tools
export type {
  BoundToolRuntime,
  EmitAiEvent,
  ParseableSchema,
  RedactionMode,
  ToolCapabilities,
  ToolEffect,
  ToolErrorCode,
  ToolExecFn,
  ToolExecResult,
  ToolInvocationContext,
  ToolInvocationRecord,
  ToolRedactionConfig,
  ToolResult,
  ToolSpec,
} from "./tooling/types";
// Usage types
export type { ExecutorType, UsageFact } from "./usage/usage";
export { UsageFactHintsSchema, UsageFactStrictSchema } from "./usage/usage";
