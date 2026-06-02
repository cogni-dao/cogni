// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/ai/model-catalog.server`
 * Purpose: Server-side cache for LiteLLM model metadata with computed defaults and SWR.
 * Scope: Fetches /model/info, caches results, validates model IDs, computes defaults. Does not handle UI state.
 * Invariants: SWR cache, stale on errors, cold-start returns error. Defaults: tagged || fallback || null.
 * Side-effects: global (cache), IO (fetch every 1h)
 * Notes: Defaults from metadata.cogni tags. Extracts isFree, isZdr (Zero Data Retention) from model_info.
 * Links: /api/v1/ai/models route, chat route validation, https://openrouter.ai/docs/guides/features/zdr
 * @internal
 */

import { serverEnv } from "@/shared/env/server";
import { makeLogger } from "@/shared/observability";

const log = makeLogger({ module: "models-cache" });

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour (models change only on LiteLLM restart)

/**
 * Cogni-specific metadata for default model selection.
 * Stored in LiteLLM config as model_info.metadata.cogni.*
 */
interface CogniMeta {
  defaultPreferred?: boolean;
  defaultFree?: boolean;
}

/**
 * Internal model definition for catalog.
 * Decoupled from API contract to avoid circular dependencies.
 */
export interface ModelMeta {
  id: string;
  name?: string | undefined;
  isFree: boolean;
  isZdr: boolean;
  providerKey?: string | undefined;
  cogni?: CogniMeta | undefined;
}

export interface ModelsCatalog {
  models: ModelMeta[];
  defaults: {
    defaultPreferredModelId: string | null;
    defaultFreeModelId: string | null;
  };
}

interface CacheEntry {
  data: ModelsCatalog;
  timestamp: number;
}

let cache: CacheEntry | null = null;
let _refreshPromise: Promise<ModelsCatalog> | null = null;

/**
 * Transform LiteLLM /model/info response to our internal ModelMeta shape
 * Handles variant shapes: { data: [...] } or { models: [...] } or raw array
 * Item keys: model_name (preferred) or id
 */
