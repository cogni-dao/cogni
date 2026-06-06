// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * @vitest-environment jsdom
 *
 * Module: `@tests/unit/features/ai/preferences/model-preference`
 * Purpose: Validates localStorage preferences utilities for model selection persistence and error resilience.
 * Scope: Tests get/set/clear operations and validation logic. Does not test UI integration or API calls.
 * Invariants: All localStorage operations gracefully degrade on errors (Safari private mode, quota exceeded).
 * Side-effects: global (mocked localStorage in test environment)
 * Notes: Critical for Safari private mode resilience - users must not experience crashes.
 * Links: @/features/ai/preferences/model-preference, @tests/_fixtures/ai/mock-localstorage
 * @internal
 */

import {
  mockLocalStorageNormal,
  mockLocalStorageToThrow,
} from "@tests/_fixtures/ai/mock-localstorage";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPreferredModelId,
  getPreferredModelId,
  setPreferredModelId,
  validatePreferredModel,
} from "@/features/ai/preferences/model-preference";

describe("model-preference localStorage utilities", () => {
  beforeEach(() => {
    // Default: working localStorage
    mockLocalStorageNormal();
    vi.clearAllMocks();
  });

  describe("happy path - normal localStorage", () => {
    it("should roundtrip get/set/clear", () => {
      // Arrange & Act - Set preference
      setPreferredModelId("qwen3-4b");

      // Assert - Get returns value
      expect(getPreferredModelId()).toBe("qwen3-4b");

      // Act - Clear preference
      clearPreferredModelId();

      // Assert - Get returns null
      expect(getPreferredModelId()).toBeNull();
    });

    it("should return null when no preference set", () => {
      // Act
      const result = getPreferredModelId();

      // Assert
      expect(result).toBeNull();
    });

    it("should overwrite existing preference", () => {
      // Arrange
      setPreferredModelId("gpt-4o-mini");

      // Act - Overwrite
      setPreferredModelId("claude-3-haiku");

      // Assert
      expect(getPreferredModelId()).toBe("claude-3-haiku");
    });
  });

  describe("error resilience - localStorage throws", () => {
    it("should return null when getItem throws", () => {
      // Arrange
      mockLocalStorageToThrow();
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      // Act
      const result = getPreferredModelId();

      // Assert - No crash, returns null
      expect(result).toBeNull();
      expect(consoleSpy).toHaveBeenCalledWith(
        "[CLIENT] WARN client.ai.model_pref_read_fail",
        expect.stringContaining('"error"')
      );

      consoleSpy.mockRestore();
    });

    it("should not crash when setItem throws", () => {
      // Arrange
      mockLocalStorageToThrow();
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      // Act & Assert - No crash
      expect(() => setPreferredModelId("qwen3-4b")).not.toThrow();
      expect(consoleSpy).toHaveBeenCalledWith(
        "[CLIENT] WARN client.ai.model_pref_write_fail",
        expect.stringContaining('"error"')
      );

      consoleSpy.mockRestore();
    });

    it("should not crash when removeItem throws", () => {
      // Arrange
      mockLocalStorageToThrow();
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      // Act & Assert - No crash
      expect(() => clearPreferredModelId()).not.toThrow();
      expect(consoleSpy).toHaveBeenCalledWith(
        "[CLIENT] WARN client.ai.model_pref_clear_fail",
        expect.stringContaining('"error"')
      );

      consoleSpy.mockRestore();
    });
  });

  describe("SSR safety", () => {
    it("should return null when window is undefined", () => {
      // Arrange - Simulate SSR by making window undefined
      const originalWindow = global.window;
      // @ts-expect-error - Testing SSR scenario
      delete global.window;

      // Act
      const result = getPreferredModelId();

      // Assert
      expect(result).toBeNull();

      // Cleanup
      global.window = originalWindow;
    });

    it("should not crash on set when window is undefined", () => {
      // Arrange
      const originalWindow = global.window;
      // @ts-expect-error - Testing SSR scenario
      delete global.window;

      // Act & Assert - No crash
      expect(() => setPreferredModelId("qwen3-4b")).not.toThrow();

      // Cleanup
      global.window = originalWindow;
    });
  });

  describe("validatePreferredModel", () => {
    it("should return stored model when valid", () => {
      // Arrange
      setPreferredModelId("qwen3-4b");
      const availableModelIds = ["qwen3-4b", "gpt-4o-mini", "claude-3-haiku"];
      const defaultModelId = "gpt-4o-mini";

      // Act
      const result = validatePreferredModel(availableModelIds, defaultModelId);

      // Assert
      expect(result).toBe("qwen3-4b");
    });

    it("should return default when no preference stored", () => {
      // Arrange
      const availableModelIds = ["qwen3-4b", "gpt-4o-mini"];
      const defaultModelId = "gpt-4o-mini";

      // Act
      const result = validatePreferredModel(availableModelIds, defaultModelId);

      // Assert
      expect(result).toBe("gpt-4o-mini");
    });

    it("should return default and clear storage when stored model not in list", () => {
      // Arrange
      setPreferredModelId("removed-model");
      const availableModelIds = ["qwen3-4b", "gpt-4o-mini"];
      const defaultModelId = "gpt-4o-mini";
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      // Act
      const result = validatePreferredModel(availableModelIds, defaultModelId);

      // Assert - Returns default
      expect(result).toBe("gpt-4o-mini");

      // Assert - Cleared from storage
      expect(getPreferredModelId()).toBeNull();

      // Assert - Warning logged
      expect(consoleSpy).toHaveBeenCalledWith(
        "[CLIENT] WARN client.ai.model_pref_invalid",
        expect.stringContaining('"storedModel":"removed-model"')
      );

      consoleSpy.mockRestore();
    });

    it("should return default when localStorage throws", () => {
      // Arrange
      mockLocalStorageToThrow();
      const availableModelIds = ["qwen3-4b", "gpt-4o-mini"];
      const defaultModelId = "gpt-4o-mini";
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      // Act
      const result = validatePreferredModel(availableModelIds, defaultModelId);

      // Assert - Graceful fallback to default
      expect(result).toBe("gpt-4o-mini");

      consoleSpy.mockRestore();
    });
  });
});
