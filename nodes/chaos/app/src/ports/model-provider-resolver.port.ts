// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/model-provider-resolver.port`
 * Purpose: Port interface for runtime provider resolution.
 * Scope: Runtime dispatch authority — executor and preflight decorator use this to resolve
 *   a providerKey to its ModelProviderPort. Does NOT handle model listing (that's ModelCatalogPort).
 * Invariants:
 *   - RUNTIME_ONLY: This port resolves providers for execution. It does not list models.
 * Side-effects: none (interface only)
 * Links: docs/spec/multi-provider-llm.md
 * @public
 */

import type { ModelProviderPort } from "./model-provider.port";

/**
 * Resolves a providerKey to its ModelProviderPort at runtime.
 * Consumed by graph executor factory and preflight credit check decorator.
 *
 * @throws if providerKey is not registered
 */
export interface ModelProviderResolverPort {
  resolve(providerKey: string): ModelProviderPort;
}
