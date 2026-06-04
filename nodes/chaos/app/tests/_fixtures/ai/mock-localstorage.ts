// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/_fixtures/ai/mock-localstorage`
 * Purpose: Provides localStorage mocking utilities for testing browser storage error resilience.
 * Scope: Creates controllable localStorage mocks for normal operation and error scenarios (Safari private mode, quota exceeded). Does not implement actual storage logic.
 * Invariants: Mocks are deterministic and isolated per test.
 * Side-effects: global (modifies window.localStorage for test environment)
 * Notes: Use mockLocalStorageNormal() for happy path tests, mockLocalStorageToThrow() for error resilience tests.
 * Links: Used by model-preference.test.ts
 * @internal
 */

import { vi } from "vitest";

/**
 * Mock localStorage to throw errors (simulates Safari private mode, quota exceeded)
 * Use this to test error resilience in localStorage utilities
 */
export function mockLocalStorageToThrow(): void {
  const throwingStorage = {
    getItem: vi.fn(() => {
      throw new Error("localStorage access denied");
    }),
    setItem: vi.fn(() => {
      throw new Error("localStorage quota exceeded");
    }),
    removeItem: vi.fn(() => {
      throw new Error("localStorage access denied");
    }),
    clear: vi.fn(),
    length: 0,
    key: vi.fn(),
  };

  Object.defineProperty(window, "localStorage", {
    value: throwingStorage,
    writable: true,
    configurable: true,
  });
}

/**
 * Mock localStorage with in-memory storage for normal tests
 * Provides working localStorage implementation for happy path testing
 */
export function mockLocalStorageNormal(): void {
  const store = new Map<string, string>();

  const normalStorage = {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => void store.set(key, value)),
    removeItem: vi.fn((key: string) => void store.delete(key)),
    clear: vi.fn(() => store.clear()),
    length: 0,
    key: vi.fn(),
  };

  Object.defineProperty(window, "localStorage", {
    value: normalStorage,
    writable: true,
    configurable: true,
  });
}
