// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/security/no-secret-fields.types`
 * Purpose: Type-level guard tests ensuring secrets never appear in port interfaces.
 * Scope: Compile-time verification that BillingAccount, LlmCaller, and ToolInvocationContext do not contain secret fields. Does NOT test runtime behavior.
 * Invariants: Security invariant - secrets must not cross port boundaries; NO_SECRETS_IN_CONTEXT.
 * Side-effects: none (type-only tests)
 * Notes: Uses @ts-expect-error to fail compilation if secret fields are re-added.
 * Links: src/ports/accounts.port.ts, src/ports/llm.port.ts, @cogni/ai-core/tooling/types.ts, docs/spec/security-auth.md, docs/spec/tool-use.md
 * @public
 */

import type { ToolInvocationContext } from "@cogni/ai-core";
import { describe, expect, it } from "vitest";
import type { BillingAccount, LlmCaller } from "@/ports";

describe("Security: No secret fields in port interfaces", () => {
  /**
   * Security invariant: BillingAccount must NOT contain litellmVirtualKey.
   * MVP uses master key mode - no per-user secrets flow through application layers.
   * If this test fails to compile, someone added litellmVirtualKey back to BillingAccount.
   */
  it("BillingAccount does not expose litellmVirtualKey", () => {
    const account: BillingAccount = {
      id: "billing-123",
      ownerUserId: "user-456",
      balanceCredits: 1000,
      defaultVirtualKeyId: "vk-789",
      // @ts-expect-error - litellmVirtualKey must NOT exist on BillingAccount (security invariant)
      litellmVirtualKey: "should-not-compile",
    };

    // Runtime assertion (type guard already enforces at compile time)
    expect(account.id).toBeDefined();
  });

  /**
   * Security invariant: LlmCaller must NOT contain litellmVirtualKey.
   * The adapter reads LITELLM_MASTER_KEY from env at the boundary.
   * If this test fails to compile, someone added litellmVirtualKey back to LlmCaller.
   */
  it("LlmCaller does not expose litellmVirtualKey", () => {
    const caller: LlmCaller = {
      billingAccountId: "billing-123",
      virtualKeyId: "vk-789",
      requestId: "req-123",
      traceId: "trace-456",
      // @ts-expect-error - litellmVirtualKey must NOT exist on LlmCaller (security invariant)
      litellmVirtualKey: "should-not-compile",
    };

    // Runtime assertion (type guard already enforces at compile time)
    expect(caller.billingAccountId).toBeDefined();
  });

  /**
   * Security invariant: ToolInvocationContext must NOT contain secrets.
   * Per NO_SECRETS_IN_CONTEXT (TOOL_USE_SPEC.md #28): Context carries references
   * only (runId, toolCallId, connectionId?). Secrets flow via capabilities.
   * If this test fails to compile, someone added a secret field to ToolInvocationContext.
   */
  it("ToolInvocationContext does not expose accessToken", () => {
    const ctx: ToolInvocationContext = {
      runId: "run-123",
      toolCallId: "call-456",
      connectionId: "conn-789",
      // @ts-expect-error - accessToken must NOT exist on ToolInvocationContext (NO_SECRETS_IN_CONTEXT)
      accessToken: "should-not-compile",
    };

    expect(ctx.runId).toBeDefined();
  });

  it("ToolInvocationContext does not expose apiKey", () => {
    const ctx: ToolInvocationContext = {
      runId: "run-123",
      toolCallId: "call-456",
      // @ts-expect-error - apiKey must NOT exist on ToolInvocationContext (NO_SECRETS_IN_CONTEXT)
      apiKey: "should-not-compile",
    };

    expect(ctx.runId).toBeDefined();
  });

  it("ToolInvocationContext does not expose refreshToken", () => {
    const ctx: ToolInvocationContext = {
      runId: "run-123",
      toolCallId: "call-456",
      // @ts-expect-error - refreshToken must NOT exist on ToolInvocationContext (NO_SECRETS_IN_CONTEXT)
      refreshToken: "should-not-compile",
    };

    expect(ctx.runId).toBeDefined();
  });
});
