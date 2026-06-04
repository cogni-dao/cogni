// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/ai/catalog/provider-resolver.adapter`
 * Purpose: ModelProviderResolverPort implementation — resolves providerKey to ModelProviderPort.
 * Scope: Runtime dispatch only. Used by graph executor factory and preflight credit check decorator.
 * Invariants:
 *   - RUNTIME_ONLY: Resolves providers, does not list models.
 *   - THROWS_ON_UNKNOWN: Unknown providerKey throws immediately (fail-fast).
 * Side-effects: none
 * Links: docs/spec/multi-provider-llm.md
 * @internal
 */

import type { ModelProviderPort, ModelProviderResolverPort } from "@/ports";

export class ProviderResolver implements ModelProviderResolverPort {
  private readonly byKey: Map<string, ModelProviderPort>;

  constructor(providers: ModelProviderPort[]) {
    this.byKey = new Map(providers.map((p) => [p.providerKey, p]));
  }

  resolve(providerKey: string): ModelProviderPort {
    const provider = this.byKey.get(providerKey);
    if (!provider) {
      throw new Error(
        `Unknown model provider: "${providerKey}". Registered: [${[...this.byKey.keys()].join(", ")}]`
      );
    }
    return provider;
  }
}