function transformModelInfoResponse(data: unknown): ModelMeta[] {
  // Handle multiple wrapper formats
  let modelsList: unknown[];
  if (Array.isArray(data)) {
    modelsList = data;
  } else if (typeof data === "object" && data !== null) {
    const wrapper = data as { data?: unknown[]; models?: unknown[] };
    modelsList = wrapper.data ?? wrapper.models ?? [];
  } else {
    // Explicit error for unexpected shape
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
    .map((item): ModelMeta | null => {
      if (typeof item !== "object" || item === null) return null;

      // Prefer model_name, fallback to id
      const id =
        (item as { model_name?: string }).model_name ??
        (item as { id?: string }).id;

      // Drop malformed entries with no valid ID
      if (!id) return null;

      const modelInfo = ((item as Record<string, unknown>).model_info ??
        {}) as {
        display_name?: string;
        is_free?: boolean;
        is_zdr?: boolean;
        provider_key?: string;
        metadata?: {
          cogni?: { default_preferred?: boolean; default_free?: boolean };
        };
      };

      // Parse cogni metadata for default selection (only include defined properties)
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

      // Use model_info fields from LiteLLM config (no inference)
      return {
        id,
        name: modelInfo.display_name,
        isFree: modelInfo.is_free ?? false, // Default to paid if missing
        isZdr: modelInfo.is_zdr ?? false, // Default to non-ZDR if missing
        providerKey: modelInfo.provider_key,
        cogni,
      };
    })
    .filter((item): item is ModelMeta => item !== null);
}

/**
 * Compute default model IDs from catalog metadata tags.
 * Selection order (per policy):
 * - preferred: tagged_preferred || first_paid_by_id || first_by_id || null
 * - free: tagged_free || first_free_by_id || null
 *
 * Invariant: If tags missing/duplicated, emit ERROR/WARN + use deterministic fallback. Never throws.
 * Note: CI should enforce exactly one of each tag in litellm.config.yaml.
 */
function computeDefaults(models: ModelMeta[]): ModelsCatalog["defaults"] {
  if (models.length === 0) {
    log.error("Model catalog is empty, no defaults available");
    return { defaultPreferredModelId: null, defaultFreeModelId: null };
  }

  // Sort by id for deterministic fallback
  const sorted = [...models].sort((a, b) => a.id.localeCompare(b.id));
  const paidModels = sorted.filter((m) => !m.isFree);
  const freeModels = sorted.filter((m) => m.isFree);

  // Find tagged models
  const taggedPreferred = sorted.filter((m) => m.cogni?.defaultPreferred);
  const taggedFree = sorted.filter((m) => m.cogni?.defaultFree);

  // Emit ERROR if tags missing (CI should catch this, but runtime continues)
  if (taggedPreferred.length === 0) {
    log.error(
      { catalogSize: models.length, modelIds: sorted.map((m) => m.id) },
      "No model tagged as default_preferred - using fallback (check litellm.config.yaml)"
    );
  }
  if (taggedFree.length === 0 && freeModels.length > 0) {
    log.error(
      { freeModelIds: freeModels.map((m) => m.id) },
      "No model tagged as default_free - using fallback (check litellm.config.yaml)"
    );
  }

  // Warn if multiple tags (but don't throw)
  if (taggedPreferred.length > 1) {
    log.warn(
      { taggedIds: taggedPreferred.map((m) => m.id) },
      "Multiple models tagged as default_preferred, using first by id"
    );
  }
  if (taggedFree.length > 1) {
    log.warn(
      { taggedIds: taggedFree.map((m) => m.id) },
      "Multiple models tagged as default_free, using first by id"
    );
  }

  // Preferred: tagged || first_paid || first_by_id || null
  const defaultPreferredModelId =
    taggedPreferred[0]?.id ?? paidModels[0]?.id ?? sorted[0]?.id ?? null;

  // Free: tagged || first_free || null
  const defaultFreeModelId = taggedFree[0]?.id ?? freeModels[0]?.id ?? null;

  return { defaultPreferredModelId, defaultFreeModelId };
}

/**
 * Fetch models from LiteLLM /model/info endpoint
 * Throws on error - caller handles fallback to stale cache
 */
async function fetchModelsFromLiteLLM(): Promise<ModelsCatalog> {
  const masterKey = serverEnv().LITELLM_MASTER_KEY;

  // AbortController for timeout (compatible with Node 16+)
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(`${serverEnv().LITELLM_BASE_URL}/model/info`, {
      method: "GET",
      headers: masterKey ? { Authorization: `Bearer ${masterKey}` } : {},
      signal: controller.signal,
    });

    if (!response.ok) {
      // LOUD ERROR: Auth/config mistakes observable
      log.error(
        {
          status: response.status,
          baseUrl: serverEnv().LITELLM_BASE_URL,
          hasMasterKey: !!masterKey,
        },
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

    return {
      models,
      defaults: computeDefaults(models),
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Get cached models list with SWR (stale-while-revalidate)
 * - Returns cached data if fresh (< TTL)
 * - Returns stale data immediately + triggers background refresh if expired
 * - Throws on first call if LiteLLM unreachable (no cache, no fallback)
 */
export async function getCachedModels(): Promise<ModelsCatalog> {
  const now = Date.now();

  // Fresh cache hit
  if (cache && now - cache.timestamp < CACHE_TTL_MS) {
    return cache.data;
  }

  // Stale cache: return immediately + refresh in background
  if (cache) {
    const staleData = cache.data; // Capture for closure

    // Trigger background refresh if not already in progress
    _refreshPromise ??= fetchModelsFromLiteLLM()
      .then((data) => {
        cache = { data, timestamp: Date.now() };
        _refreshPromise = null;
        return data;
      })
      .catch((error) => {
        makeLogger({ module: "model-catalog" }).error(
          { err: error },
          "Background models refresh failed, serving stale cache"
        );
        _refreshPromise = null;
        // Serve stale cache
        return staleData;
      });
    return staleData; // Return stale immediately (SWR)
  }

  // No cache: blocking fetch (cold start)
  // If this fails, let it throw - caller returns 503
  const data = await fetchModelsFromLiteLLM();
  cache = { data, timestamp: now };
  return data;
}

/**
 * Check if a model ID is in the allowed list (fast, cached)
 */
/**
 * Known ChatGPT subscription model IDs (Codex transport).
 * TODO: Replace with a unified models API that returns models from all
 * connected backends (OpenRouter, ChatGPT, Ollama, etc.)
 */
const CHATGPT_MODEL_IDS = new Set([
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.2-codex",
  "gpt-5.1-codex",
  "gpt-5.1-codex-mini",
  "gpt-5.1-codex-max",
]);

export async function isModelAllowed(modelId: string): Promise<boolean> {
  // ChatGPT subscription models are always valid (validated at Codex exec time)
  if (CHATGPT_MODEL_IDS.has(modelId)) return true;

  try {
    const { models } = await getCachedModels();
    return models.some((m) => m.id === modelId);
  } catch (error) {
    // LOUD ERROR: Make allowlist failures observable
    log.error(
      { err: error, modelId },
      "Model allowlist unavailable, rejecting all models"
    );
    // If cache unavailable, reject all (fail-closed for security)
    return false;
  }
}

/**
 * Check if a model is free (fast, cached)
 * Returns false if model not found or cache unavailable (safe default)
 */
export async function isModelFree(modelId: string): Promise<boolean> {
  // ChatGPT subscription models are $0 platform cost
  if (CHATGPT_MODEL_IDS.has(modelId)) return true;

  try {
    const { models } = await getCachedModels();
    const model = models.find((m) => m.id === modelId);
    return model?.isFree ?? false;
  } catch (error) {
    log.error(
      { err: error, modelId },
      "Model cache unavailable for isModelFree check, defaulting to false (paid)"
    );
    return false;
  }
}

/**
 * Fast, non-blocking "is free?" check for hot paths.
 *
 * - Returns `null` if the catalog cache is not initialized yet (no I/O).
 * - Returns `false` for unknown models when cache exists (treat as paid).
 */
export function isModelFreeFromCache(modelId: string): boolean | null {
  if (CHATGPT_MODEL_IDS.has(modelId)) return true;
  if (!cache) return null;
  const model = cache.data.models.find((m) => m.id === modelId);
  return model?.isFree ?? false;
}

/**
 * Fast, non-blocking display name lookup for hot paths.
 *
 * - Returns the display name if the model is in the cached catalog.
 * - Returns `null` if the catalog cache is not initialized yet (no I/O).
 * - Returns `null` for unknown models when cache exists.
 */
export function getDisplayNameFromCache(modelId: string): string | null {
  if (!cache) return null;
  const model = cache.data.models.find((m) => m.id === modelId);
  return model?.name ?? null;
}

/**
 * Get computed default model IDs from catalog (fast, cached).
 * Returns null values if catalog unavailable.
 */
export async function getDefaults(): Promise<ModelsCatalog["defaults"]> {
  try {
    const { defaults } = await getCachedModels();
    return defaults;
  } catch (error) {
    log.error({ err: error }, "Model catalog unavailable for defaults");
    return { defaultPreferredModelId: null, defaultFreeModelId: null };
  }
}

/**
 * Pricing class for metrics labels (low cardinality).
 * Invariant: 'free' | 'standard' | 'premium' - exactly 3 values.
 */
export type ModelPricingClass = "free" | "standard" | "premium";

/**
 * Premium model patterns - expensive flagship models.
 * Covers: GPT-4, Claude Opus/Sonnet, Gemini Pro/Ultra, etc.
 */
const PREMIUM_PATTERNS = [
  /gpt-4(?!.*mini)/i, // GPT-4 but not GPT-4-mini
  /claude.*opus/i,
  /claude.*sonnet/i,
  /gemini.*pro/i,
  /gemini.*ultra/i,
  /o1(?!.*mini)/i, // o1 reasoning models
];

/**
 * Get model pricing class from catalog.
 * Derives from authoritative isFree property + pattern heuristics for premium tier.
 * Returns 'standard' for unknown models (safe default).
 *
 * @param modelId - The model identifier to classify
 * @returns 'free' | 'standard' | 'premium' for metrics label
 */
export async function getModelClass(
  modelId: string
): Promise<ModelPricingClass> {
  try {
    const { models } = await getCachedModels();
    const model = models.find((m) => m.id === modelId);

    // Authoritative: free tier from catalog
    if (model?.isFree) {
      return "free";
    }

    // Pattern-based: premium tier for expensive flagship models
    if (PREMIUM_PATTERNS.some((pattern) => pattern.test(modelId))) {
      return "premium";
    }

    // Default: standard tier (flash variants, mini models, haiku, etc.)
    return "standard";
  } catch {
    // Cache unavailable - use pattern matching only
    if (PREMIUM_PATTERNS.some((pattern) => pattern.test(modelId))) {
      return "premium";
    }
    return "standard";
  }
}
