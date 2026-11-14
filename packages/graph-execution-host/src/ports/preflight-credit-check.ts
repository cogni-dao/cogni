// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/graph-execution-host/ports/preflight-credit-check`
 * Purpose: Pre-execution credit balance check port and platform credit checker interface.
 * Scope: Defines PreflightCreditCheckFn and PlatformCreditChecker shapes. Does not contain credit validation logic or database access.
 * Invariants: PURE_LIBRARY — no env vars, no process lifecycle.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/package-isolation-rules, src/decorators/preflight-credit-check.decorator.ts
 * @public
 */

import type { ModelRef } from "@cogni/ai-core";
export type PreflightCreditCheckFn = (
  billingAccountId: string,
  model: string,
  messages: readonly unknown[]
) => Promise<void>;

/**
 * Minimal projection of ModelProviderResolverPort — only the method chain
 * the preflight decorator actually calls.
 * The app's existing ProviderResolver satisfies this structurally.
 */
export interface PlatformCreditChecker {
  resolve(providerKey: string): {
    requiresPlatformCredits(ref: ModelRef): Promise<boolean>;
  };
}
