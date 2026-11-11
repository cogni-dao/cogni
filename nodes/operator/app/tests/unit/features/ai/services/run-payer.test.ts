// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/ai/services/run-payer`
 * Purpose: The system-free payer rules and billing hooks of an internal graph run (story.0038).
 * Scope: Pure decision plus hooks over a recording fake account service; no database.
 * Side-effects: none
 * @internal
 */

import { describe, expect, it, vi } from "vitest";
import {
  createRunBillingHooks,
  decideRunPayer,
  SYSTEM_FREE_GRAPH_ID,
  selectPayerAccountService,
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

describe("createRunBillingHooks: preflight reads through the payer service", () => {
  // The $0 receipt of a free LiteLLM review call is written by the billing ingest route, not by the BYO commit
  // hook (see tests/contract/app/billing-ingest-system-free.contract.test.ts).
  it("preflight reads the balance of the payer account through the service it was given", async () => {
    const system = {
      getBalance: vi.fn(async () => 0),
    } as unknown as AccountService;
    const { preflightCheckFn } = createRunBillingHooks(system);
    // A free model estimates 0 credits, so a $0 balance passes preflight; the read went to the payer service.
    await expect(
      preflightCheckFn(SYSTEM, "deepseek-v4-flash", [
        { role: "user", content: "review this" } as never,
      ])
    ).resolves.toBeUndefined();
    expect(system.getBalance).toHaveBeenCalledWith(SYSTEM);
  });
});

describe("selectPayerAccountService", () => {
  const actorService = { tag: "actor" } as unknown as AccountService;
  const systemService = { tag: "system" } as unknown as AccountService;
  const SYSTEM_PRINCIPAL = "00000000-0000-4000-a000-000000000001";

  it("system_free: the SYSTEM principal's service, not the caller's", () => {
    const accountsForUser = vi.fn(() => systemService);
    const picked = selectPayerAccountService({
      systemFree: true,
      actorAccountService: actorService,
      accountsForUser,
      systemPrincipalUserId: SYSTEM_PRINCIPAL,
    });
    expect(picked).toBe(systemService);
    expect(accountsForUser).toHaveBeenCalledWith(SYSTEM_PRINCIPAL);
  });

  it("otherwise: the caller's service and no system lookup", () => {
    const accountsForUser = vi.fn(() => systemService);
    const picked = selectPayerAccountService({
      systemFree: false,
      actorAccountService: actorService,
      accountsForUser,
      systemPrincipalUserId: SYSTEM_PRINCIPAL,
    });
    expect(picked).toBe(actorService);
    expect(accountsForUser).not.toHaveBeenCalled();
  });
});
