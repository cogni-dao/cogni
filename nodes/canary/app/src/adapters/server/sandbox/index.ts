// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/sandbox`
 * Purpose: Barrel export for sandbox adapters.
 * Scope: Exports only; does not contain implementation logic.
 * Invariants: Exports must match public API surface.
 * Side-effects: none (at import time - adapters have runtime effects when instantiated)
 * Links: src/adapters/server/sandbox/sandbox-runner.adapter.ts
 * @internal
 */

export {
  type LlmProxyConfig,
  type LlmProxyHandle,
  LlmProxyManager,
  type ProxyStopResult,
} from "./llm-proxy-manager";
export { SandboxAgentCatalogProvider } from "./sandbox-agent-catalog.provider";
export {
  SANDBOX_PROVIDER_ID,
  SandboxGraphProvider,
} from "./sandbox-graph.provider";
export {
  SandboxRunnerAdapter,
  type SandboxRunnerAdapterOptions,
} from "./sandbox-runner.adapter";
