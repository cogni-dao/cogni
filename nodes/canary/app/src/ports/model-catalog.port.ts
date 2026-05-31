// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/model-catalog.port`
 * Purpose: Port interface for aggregated model listing across all providers.
 * Scope: Selection authority — UI and routes use this to list available models.
 *   Does NOT handle runtime dispatch (that's ModelProviderResolverPort).
 * Invariants:
 *   - SELECTION_ONLY: This port lists models. It does not create LlmServices or check billing policy.
 * Side-effects: none (interface only)
 * Links: docs/spec/multi-provider-llm.md
 * @public
 */

import type { ModelCapabilities, ModelRef } from "@cogni/ai-core";

import type { ModelOption } from "./model-provider.port";

/**
 * Aggregated model catalog — lists models from all registered providers.
 * Consumed by UI routes for model selection.
 */
export interface ModelCatalogPort {
  listModels(params: {
    userId: string;
    tenantId: string;
    requiredCapabilities?: Partial<ModelCapabilities>;
  }): Promise<{ models: ModelOption[]; defaultRef: ModelRef | null }>;
}
