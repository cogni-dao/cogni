// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/graph-execution-host`
 * Purpose: Shared decorator and routing infrastructure for graph execution.
 * Scope: PURE_LIBRARY — decorators, router, and port interfaces. Does not access env vars, process lifecycle, or @/ imports.
 * Invariants:
 *   - PURE_LIBRARY: No env vars, no process lifecycle, no @/ imports
 *   - NO_SRC_IMPORTS: Never imports @/ or src/ paths
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/package-isolation-rules, https://node-template.cognidao.org/knowledge/graph-execution-invariants
 * @public
 */

// --- Decorators ---
export { BillingEnrichmentGraphExecutorDecorator } from "./decorators/billing-enrichment.decorator";
export {
  type ObservabilityDecoratorConfig,
  ObservabilityGraphExecutorDecorator,
} from "./decorators/observability-executor.decorator";
export { PreflightCreditCheckDecorator } from "./decorators/preflight-credit-check.decorator";
export { UsageCommitDecorator } from "./decorators/usage-commit.decorator";
// --- Port interfaces ---
export type { BillingIdentity } from "./ports/billing-identity";
export type { CommitUsageFactFn } from "./ports/commit-usage-fact";
export type { LoggerPort } from "./ports/logger.port";
export type {
  PlatformCreditChecker,
  PreflightCreditCheckFn,
} from "./ports/preflight-credit-check";
export type {
  CreateTraceWithIOParams,
  GetTraceIdFn,
  TracingPort,
} from "./ports/tracing.port";

// --- Routing ---
export { NamespaceGraphRouter } from "./routing/namespace-graph-router";
