// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-core/tests/error-codes`
 * Purpose: Verify normalizeErrorToExecutionCode encodes fault-party before the generic bucket.
 * Scope: Package-local unit test. Does not call network services.
 * Invariants:
 *   - FAULT_PARTY_BEFORE_BUCKET: upstream provider failures (402/5xx) → provider_unavailable, never internal
 *   - insufficient_credits (user balance) stays distinct from provider_unavailable (operator/upstream)
 *   - internal is the alarm bucket — only genuinely-unknown errors land there
 * Side-effects: none
 * Links: docs/spec/error-handling.md (FAULT_PARTY_BEFORE_BUCKET), bug.5056
 * @internal
 */

import { describe, expect, it } from "vitest";

import {
  AiExecutionError,
  LlmError,
  normalizeErrorToExecutionCode,
} from "../src/index";

describe("normalizeErrorToExecutionCode — fault-party before bucket", () => {
  it("maps upstream 402 (operator's provider account unfunded) to provider_unavailable, NOT internal (bug.5056)", () => {
    const err = new LlmError("LiteLLM API error: 402", "provider_4xx", 402);
    expect(normalizeErrorToExecutionCode(err)).toBe("provider_unavailable");
  });

  it("never maps an upstream 402 to insufficient_credits (that is the USER's balance)", () => {
    const err = new LlmError("Payment Required", "provider_4xx", 402);
    expect(normalizeErrorToExecutionCode(err)).not.toBe("insufficient_credits");
  });

  it("maps provider 5xx (status) to provider_unavailable", () => {
    const err = new LlmError("Bad Gateway", "provider_5xx", 502);
    expect(normalizeErrorToExecutionCode(err)).toBe("provider_unavailable");
  });

  it("maps provider_5xx kind (no status) to provider_unavailable", () => {
    const err = new LlmError("upstream down", "provider_5xx");
    expect(normalizeErrorToExecutionCode(err)).toBe("provider_unavailable");
  });

  it("keeps 429 → rate_limit and 408 → timeout", () => {
    expect(
      normalizeErrorToExecutionCode(new LlmError("rl", "rate_limited", 429))
    ).toBe("rate_limit");
    expect(
      normalizeErrorToExecutionCode(new LlmError("to", "timeout", 408))
    ).toBe("timeout");
  });

  it("preserves an explicit insufficient_credits AiExecutionError (user balance path)", () => {
    expect(
      normalizeErrorToExecutionCode(
        new AiExecutionError("insufficient_credits")
      )
    ).toBe("insufficient_credits");
  });

  it("only genuinely-unknown provider 4xx (non-402) falls to internal — the alarm bucket", () => {
    const err = new LlmError("Forbidden", "provider_4xx", 403);
    expect(normalizeErrorToExecutionCode(err)).toBe("internal");
  });
});
