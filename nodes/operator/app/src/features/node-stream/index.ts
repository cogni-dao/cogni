// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/node-stream`
 * Purpose: Barrel export for node stream frontend kit — hook + card components.
 * Scope: Re-exports only. Does not contain logic.
 * Invariants:
 *   - GENERIC_PORT: Hook returns base StreamEvent, consumers narrow by type
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/node-streams-transport
 * @public
 */

export { CiStatusEventContent } from "./components/CiStatusEventContent";
export { DeployEventContent } from "./components/DeployEventContent";
export { HealthEventContent } from "./components/HealthEventContent";
export { ProcessHealthEventContent } from "./components/ProcessHealthEventContent";
export { StreamCard } from "./components/StreamCard";
export type {
  ConnectionStatus,
  StreamEvent,
  UseNodeStreamResult,
} from "./hooks/useNodeStream";
export { useNodeStream } from "./hooks/useNodeStream";
