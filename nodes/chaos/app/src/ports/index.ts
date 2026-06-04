// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports`
 * Purpose: Client-safe port facade — canonical import surface for port interfaces and errors.
 * Scope: Re-exports public port interfaces and error classes from local port files. Does NOT re-export packages with node: transitive deps (those live in @/ports/server). Does not contain implementations.
 * Invariants: Named exports only, no runtime coupling except error classes, no export *,
 *             no imports that transitively reach node: builtins.
 * Side-effects: none
 * Notes: Server-only ports (e.g. @cogni/scheduler-core) live in @/ports/server.
 *        See bug.0147 for the environment-safe split rationale.
 * Links: @/ports/server (server-only surface), .dependency-cruiser.cjs
 * @public
 */

export type { GraphId, ModelCapabilities, ModelRef } from "@cogni/ai-core";
export { ModelCapabilitiesSchema, ModelRefSchema } from "@cogni/ai-core";
export type {
  ExecutionContext,
  GraphExecutorPort,
  GraphFinal,
  GraphRunRequest,
  GraphRunResult,
  RunStreamEntry,
  RunStreamPort,
} from "@cogni/graph-execution-core";
export {
  RUN_STREAM_BLOCK_MS,
  RUN_STREAM_DEFAULT_TTL_SECONDS,
  RUN_STREAM_KEY_PREFIX,
  RUN_STREAM_MAXLEN,
} from "@cogni/graph-execution-core";
// Scheduling ports moved to @/ports/server — @cogni/scheduler-core uses node:util
// and contaminates client bundles via barrel re-export. Server-only consumers
// must import from "@/ports/server" instead.
export {
  type AccountService,
  type BillingAccount,
  BillingAccountNotFoundPortError,
  type ChargeReceiptParams,
  type ChargeReceiptProvenance,
  type CreditLedgerEntry,
  InsufficientCreditsPortError,
  isBillingAccountNotFoundPortError,
  isInsufficientCreditsPortError,
  isVirtualKeyNotFoundPortError,
  type ServiceAccountService,
  VirtualKeyNotFoundPortError,
} from "./accounts.port";
export type { AgentCatalogPort, AgentDescriptor } from "./agent-catalog.port";
export type {
  AiTelemetryPort,
  CreateTraceWithIOParams,
  InvocationStatus,
  LangfusePort,
  LangfuseSpanHandle,
  RecordInvocationParams,
} from "./ai-telemetry.port";
export type {
  AttributionEpoch,
  AttributionPoolComponent,
  AttributionSelection,
  AttributionStatement,
  AttributionStatementSignature,
  AttributionStore,
  EpochUserProjection,
  IngestionCursor,
  IngestionReceipt,
} from "./attribution-store.port";
export type {
  BillingContext,
  BillingResolver,
  PreflightCreditCheckFn,
} from "./billing-context";
export type { Clock } from "./clock.port";
export type {
  ConnectionBrokerPort,
  ConnectionScope,
  ResolvedConnection,
} from "./connection-broker.port";
export type {
  GovernanceRun,
  GovernanceStatusPort,
  UpcomingRun,
} from "./governance-status.port";
// LlmError types re-exported for adapters (adapters can only import from ports)
// Features should import directly from @/core
export {
  type AiExecutionErrorCode,
  type ChatDeltaEvent,
  type CompletionFinalResult,
  type CompletionStreamParams,
  classifyLlmErrorFromStatus,
  type GraphLlmCaller,
  isLlmError,
  type JsonSchemaObject,
  type LlmCaller,
  type LlmCompletionResult,
  LlmError,
  type LlmErrorKind,
  type LlmService,
  type LlmToolCall,
  type LlmToolCallDelta,
  type LlmToolChoice,
  type LlmToolDefinition,
  type Message,
  normalizeErrorToExecutionCode,
} from "./llm.port";
export type {
  InstantQueryParams,
  MetricsQueryPort,
  MetricTemplate,
  MetricWindow,
  PrometheusDataPoint,
  PrometheusInstantResult,
  PrometheusInstantValue,
  PrometheusRangeResult,
  PrometheusTimeSeries,
  RangeQueryParams,
  TemplateDataPoint,
  TemplateQueryParams,
  TemplateQueryResult,
  TemplateSummary,
} from "./metrics-query.port";
export type { ModelCatalogPort } from "./model-catalog.port";
export type {
  ModelOption,
  ModelProviderPort,
  ProviderContext,
} from "./model-provider.port";
export type { ModelProviderResolverPort } from "./model-provider-resolver.port";
export type {
  OnChainVerifier,
  VerificationResult,
  VerificationStatus,
} from "./onchain-verifier.port";
export type {
  OperatorWalletPort,
  TransferIntent,
} from "./operator-wallet.port";
export {
  type CreatePaymentAttemptParams,
  isPaymentAttemptNotFoundPortError,
  isTxHashAlreadyBoundPortError,
  type LogPaymentEventParams,
  type PaymentAttempt,
  PaymentAttemptNotFoundPortError,
  /** @deprecated Use PaymentAttemptUserRepository + PaymentAttemptServiceRepository */
  type PaymentAttemptRepository,
  type PaymentAttemptServiceRepository,
  type PaymentAttemptStatus,
  type PaymentAttemptUserRepository,
  type PaymentErrorCode,
  TxHashAlreadyBoundPortError,
} from "./payment-attempt.port";
export type {
  ProviderFundingContext,
  ProviderFundingOutcome,
  ProviderFundingPort,
} from "./provider-funding.port";
export type {
  ProxyBillingEntry,
  SandboxErrorCode,
  SandboxLlmProxyConfig,
  SandboxMount,
  SandboxNetworkMode,
  SandboxProgramContract,
  SandboxRunnerPort,
  SandboxRunResult,
  SandboxRunSpec,
  SandboxVolumeMount,
} from "./sandbox-runner.port";
// Ingestion ports - re-exported from @cogni/ingestion-core package
export type {
  ActivityEvent,
  CollectParams,
  CollectResult,
  DataSourceRegistration,
  PollAdapter,
  SourceAdapter,
  StreamCursor,
  StreamDefinition,
  WebhookNormalizer,
} from "./source-adapter.port";
export {
  ThreadConflictError,
  type ThreadPersistencePort,
  type ThreadSummary,
} from "./thread-persistence.port";
export type {
  EmitAiEvent,
  ToolEffect,
  ToolExecFn,
  ToolExecResult,
} from "./tool-exec.port";
export type {
  TokenBalance,
  TreasuryReadPort,
  TreasurySnapshot,
} from "./treasury-read.port";
export type {
  TreasurySettlementOutcome,
  TreasurySettlementPort,
} from "./treasury-settlement.port";
