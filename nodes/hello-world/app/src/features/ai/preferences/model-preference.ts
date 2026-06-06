// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/ai/preferences/model-preference`
 * Purpose: Provides localStorage persistence for selected AI model preference.
 * Scope: Client-side preference storage with SSR-safe access and validation utilities. Does not implement UI or state management (pure storage utilities).
 * Invariants: All operations wrapped in try/catch, graceful degradation on errors.
 * Side-effects: global (localStorage, may fail in Safari private mode or quota exceeded)
 * Notes: Client-only module - do not import in server components.
 * Links: Used by ChatComposerExtras
 * @internal
 */

import { clientLogger, EVENT_NAMES } from "@cogni/node-shared";

const STORAGE_KEY = "cogni.chat.preferredModelId";

/**
 * Read preferred model ID from localStorage
 * Returns null if not set or on error (SSR, private mode, quota)
 */
export function getPreferredModelId(): string | null {
  // SSR guard
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored;
  } catch (error) {
    // Safari private mode, quota exceeded, permissions denied
    clientLogger.warn(EVENT_NAMES.CLIENT_AI_MODEL_PREF_READ_FAIL, {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Write preferred model ID to localStorage
 * Fails silently on error (no user-facing disruption)
 */
export function setPreferredModelId(modelId: string): void {
  // SSR guard
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(STORAGE_KEY, modelId);
  } catch (error) {
    // Safari private mode, quota exceeded, permissions denied
    clientLogger.warn(EVENT_NAMES.CLIENT_AI_MODEL_PREF_WRITE_FAIL, {
      error: error instanceof Error ? error.message : String(error),
    });
    // Fail silently - user can still use model selection, just won't persist
  }
}

/**
 * Remove preferred model ID from localStorage
 */
export function clearPreferredModelId(): void {
  // SSR guard
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    clientLogger.warn(EVENT_NAMES.CLIENT_AI_MODEL_PREF_CLEAR_FAIL, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Validate stored preference against available models
 * Returns the stored model if valid, otherwise returns defaultModelId and clears storage
 */
export function validatePreferredModel(
  availableModelIds: string[],
  defaultModelId: string
): string {
  const stored = getPreferredModelId();

  if (!stored) {
    return defaultModelId;
  }

  if (availableModelIds.includes(stored)) {
    return stored;
  }

  // Stored model no longer available - clear it
  clientLogger.warn(EVENT_NAMES.CLIENT_AI_MODEL_PREF_INVALID, {
    storedModel: stored,
    availableModels: availableModelIds,
    defaultModelId,
  });
  clearPreferredModelId();
  return defaultModelId;
}
