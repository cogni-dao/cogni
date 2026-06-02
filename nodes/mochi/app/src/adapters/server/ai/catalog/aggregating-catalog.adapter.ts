// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/ai/catalog/aggregating-catalog.adapter`
 * Purpose: ModelCatalogPort implementation that aggregates models from all providers.
 * Scope: Calls each provider's listModels(), merges results, applies capability filter,
 *   computes defaultRef. Selection authority only — does not create LlmServices.
 * Invariants:
 *   - SELECTION_ONLY: This adapter lists models. Runtime dispatch is separate (ProviderResolver).
 * Side-effects: IO (delegates to providers which may fetch from external APIs)
 * Links: docs/spec/multi-provider-llm.md
 * @internal
 */

import type { ModelCapabilities, ModelRef } from "@cogni/ai-core";
import type { ModelCatalogPort, ModelOption, ModelProviderPort } from "@/ports";
import { makeLogger } from "@/shared/observability";

const log = makeLogger({ module: "model-catalog" });

export class AggregatingModelCatalog implements ModelCatalogPort {
  constructor(private readonly providers: ModelProviderPort[]) {}

  async listModels(params: {
    userId: string;
    tenantId: string;
    requiredCapabilities?: Partial<ModelCapabilities>;
  }): Promise<{ models: ModelOption[]; defaultRef: ModelRef | null }> {
    const ctx = { userId: params.userId, tenantId: params.tenantId };
    const requiredCapabilities = params.requiredCapabilities;

    // Fetch from all providers in parallel
    const results = await Promise.allSettled(
      this.providers.map((p) => p.listModels(ctx))
    );

    const models: ModelOption[] = [];
    for (const [i, result] of results.entries()) {
      if (result.status === "fulfilled") {
        models.push(...result.value);
      } else {
        log.error(
          { err: result.reason, providerKey: this.providers[i]?.providerKey },
          "Provider failed to list models"
        );
      }
    }

    // Apply capability filter
    const filtered = requiredCapabilities
      ? models.filter((m) =>
          matchesCapabilities(m.capabilities, requiredCapabilities)
        )
      : models;

    // Compute default: use platform provider's tagged default, or first model
    const defaultRef = await this.computeDefaultRef(filtered);

    return { models: filtered, defaultRef };
  }

  private async computeDefaultRef(
    models: ModelOption[]
  ): Promise<ModelRef | null> {
    // Try provider with getDefaultRef() (e.g., platform provider's tagged default)
    for (const provider of this.providers) {
      if (
        "getDefaultRef" in provider &&
        typeof provider.getDefaultRef === "function"
      ) {
        const tagged = await (
          provider.getDefaultRef as () => Promise<ModelRef | null>
        )();
        if (
          tagged &&
          models.some(
            (m) =>
              m.ref.modelId === tagged.modelId &&
              m.ref.providerKey === tagged.providerKey
          )
        ) {
          return tagged;
        }
      }
    }

    // Fallback: first model in list
    return models[0]?.ref ?? null;
  }
}

function matchesCapabilities(
  actual: ModelCapabilities,
  required: Partial<ModelCapabilities>
): boolean {
  if (required.streaming && !actual.streaming) return false;
  if (required.tools && !actual.tools) return false;
  if (required.structuredOutput && !actual.structuredOutput) return false;
  if (required.vision && !actual.vision) return false;
  return true;
}
