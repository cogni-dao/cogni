// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/graph-execution-host/decorators/preflight-credit-check`
 * Purpose: Decorator that wraps GraphExecutorPort with pre-execution credit validation.
 * Scope: Checks credit balance before any upstream event consumption. Does not execute graphs directly (delegates to inner).
 * Invariants:
 *   - CREDITS_ENFORCED_AT_EXECUTION_PORT: all execution paths get credit check automatically
 *   - PREFLIGHT_BEFORE_FIRST_YIELD: credit check completes before any upstream iteration
 *   - POLICY_VIA_PROVIDER: billing policy comes from PlatformCreditChecker, not string matching
 *   - PURE_LIBRARY: no env vars, no process lifecycle
 * Side-effects: IO (via injected checkFn → accountService.getBalance)
 * Links: https://node-template.cognidao.org/knowledge/multi-provider-llm-routing
 * @public
 */

import type { AiEvent } from "@cogni/ai-core";
import type {
  ExecutionContext,
  GraphExecutorPort,
  GraphRunRequest,
  GraphRunResult,
} from "@cogni/graph-execution-core";

import type { LoggerPort } from "../ports/logger.port";
import type {
  PlatformCreditChecker,
  PreflightCreditCheckFn,
} from "../ports/preflight-credit-check";

/**
 * Decorator that wraps GraphExecutorPort with pre-execution credit validation.
 *
 * Runs an injected credit check function before yielding any upstream events.
 * If credits are insufficient, throws InsufficientCreditsPortError before
 * any LLM execution occurs.
 *
 * Uses PlatformCreditChecker to determine if the model's provider requires
 * platform credits. BYO providers (codex, ollama) skip the check entirely.
 */
export class PreflightCreditCheckDecorator implements GraphExecutorPort {
  constructor(
    private readonly inner: GraphExecutorPort,
    private readonly checkFn: PreflightCreditCheckFn,
    private readonly billingAccountId: string,
    private readonly checker: PlatformCreditChecker,
    _log: LoggerPort
  ) {}

  runGraph(req: GraphRunRequest, ctx?: ExecutionContext): GraphRunResult {
    const result = this.inner.runGraph(req, ctx);

    // Ask the provider if this model requires platform credits.
    // BYO providers (codex, ollama) return false — skip check entirely.
    const provider = this.checker.resolve(req.modelRef.providerKey);
    const creditCheckPromise = provider
      .requiresPlatformCredits(req.modelRef)
      .then((requiresCredits) => {
        if (!requiresCredits) return; // User-funded, no platform cost
        return this.checkFn(
          this.billingAccountId,
          req.modelRef.modelId,
          req.messages
        );
      });

    return {
      stream: this.wrapWithPreflight(result.stream, creditCheckPromise),
      // If preflight fails, final rejects with same error (no billing fires)
      final: creditCheckPromise.then(() => result.final),
    };
  }

  private async *wrapWithPreflight(
    upstream: AsyncIterable<AiEvent>,
    checkPromise: Promise<void>
  ): AsyncIterable<AiEvent> {
    // Credit check MUST complete before consuming ANY upstream events
    // Per PREFLIGHT_BEFORE_FIRST_YIELD: no accidental upstream peek or buffering
    await checkPromise;
    yield* upstream;
  }
}
