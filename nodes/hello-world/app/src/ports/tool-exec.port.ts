// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/tool-exec`
 * Purpose: Re-export tool execution types from @cogni/ai-core for src/ consumers.
 * Scope: Pure re-export. Does not define new types or contain logic.
 * Invariants:
 *   - TOOL_EXEC_TYPES_IN_AI_CORE: Canonical definitions in @cogni/ai-core
 * Side-effects: none
 * Links: @cogni/ai-core/tooling/types.ts, TOOL_USE_SPEC.md
 * @public
 */

export type {
  EmitAiEvent,
  ToolEffect,
  ToolExecFn,
  ToolExecResult,
} from "@cogni/ai-core";
