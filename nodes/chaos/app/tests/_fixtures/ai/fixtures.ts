// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/_fixtures/ai/fixtures`
 * Purpose: Provides fixture loader for AI test data including models list response.
 * Scope: Loads and types static JSON fixtures for test consistency. Does not implement test logic or assertions.
 * Invariants: Returns typed data matching contract schemas. Fixtures are static.
 * Side-effects: none
 * Notes: Single source of truth for models list in all tests. Defaults computed from catalog metadata.cogni.* tags.
 * Links: models.response.json, @/contracts/ai.models.v1.contract
 * @internal
 */

import { aiModelsOperation, type ModelsOutput } from "@cogni/node-contracts";
import type { ModelsCatalog } from "@/shared/ai/model-catalog.server";
import modelsFixture from "./models.response.json";

/**
 * Load canonical models list fixture (static JSON)
 * @returns ModelsOutput with 7 models (5 free, 2 paid) and defaults
 * @throws If fixture doesn't match contract schema (catches drift early)
 */
export function loadModelsFixture(): ModelsOutput {
  // Validate via contract instead of casting - ensures test data matches production schema
  return aiModelsOperation.output.parse(modelsFixture);
}

/**
 * Internal ModelMeta models for catalog mocking (independent of wire-format fixture).
 * Mirrors the JSON fixture content in the internal ModelMeta shape.
 */
const CATALOG_MODELS: ModelsCatalog["models"] = [
  { id: "qwen3-4b", name: "Qwen 3 4B (Free)", isFree: true, isZdr: false },
  { id: "qwen3-235b", name: "Qwen 3 235B (Free)", isFree: true, isZdr: false },
  {
    id: "qwen3-coder",
    name: "Qwen 3 Coder (Free)",
    isFree: true,
    isZdr: false,
  },
  {
    id: "hermes-3-405b",
    name: "Hermes 3 405B (Free)",
    isFree: true,
    isZdr: false,
  },
  { id: "gpt-oss-20b", name: "GPT OSS 20B (Free)", isFree: true, isZdr: false },
  { id: "gpt-4o-mini", name: "GPT-4O Mini", isFree: false, isZdr: false },
  { id: "claude-3-haiku", name: "Claude 3 Haiku", isFree: false, isZdr: true },
  {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    isFree: false,
    isZdr: true,
  },
];

/**
 * Load models catalog for mocking getCachedModels (no defaults set - simulates untagged catalog)
 * Uses deterministic fallback for defaults (first by id)
 * @returns ModelsCatalog with models array and computed defaults
 */
export function loadModelsCatalogFixture(): ModelsCatalog {
  // Sort by id for deterministic fallback
  const sorted = [...CATALOG_MODELS].sort((a, b) => a.id.localeCompare(b.id));
  const paidModels = sorted.filter((m) => !m.isFree);
  const freeModels = sorted.filter((m) => m.isFree);

  return {
    models: CATALOG_MODELS,
    defaults: {
      // Deterministic fallback: first paid or first overall
      defaultPreferredModelId: paidModels[0]?.id ?? sorted[0]?.id ?? null,
      // First free model
      defaultFreeModelId: freeModels[0]?.id ?? null,
    },
  };
}

/**
 * Load models catalog with explicit default tags (simulates properly configured catalog)
 * @returns ModelsCatalog with models array and tagged defaults from fixture
 */
export function loadModelsCatalogWithDefaultsFixture(): ModelsCatalog {
  const DEFAULT_PREFERRED_ID = "gpt-4o-mini";
  const DEFAULT_FREE_ID = "qwen3-4b";

  return {
    models: CATALOG_MODELS.map((m) => ({
      ...m,
      // Add cogni metadata for tagged defaults
      cogni:
        m.id === DEFAULT_PREFERRED_ID
          ? { defaultPreferred: true }
          : m.id === DEFAULT_FREE_ID
            ? { defaultFree: true }
            : undefined,
    })),
    defaults: {
      defaultPreferredModelId: DEFAULT_PREFERRED_ID,
      defaultFreeModelId: DEFAULT_FREE_ID,
    },
  };
}

/**
 * Create models response with both free and paid models
 * @returns ModelsOutput for testing credit-based model selection
 */
export function createModelsWithFree(): ModelsOutput {
  const defaultCaps = {
    streaming: true,
    tools: false,
    structuredOutput: false,
    vision: false,
  };
  return {
    models: [
      {
        ref: { providerKey: "platform", modelId: "free-model-123" },
        label: "Free Model",
        requiresPlatformCredits: false,
        providerLabel: "Platform",
        capabilities: defaultCaps,
      },
      {
        ref: { providerKey: "platform", modelId: "paid-model-456" },
        label: "Paid Model",
        requiresPlatformCredits: true,
        providerLabel: "Platform",
        capabilities: defaultCaps,
      },
    ],
    defaultRef: { providerKey: "platform", modelId: "paid-model-456" },
  };
}

