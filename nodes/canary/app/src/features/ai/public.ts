// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/ai/public`
 * Purpose: Public API surface for AI feature - CLIENT-SAFE barrel export only.
 * Scope: Re-exports client-safe types, components, and functions. Does not implement logic.
 * Invariants:
 *   - All exports must be client-safe (no server-only dependencies)
 *   - Server-only exports live in public.server.ts
 * Side-effects: none
 * Notes: Feature consumers should only import from this file for client code.
 *        Server code should import from public.server.ts for server-only exports.
 * Links: Part of hexagonal architecture boundary enforcement
 * @public
 */

// Model selection rules (re-exported from core for app layer access)
export { pickDefaultModel } from "@cogni/node-core";
// Thread data hooks
export {
  useDeleteThread,
  useLoadThread,
  useThreads,
} from "./chat/hooks/useThreads";
export type { ChatComposerExtrasProps } from "./components/ChatComposerExtras";
// Model/graph selection components
export {
  ChatComposerExtras,
  DEFAULT_GRAPH_ID,
} from "./components/ChatComposerExtras";
// Chat error components
export type { ChatErrorBubbleProps } from "./components/ChatErrorBubble";
export { ChatErrorBubble } from "./components/ChatErrorBubble";
export type { ModelPickerProps } from "./components/ModelPicker";
export { ModelPicker } from "./components/ModelPicker";
// Model data hooks
export { useModels } from "./hooks/useModels";
// Model preferences
export {
  clearPreferredModelId,
  getPreferredModelId,
  setPreferredModelId,
  validatePreferredModel,
} from "./preferences/model-preference";
// AiEvent types (for route consumption - types only, no runtime)
export type {
  AiEvent,
  DoneEvent,
  StreamFinalResult,
  TextDeltaEvent,
  ToolCallResultEvent,
  ToolCallStartEvent,
} from "./types";
