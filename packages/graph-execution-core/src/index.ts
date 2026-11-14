// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/graph-execution-core`
 * Purpose: Barrel export for run lifecycle and orchestration contracts.
 * Scope: Re-exports all public types from submodules. Does not implement logic or carry billing/tracing concerns.
 * Invariants: NO_BILLING_LEAKAGE, NO_TRACING_LEAKAGE, AI_CORE_ONLY_DEP
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/graph-run-launch-contract
 * @public
 */

// Execution context
export type { ExecutionContext } from "./execution-context";
// Graph executor port
export type {
  GraphExecutorPort,
  GraphFinal,
  GraphRunRequest,
  GraphRunResult,
} from "./graph-executor.port";
export type { RunStreamEntry, RunStreamPort } from "./run-stream.port";
// Run stream port
export {
  RUN_STREAM_BLOCK_MS,
  RUN_STREAM_DEFAULT_TTL_SECONDS,
  RUN_STREAM_KEY_PREFIX,
  RUN_STREAM_MAXLEN,
} from "./run-stream.port";
