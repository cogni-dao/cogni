// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/schema`
 * Purpose: Compile ToolContract (Zod) to ToolSpec (JSONSchema7) for wire formats.
 * Scope: Schema compilation only. Does not execute tools or touch IO.
 * Invariants:
 *   - NO_MANUAL_SCHEMA_DUPLICATION: JSONSchema derived from Zod, never hand-written
 *   - Synchronous compilation (no async imports)
 * Side-effects: none
 * Links: TOOL_USE_SPEC.md
 * @public
 */

import type { ToolSpec } from "@cogni/ai-core";
import type { JSONSchema7 } from "json-schema";
import { z } from "zod";

import type { ToolContract } from "./types";

/**
 * Result of compiling a ToolContract to ToolSpec.
 */
export interface ToToolSpecResult {
  readonly spec: ToolSpec;
  readonly warnings: readonly string[];
}

/**
 * Compile a ToolContract to a ToolSpec.
 *
 * Converts the Zod inputSchema to JSONSchema7.
 * schemaHash is not computed in P0; compute in Node-only layer if needed.
 *
 * @param contract - Tool contract with Zod schemas
 * @returns Result with spec and any warnings
 */
export function toToolSpec(
  contract: ToolContract<string, unknown, unknown, unknown>
): ToToolSpecResult {
  const rawSchema = z.toJSONSchema(contract.inputSchema, {
    target: "draft-7",
    io: "input",
  });

  const inputSchema: JSONSchema7 =
    typeof rawSchema === "object" && rawSchema !== null
      ? (rawSchema as JSONSchema7)
      : { type: "object" };

  return {
    spec: {
      name: contract.name,
      description: contract.description,
      inputSchema,
      effect: contract.effect,
      redaction: {
        mode: "top_level_only",
        allowlist: contract.allowlist as readonly string[],
      },
      schemaHash: undefined,
    },
    warnings: [],
  };
}

/**
 * Result of compiling multiple ToolContracts.
 */
export interface ToToolSpecsResult {
  readonly specs: readonly ToolSpec[];
  readonly warnings: readonly string[];
}

/**
 * Compile multiple ToolContracts to ToolSpecs.
 *
 * @param contracts - Array of tool contracts
 * @returns Result with specs and aggregated warnings
 */
export function toToolSpecs(
  contracts: ReadonlyArray<ToolContract<string, unknown, unknown, unknown>>
): ToToolSpecsResult {
  const allWarnings: string[] = [];
  const specs = contracts.map((contract) => {
    const { spec, warnings } = toToolSpec(contract);
    allWarnings.push(...warnings);
    return spec;
  });

  return { specs, warnings: allWarnings };
}
