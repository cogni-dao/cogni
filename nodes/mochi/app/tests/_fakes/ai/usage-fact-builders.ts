// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/_fakes/ai/usage-fact-builders`
 * Purpose: Test data factories for UsageFact objects (strict + hints).
 * Scope: Creates minimal UsageFact test data for billing validation tests. Does not perform billing or schema validation.
 * Invariants: Builders produce schema-valid facts by default; override to test failures.
 * Side-effects: none
 * Links: packages/ai-core/src/usage/usage.ts, work/projects/proj.graph-execution.md
 * @public
 */

import type { UsageFact } from "@cogni/node-core";

/**
 * Create a valid UsageFact for billing-authoritative inproc executor.
 * Passes UsageFactStrictSchema by default.
 */
export function buildInprocUsageFact(
  overrides: Partial<UsageFact> = {}
): UsageFact {
  return {
    runId: "run-abc-123",
    attempt: 0,
    usageUnitId: "litellm-call-id-456",
    source: "litellm",
    executorType: "inproc",
    billingAccountId: "billing-acct-1",
    virtualKeyId: "vk-1",
    graphId: "langgraph:poet",
    model: "test-model",
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 0.005,
    ...overrides,
  };
}

/**
 * Create a valid UsageFact for billing-authoritative sandbox executor.
 * Passes UsageFactStrictSchema by default.
 */
export function buildSandboxUsageFact(
  overrides: Partial<UsageFact> = {}
): UsageFact {
  return buildInprocUsageFact({
    executorType: "sandbox",
    graphId: "sandbox:agent",
    ...overrides,
  });
}

/**
 * Create a valid UsageFact for BYO (codex/ollama) inproc executor.
 * Passes UsageFactStrictSchema. Uses deterministic usageUnitId and costUsd: 0.
 */
export function buildByoUsageFact(
  overrides: Partial<UsageFact> = {}
): UsageFact {
  return {
    runId: "run-abc-123",
    attempt: 0,
    usageUnitId: "run-abc-123/0/byo",
    source: "codex",
    executorType: "inproc",
    billingAccountId: "billing-acct-1",
    virtualKeyId: "vk-1",
    graphId: "langgraph:poet",
    model: "gpt-4o",
    inputTokens: 200,
    outputTokens: 80,
    costUsd: 0,
    ...overrides,
  };
}

/**
 * Create a valid UsageFact for external/telemetry executor (hints schema).
 * Passes UsageFactHintsSchema by default. usageUnitId intentionally omitted.
 */
export function buildExternalUsageFact(
  overrides: Partial<UsageFact> = {}
): UsageFact {
  return {
    runId: "run-abc-123",
    attempt: 0,
    source: "litellm",
    executorType: "langgraph_server",
    billingAccountId: "billing-acct-1",
    virtualKeyId: "vk-1",
    graphId: "langgraph:poet",
    ...overrides,
  };
}
