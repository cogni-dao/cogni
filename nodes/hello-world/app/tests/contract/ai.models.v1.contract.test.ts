// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/ai.models.v1.contract`
 * Purpose: Validates models list fixture matches ai.models.v1 contract schema.
 * Scope: Tests Zod schema compliance for models list response. Does not test API endpoint behavior or caching logic.
 * Invariants: Fixture must parse via contract schema without errors; all required fields present.
 * Side-effects: none
 * Notes: Prevents contract drift between fixture and production schema.
 * Links: @/contracts/ai.models.v1.contract, @tests/_fixtures/ai/models.response.json
 * @internal
 */

import { aiModelsOperation } from "@cogni/node-contracts";
import { loadModelsFixture } from "@tests/_fixtures/ai/fixtures";
import { describe, expect, it } from "vitest";

describe("ai.models.v1 contract validation", () => {
  it("should parse fixture via contract schema without errors", () => {
    // Arrange
    const fixture = loadModelsFixture();

    // Act & Assert - Parse should not throw
    expect(() => aiModelsOperation.output.parse(fixture)).not.toThrow();
  });

  it("should have required top-level fields", () => {
    // Arrange
    const fixture = loadModelsFixture();

    // Assert
    expect(fixture).toHaveProperty("models");
    expect(fixture).toHaveProperty("defaultRef");
    // defaultRef is nullable - fixture has a default from JSON
    expect(fixture.defaultRef).toBeTruthy();
    if (fixture.defaultRef !== null) {
      expect(fixture.defaultRef).toHaveProperty("providerKey");
      expect(fixture.defaultRef).toHaveProperty("modelId");
    }
  });

  it("should have non-empty models array", () => {
    // Arrange
    const fixture = loadModelsFixture();

    // Assert
    expect(Array.isArray(fixture.models)).toBe(true);
    expect(fixture.models.length).toBeGreaterThan(0);
  });

  it("should have required fields on each model", () => {
    // Arrange
    const fixture = loadModelsFixture();

    // Assert - Each model has ref, label, requiresPlatformCredits, providerLabel, capabilities
    for (const model of fixture.models) {
      expect(model).toHaveProperty("ref");
      expect(model.ref).toHaveProperty("providerKey");
      expect(model.ref).toHaveProperty("modelId");
      expect(typeof model.ref.providerKey).toBe("string");
      expect(typeof model.ref.modelId).toBe("string");
      expect(model.ref.modelId.length).toBeGreaterThan(0);
      expect(model).toHaveProperty("label");
      expect(typeof model.label).toBe("string");
      expect(model).toHaveProperty("requiresPlatformCredits");
      expect(typeof model.requiresPlatformCredits).toBe("boolean");
      expect(model).toHaveProperty("capabilities");
    }
  });

  it("should have both free and paid models", () => {
    // Arrange
    const fixture = loadModelsFixture();

    // Assert - At least one free and one paid
    const hasFreeModel = fixture.models.some(
      (m) => m.requiresPlatformCredits === false
    );
    const hasPaidModel = fixture.models.some(
      (m) => m.requiresPlatformCredits === true
    );

    expect(hasFreeModel).toBe(true);
    expect(hasPaidModel).toBe(true);
  });

  it("should have defaultRef that exists in models list", () => {
    // Arrange
    const fixture = loadModelsFixture();

    // Assert - defaultRef matches a model in the array
    expect(fixture.defaultRef).not.toBeNull();
    const defaultRef = fixture.defaultRef;
    if (defaultRef) {
      const match = fixture.models.find(
        (m) =>
          m.ref.providerKey === defaultRef.providerKey &&
          m.ref.modelId === defaultRef.modelId
      );
      expect(match).toBeDefined();
    }
  });
});