/**
 * Create models response with only paid models (no free models available)
 * @returns ModelsOutput for testing blocked state when user has zero credits
 */
export function createModelsPaidOnly(): ModelsOutput {
  return {
    models: [
      {
        ref: { providerKey: "platform", modelId: "gpt-5-nano" },
        label: "GPT-5 Nano",
        requiresPlatformCredits: true,
        providerLabel: "Platform",
        capabilities: {
          streaming: true,
          tools: true,
          structuredOutput: true,
          vision: false,
        },
      },
    ],
    defaultRef: { providerKey: "platform", modelId: "gpt-5-nano" },
  };
}

/**
 * Create models response with only Claude models (no OpenAI)
 * @returns ModelsOutput for testing that UI doesn't invent model IDs
 */
export function createModelsClaudeOnly(): ModelsOutput {
  const defaultCaps = {
    streaming: true,
    tools: true,
    structuredOutput: true,
    vision: false,
  };
  return {
    models: [
      {
        ref: { providerKey: "platform", modelId: "claude-haiku-free" },
        label: "Claude Haiku",
        requiresPlatformCredits: false,
        providerLabel: "Anthropic",
        capabilities: defaultCaps,
      },
      {
        ref: { providerKey: "platform", modelId: "claude-sonnet-paid" },
        label: "Claude Sonnet",
        requiresPlatformCredits: true,
        providerLabel: "Anthropic",
        capabilities: defaultCaps,
      },
    ],
    defaultRef: { providerKey: "platform", modelId: "claude-sonnet-paid" },
  };
}

/**
 * Create models response with multiple free models
 * @returns ModelsOutput for testing user choice preservation
 */
export function createModelsMultipleFree(): ModelsOutput {
  const defaultCaps = {
    streaming: true,
    tools: false,
    structuredOutput: false,
    vision: false,
  };
  return {
    models: [
      {
        ref: { providerKey: "platform", modelId: "gpt-4o-mini" },
        label: "GPT-4o Mini",
        requiresPlatformCredits: false,
        providerLabel: "Platform",
        capabilities: defaultCaps,
      },
      {
        ref: { providerKey: "platform", modelId: "claude-haiku" },
        label: "Claude Haiku",
        requiresPlatformCredits: false,
        providerLabel: "Platform",
        capabilities: defaultCaps,
      },
      {
        ref: { providerKey: "platform", modelId: "gpt-5-nano" },
        label: "GPT-5 Nano",
        requiresPlatformCredits: true,
        providerLabel: "Platform",
        capabilities: defaultCaps,
      },
    ],
    defaultRef: { providerKey: "platform", modelId: "gpt-5-nano" },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Graph Execution Fixtures
// ─────────────────────────────────────────────────────────────────────────────

import { vi } from "vitest";

import type { AgentCatalogProvider } from "@/adapters/server/ai/agent-catalog.provider";
import type {
  AgentDescriptor,
  GraphExecutorPort,
  GraphRunRequest,
} from "@/ports";

/**
 * Create a minimal GraphRunRequest for testing.
 * Default graphId is "langgraph:poet".
 */
export function createTestGraphRunRequest(
  overrides: Partial<GraphRunRequest> = {}
): GraphRunRequest {
  return {
    runId: "test-run-id",
    messages: [],
    modelRef: { providerKey: "platform", modelId: "test-model" },
    graphId: "langgraph:poet",
    ...overrides,
  };
}

/**
 * Create a mock GraphExecutorPort for execution tests.
 * Per SINGLE_EXECUTION_INTERFACE: only GraphExecutorPort owns runGraph().
 */
export function createMockGraphExecutor(): GraphExecutorPort {
  return {
    runGraph: vi.fn().mockReturnValue({
      stream: (async function* () {
        yield { type: "done" };
      })(),
      final: Promise.resolve({ ok: true, runId: "test", requestId: "test" }),
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent Catalog Fixtures (Discovery)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a mock AgentCatalogProvider for discovery tests.
 * Per P0_AGENT_GRAPH_IDENTITY: agentId === graphId.
 * Per DISCOVERY_SEPARATION: no canHandle — discovery is pure listAgents() fanout.
 */
export function createMockAgentCatalogProvider(
  providerId: string,
  agentNames: string[]
): AgentCatalogProvider {
  const agentDescriptors: AgentDescriptor[] = agentNames.map((agentName) => {
    const graphId = `${providerId}:${agentName}`;
    return {
      agentId: graphId, // P0: agentId === graphId
      graphId,
      name: agentName.charAt(0).toUpperCase() + agentName.slice(1),
      description: `Test ${agentName} agent`,
    };
  });

  return {
    providerId,
    listAgents: () => agentDescriptors,
  };
}
