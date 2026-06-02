// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/ai/providers/platform.provider`
 * Purpose: ModelProviderPort implementation for platform LiteLLM models.
 * Scope: Lists chat models from LiteLLM /model/info, creates LlmService from singleton, checks isFree for credits.
 *   Ported from model-catalog.server.ts — same SWR cache, same transform, same defaults logic.
 * Invariants:
 *   - SWR cache with 1h TTL
 *   - requiresPlatformCredits inverts isFree from catalog metadata
 *   - Non-chat models (embedding, image_generation) filtered out via LiteLLM mode field
 * Side-effects: global (cache), IO (fetch to LiteLLM)
 * Links: docs/spec/multi-provider-llm.md
 * @internal
 */

import type { ModelRef } from "@cogni/ai-core";
import type {
  LlmService,
  ModelOption,
  ModelProviderPort,
  ProviderContext,
  ResolvedConnection,
} from "@/ports";
import { serverEnv } from "@/shared/env/server";
import { makeLogger } from "@/shared/observability";

const log = makeLogger({ module: "platform-provider" });

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Cogni metadata tags from LiteLLM model_info.metadata.cogni.* */
interface CogniMeta {
  defaultPreferred?: boolean;
  defaultFree?: boolean;
}

/** Internal model from LiteLLM (before mapping to ModelOption) */
interface LiteLlmModelMeta {
  id: string;
  name?: string | undefined;
  isFree: boolean;
  providerKey?: string | undefined;
  cogni?: CogniMeta | undefined;
}

interface CacheEntry {
  models: LiteLlmModelMeta[];
  timestamp: number;
}

/**
 * Platform model provider — backed by LiteLLM/OpenRouter.
 * Implements ModelProviderPort for the "platform" providerKey.
 */
export class PlatformModelProvider implements ModelProviderPort {
  readonly providerKey = "platform" as const;
  readonly usageSource = "litellm" as const;
  readonly requiresConnection = false;

  private cache: CacheEntry | null = null;
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: used via ??= assignment
  private refreshPromise: Promise<LiteLlmModelMeta[]> | null = null;

  constructor(private readonly llmService: LlmService) {}

  async listModels(_ctx: ProviderContext): Promise<ModelOption[]> {
    const models = await this.getCachedModels();
    return models.map((m) => ({
      ref: { providerKey: this.providerKey, modelId: m.id },
      label: m.name ?? m.id,
      requiresPlatformCredits: !m.isFree,
      providerLabel: "Platform",
      capabilities: {
        streaming: true,
        tools: true,
        structuredOutput: true,
        vision: false,
      },
    }));
  }

  createLlmService(_connection?: ResolvedConnection): LlmService {
    return this.llmService;
  }

  async requiresPlatformCredits(ref: ModelRef): Promise<boolean> {
    try {
      const models = await this.getCachedModels();
      const model = models.find((m) => m.id === ref.modelId);
      return model ? !model.isFree : true; // Unknown = paid (fail-closed)
    } catch {
      return true; // Cache unavailable = paid (fail-closed)
    }
  }

  /**
   * Get the tagged default model ref, or fallback.
   * Used by the aggregating catalog to compute defaultRef.
   */
  async getDefaultRef(): Promise<ModelRef | null> {
    try {
      const models = await this.getCachedModels();
      if (models.length === 0) return null;

      const sorted = [...models].sort((a, b) => a.id.localeCompare(b.id));
      const taggedPreferred = sorted.find((m) => m.cogni?.defaultPreferred);
      const firstPaid = sorted.find((m) => !m.isFree);
      const pick = taggedPreferred ?? firstPaid ?? sorted[0];
      return pick ? { providerKey: this.providerKey, modelId: pick.id } : null;
    } catch {
      return null;
    }
  }

  // ── SWR cache (ported from model-catalog.server.ts) ─────────────────

  private async getCachedModels(): Promise<LiteLlmModelMeta[]> {
    const now = Date.now();

    if (this.cache && now - this.cache.timestamp < CACHE_TTL_MS) {
      return this.cache.models;
    }

    if (this.cache) {
      const stale = this.cache.models;
      this.refreshPromise ??= this.fetchModels()
        .then((models) => {
          this.cache = { models, timestamp: Date.now() };
          this.refreshPromise = null;
          return models;
        })
        .catch((error) => {
          log.error(
            { err: error },
            "Background models refresh failed, serving stale cache"
          );
          this.refreshPromise = null;
          return stale;
        });
      return stale;
    }

    const models = await this.fetchModels();
    this.cache = { models, timestamp: now };
    return models;
  }

  private async fetchModels(): Promise<LiteLlmModelMeta[]> {
    const masterKey = serverEnv().LITELLM_MASTER_KEY;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
      const response = await fetch(
        `${serverEnv().LITELLM_BASE_URL}/model/info`,
        {
          method: "GET",
          headers: masterKey ? { Authorization: `Bearer ${masterKey}` } : {},
          signal: controller.signal,
        }
      );

      if (!response.ok) {
        log.error(
          { status: response.status, baseUrl: serverEnv().LITELLM_BASE_URL },
          "LiteLLM /model/info request failed"
        );
        throw new Error(`LiteLLM /model/info returned ${response.status}`);
      }

      const data = await response.json();
      const models = transformModelInfoResponse(data);

      if (models.length === 0) {
        log.error("LiteLLM /model/info returned empty list");
        throw new Error("LiteLLM returned no models");
      }

      return models;
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ── Transform (ported verbatim from model-catalog.server.ts) ──────────

function transformModelInfoResponse(data: unknown): LiteLlmModelMeta[] {
  let modelsList: unknown[];
  if (Array.isArray(data)) {
    modelsList = data;
  } else if (typeof data === "object" && data !== null) {
    const wrapper = data as { data?: unknown[]; models?: unknown[] };
    modelsList = wrapper.data ?? wrapper.models ?? [];
  } else {
    log.error(
      { responseType: typeof data },
      "LiteLLM /model/info unexpected response shape"
    );
    throw new Error(
      `LiteLLM /model/info returned unexpected shape (type: ${typeof data})`
    );
  }

  if (!Array.isArray(modelsList)) {
    log.error({ modelsList }, "LiteLLM /model/info wrapper missing array");
    throw new Error("LiteLLM /model/info response missing models array");
  }

  return modelsList
    .map((item): LiteLlmModelMeta | null => {
      if (typeof item !== "object" || item === null) return null;

      const id =
        (item as { model_name?: string }).model_name ??
        (item as { id?: string }).id;
      if (!id) return null;

      const modelInfo = ((item as Record<string, unknown>).model_info ??
        {}) as {
        display_name?: string;
        is_free?: boolean;
        provider_key?: string;
        mode?: string;
        metadata?: {
          cogni?: { default_preferred?: boolean; default_free?: boolean };
        };
      };

      // Skip non-chat models (embeddings, image generation, etc.)
      if (modelInfo.mode && modelInfo.mode !== "chat") return null;

      const cogniSource = modelInfo.metadata?.cogni;
      const cogni: CogniMeta | undefined = cogniSource
        ? {
            ...(cogniSource.default_preferred !== undefined && {
              defaultPreferred: cogniSource.default_preferred,
            }),
            ...(cogniSource.default_free !== undefined && {
              defaultFree: cogniSource.default_free,
            }),
          }
        : undefined;

      return {
        id,
        name: modelInfo.display_name,
        isFree: modelInfo.is_free ?? false,
        providerKey: modelInfo.provider_key,
        cogni,
      };
    })
    .filter((item): item is LiteLlmModelMeta => item !== null);
}
