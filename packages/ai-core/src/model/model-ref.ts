// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-core/model/model-ref`
 * Purpose: Canonical model reference type for multi-provider LLM routing.
 * Scope: Defines ModelRef (provider + model + optional connection) and ModelCapabilities. Does not handle routing, billing, credential resolution, or provider-specific policy.
 * Invariants:
 *   - MODELREF_NO_POLICY: ModelRef is a pure reference, never carries requiresPlatformCredits/capabilities.
 *   - MODELREF_FULLY_RESOLVED: No defaulting at execution time. Schedules persist exact ModelRef.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/multi-provider-llm-routing
 * @public
 */

import { z } from "zod";

/**
 * Reference to a specific model on a specific provider.
 *
 * - providerKey: matches ModelProviderPort.providerKey (e.g., "platform", "codex", "ollama")
 * - modelId: provider-scoped model identifier (e.g., "gpt-4o", "codex-mini")
 * - connectionId: user's connection UUID (required when provider.requiresConnection is true)
 */
export interface ModelRef {
  readonly providerKey: string;
  readonly modelId: string;
  readonly connectionId?: string | undefined;
}

/** Zod schema for wire validation of ModelRef. */
export const ModelRefSchema = z.object({
  providerKey: z.string(),
  modelId: z.string(),
  connectionId: z.string().uuid().optional(),
});

/**
 * Capability flags for a model, used by catalog filtering.
 * These live on ModelOption (catalog) and ModelProviderPort, NOT on ModelRef.
 */
export interface ModelCapabilities {
  readonly streaming: boolean;
  readonly tools: boolean;
  readonly structuredOutput: boolean;
  readonly vision: boolean;
}

/** Zod schema for wire validation of ModelCapabilities. */
export const ModelCapabilitiesSchema = z.object({
  streaming: z.boolean(),
  tools: z.boolean(),
  structuredOutput: z.boolean(),
  vision: z.boolean(),
});
