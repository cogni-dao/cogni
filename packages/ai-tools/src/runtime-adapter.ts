// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/runtime-adapter`
 * Purpose: Convert BoundTool (ai-tools) to BoundToolRuntime (ai-core interface).
 * Scope: Adapter creation only. Does not execute tools.
 * Invariants:
 *   - TOOL_SOURCE_RETURNS_BOUND_TOOL: Returns executable BoundToolRuntime
 *   - AUTH_VIA_CAPABILITY_INTERFACE: exec() receives capabilities, not raw secrets
 *   - Zod validation stays in this layer; ai-core sees only the interface
 * Side-effects: none
 * Links: TOOL_USE_SPEC.md #27
 * @public
 */

import type {
  BoundToolRuntime,
  ToolCapabilities,
  ToolInvocationContext,
} from "@cogni/ai-core";

import { toToolSpec } from "./schema";
import type { BoundTool, ToolContract, ToolImplementation } from "./types";

/**
 * Options for creating a BoundToolRuntime adapter.
 */
export interface ToBoundToolRuntimeOptions {
  /**
   * Whether this tool requires an authenticated connection.
   * If true, exec() will expect ctx.connectionId and capabilities.auth.
   * Default: false
   */
  readonly requiresConnection?: boolean;

  /**
   * Capability dependencies for this tool.
   * Default: [] (or ['auth'] if requiresConnection is true)
   */
  readonly capabilities?: readonly string[];
}

/**
 * Convert a BoundTool to BoundToolRuntime interface.
 *
 * This adapter bridges the gap between:
 * - BoundTool (ai-tools): Has Zod schemas, typed execute function
 * - BoundToolRuntime (ai-core): Method-based interface, no Zod dependency
 *
 * Per TOOL_SOURCE_RETURNS_BOUND_TOOL: The returned BoundToolRuntime owns
 * validation, execution, and redaction logic. toolRunner orchestrates but
 * never imports Zod directly.
 *
 * @param boundTool - BoundTool from ai-tools
 * @param options - Optional configuration
 * @returns BoundToolRuntime compatible with ai-core toolRunner
 */
export function toBoundToolRuntime(
  boundTool: BoundTool<string, unknown, unknown, Record<string, unknown>>,
  options?: ToBoundToolRuntimeOptions
): BoundToolRuntime {
  const { contract, implementation } = boundTool;

  // Compile spec once
  const { spec } = toToolSpec(contract);

  // Determine capabilities
  const requiresConnection = options?.requiresConnection ?? false;
  const capabilities =
    options?.capabilities ?? (requiresConnection ? ["auth"] : []);

  return {
    // Identity
    id: contract.name,
    spec,
    effect: contract.effect,
    requiresConnection,
    capabilities,
    ...(contract.requires !== undefined && { requires: contract.requires }),

    // Method-based interface
    validateInput(rawArgs: unknown): unknown {
      return contract.inputSchema.parse(rawArgs);
    },

    async exec(
      validatedArgs: unknown,
      _ctx: ToolInvocationContext,
      _capabilities: ToolCapabilities
    ): Promise<unknown> {
      // TODO: In P1, pass capabilities to tools that need them
      // For now, tools receive validated args only (existing behavior)
      return implementation.execute(validatedArgs as never);
    },

    validateOutput(rawOutput: unknown): unknown {
      return contract.outputSchema.parse(rawOutput);
    },

    redact(validatedOutput: unknown): unknown {
      return contract.redact(validatedOutput as never);
    },
  };
}

/**
 * Convert multiple BoundTools to BoundToolRuntimes.
 *
 * @param boundTools - Array of BoundTools
 * @param options - Optional configuration (applied to all)
 * @returns Array of BoundToolRuntimes
 */
export function toBoundToolRuntimes(
  boundTools: readonly BoundTool<
    string,
    unknown,
    unknown,
    Record<string, unknown>
  >[],
  options?: ToBoundToolRuntimeOptions
): BoundToolRuntime[] {
  return boundTools.map((tool) => toBoundToolRuntime(tool, options));
}

/**
 * Create a BoundToolRuntime lookup map from BoundTools.
 *
 * @param boundTools - Array of BoundTools
 * @returns Map of tool ID → BoundToolRuntime
 */
export function createBoundToolRuntimeMap(
  boundTools: readonly BoundTool<
    string,
    unknown,
    unknown,
    Record<string, unknown>
  >[]
): Map<string, BoundToolRuntime> {
  const map = new Map<string, BoundToolRuntime>();
  for (const tool of boundTools) {
    const runtime = toBoundToolRuntime(tool);
    map.set(runtime.id, runtime);
  }
  return map;
}

/**
 * Create BoundToolRuntime from a contract and implementation separately.
 *
 * This enables dependency injection at bootstrap time:
 * - Contract defines the tool schema (from catalog)
 * - Implementation is injected with real capabilities (from bootstrap)
 *
 * Per AUTH_VIA_CAPABILITY_INTERFACE: tools receive capabilities via
 * implementation factory, not via exec() capabilities parameter.
 *
 * @param contract - Tool contract from catalog
 * @param implementation - Real implementation with injected dependencies
 * @param options - Optional configuration
 * @returns BoundToolRuntime compatible with ai-core toolRunner
 */
export function contractToRuntime(
  contract: ToolContract<string, unknown, unknown, Record<string, unknown>>,
  implementation: ToolImplementation<unknown, unknown>,
  options?: ToBoundToolRuntimeOptions
): BoundToolRuntime {
  return toBoundToolRuntime({ contract, implementation }, options);
}
