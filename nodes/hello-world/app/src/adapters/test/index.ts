// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/test`
 * Purpose: Barrel exports for test adapter implementations.
 * Scope: Re-exports all test adapters for clean imports. Does not contain logic.
 * Invariants: All test adapters exported (except LLM — uses LiteLlmAdapter everywhere).
 * Side-effects: none
 * Notes: Used by bootstrap container for environment-based adapter wiring.
 * Links: Used by src/bootstrap/container.ts
 * @public
 */

export { FakeWebSearchAdapter } from "./ai/fake-web-search.adapter";
export { FakeAiTelemetryAdapter } from "./ai-telemetry/fake-ai-telemetry.adapter";
export { FakeMetricsAdapter } from "./metrics/fake-metrics.adapter";
export {
  FakeEvmOnchainClient,
  getTestEvmOnchainClient,
  resetTestEvmOnchainClient,
} from "./onchain/fake-evm-onchain-client.adapter";
export {
  FakeOnChainVerifierAdapter,
  getTestOnChainVerifier,
  resetTestOnChainVerifier,
} from "./payments/fake-onchain-verifier.adapter";
export { FakeRepoAdapter } from "./repo/fake-repo.adapter";
export {
  FakeOperatorWalletAdapter,
  getTestOperatorWallet,
  resetTestOperatorWallet,
} from "./wallet/fake-operator-wallet.adapter";
