// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/ai/services/run-payer`
 * Purpose: The system-free payer rules and billing hooks of an internal graph run (story.0038).
 * Scope: Pure decision plus hooks over a recording fake account service; no database.
 * Side-effects: none
 * @internal
 */

import type { UsageFact } from "@cogni/node-core";
import { describe, expect, it, vi } from "vitest";
import {
  createRunBillingHooks,
  decideRunPayer,
  SYSTEM_FREE_GRAPH_ID,
} from "@/features/ai/services/run-payer";
import type { AccountService } from "@/ports";

vi.mock("@/shared/env", () => ({
  serverEnv: () => ({ USER_PRICE_MARKUP_FACTOR: 2 }),
}));
vi.mock("@/shared/ai/model-catalog.server", () => ({
  isModelFree: async () => true,
}));

const SYSTEM = "cogni_system";
const DEFAULT_MODEL = { providerKey: "platform", modelId: "deepseek-v4-flash" };
const base = {
  payerKind: "system_free" as unknown,
  graphId: SYSTEM_FREE_GRAPH_ID,
  billingAccountId: SYSTEM,
  systemBillingAccountId: SYSTEM,
  modelRef: DEFAULT_MODEL as {
    providerKey: string;
    modelId: string;
    connectionId?: string;
  },
  defaultModelRef: DEFAULT_MODEL,
  modelIsFree: true,
};

describe("decideRunPayer", () => {
  it("no payerKind: the actor pays (existing behavior)", () => {
    expect(decideRunPayer({ ...base, payerKind: undefined })).toEqual({
      ok: true,
      systemFree: false,
    });
  });

  it("system_free on pr-review, system account, default free model: system pays", () => {
    expect(decideRunPayer(base)).toEqual({ ok: true, systemFree: true });
  });

  it.each([
    [
      "another graph",
      { graphId: "langgraph:poet" },
      403,
      "system_free_payer_not_permitted",
    ],
    [
      "another account",
      { billingAccountId: "dev-account" },
      403,
      "system_free_payer_not_permitted",
    ],
    [
      "a connection id",
      { modelRef: { ...DEFAULT_MODEL, connectionId: "c1" } },
      403,
      "system_free_connection_not_permitted",
    ],
    [
      "a non-default model",
      { modelRef: { providerKey: "platform", modelId: "claude-haiku-4-5" } },
      403,
      "system_free_model_not_default",
    ],
    [
      "a model the catalog does not call free",
      { modelIsFree: false },
      403,
      "system_free_model_not_free",
    ],
    [
      "an unknown payerKind",
      { payerKind: "other" },
      400,
      "payer_kind_unsupported",
    ],
  ] as const)("refuses %s", (_name, over, status, errorCode) => {
    expect(decideRunPayer({ ...base, ...over })).toEqual({
      ok: false,
      status,
      errorCode,
    });
  });
});

describe("createRunBillingHooks: preflight and usage commit use the payer service", () => {
  const fact = {
    runId: "run-1",
    attempt: 0,
    billingAccountId: SYSTEM,
    virtualKeyId: "vk-system",
    source: "litellm",
    usageUnitId: "call-1",
    costUsd: 0,
    model: "deepseek-v4-flash",
    graphId: SYSTEM_FREE_GRAPH_ID,
    executorType: "inproc",
  } as unknown as UsageFact;

  it("reads the balance and writes a $0 receipt on cogni_system through the SAME (system-principal) service", async () => {
    const system = {
      getBalance: vi.fn(async () => 0),
      recordChargeReceipt: vi.fn(async () => undefined),
    } as unknown as AccountService;
    const log = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const { preflightCheckFn, commitByoUsage } = createRunBillingHooks(system);

    // A free model estimates 0 credits, so a $0 balance passes preflight; the read went to the payer service.
    await expect(
      preflightCheckFn(SYSTEM, "deepseek-v4-flash", [
        { role: "user", content: "review this" } as never,
      ])
    ).resolves.toBeUndefined();
    expect(system.getBalance).toHaveBeenCalledWith(SYSTEM);

    await commitByoUsage(fact, log as never);
    expect(system.recordChargeReceipt).toHaveBeenCalledTimes(1);
    expect(system.recordChargeReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        billingAccountId: SYSTEM,
        virtualKeyId: "vk-system",
        chargedCredits: 0n,
        responseCostUsd: 0,
      })
    );
  });
});
