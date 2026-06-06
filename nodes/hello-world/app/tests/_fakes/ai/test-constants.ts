// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/_fakes/ai/test-constants`
 * Purpose: Centralized AI test constants for consistent, deterministic tests.
 * Scope: Single source of truth for model IDs and test data. Does NOT contain runtime logic.
 * Invariants: Stable values across test runs; no env/config coupling.
 * Side-effects: none
 * Notes: Use TEST_MODEL_ID in all tests requiring a model parameter.
 * Links: Used across unit/integration/contract tests
 * @public
 */

/**
 * Canonical test model ID
 * Use this in ALL tests requiring a model parameter
 */
export const TEST_MODEL_ID = "test-model";

/**
 * Canonical test graph name
 * Use this in ALL tests requiring a graphName parameter (required since P0.75)
 * Per GRAPH_ID_NAMESPACED: format is ${providerId}:${graphName}
 */
export const TEST_GRAPH_NAME = "langgraph:poet";
export const TEST_GRAPH_NAME_2 = "sandbox:agent";

/**
 * Alternative models for multi-model test scenarios
 */
export const TEST_MODEL_FREE = "test-free-model";
export const TEST_MODEL_PAID = "test-paid-model";

/**
 * Mock models list for validation tests
 */
export const TEST_MODELS_LIST = [
  { id: TEST_MODEL_ID, name: "Test Model", isFree: false },
  { id: TEST_MODEL_FREE, name: "Free Test Model", isFree: true },
  { id: TEST_MODEL_PAID, name: "Paid Test Model", isFree: false },
];
