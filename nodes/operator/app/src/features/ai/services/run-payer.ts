// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/ai/services/run-payer`
 * Purpose: Decide who pays for an internal graph run and build the billing hooks that read the payer (story.0038).
 * Scope: Pure decision plus two closures over an injected account service. Does not read the database or call a model.
 * Invariants:
 *   - PAYER_IS_SYSTEM_ONLY_FOR_FREE_REVIEW: `payerKind: "system_free"` is honored only for the pr-review graph on the
 *     system billing account with the default model, no connection, and a model the catalog says is free. Anything else
 *     naming it is refused with a stable error code (400 unsupported kind, 403 otherwise); the run never starts.
 *   - PAYER_HOOKS_USE_ONE_SERVICE: preflight and the BYO usage commit use the SAME account service, so a system-paid run
 *     reads and writes the system tenant's account (the developer-scoped service would hide it under RLS).
 * Side-effects: none (the hooks do IO through the injected service only)
 * Links: src/app/api/internal/graphs/[graphId]/runs/route.ts, story.0038
 * @public
 */

import type { CommitUsageFactFn } from "@cogni/graph-execution-host";
import type { Logger } from "pino";
import type { AccountService, PreflightCreditCheckFn } from "@/ports";
import { commitUsageFact } from "./billing";
import { preflightCreditCheck } from "./preflight-credit-check";

export const SYSTEM_FREE_GRAPH_ID = "langgraph:pr-review";

export interface RunModelRef {
  readonly providerKey: string;
  readonly modelId: string;
  readonly connectionId?: string | undefined;
}

export type RunPayerDecision =
  | { readonly ok: true; readonly systemFree: boolean }
  | {
      readonly ok: false;
      readonly status: 400 | 403;
      readonly errorCode:
        | "payer_kind_unsupported"
        | "system_free_payer_not_permitted"
        | "system_free_model_not_default"
        | "system_free_model_not_free"
        | "system_free_connection_not_permitted";
    };

export function decideRunPayer(input: {
  readonly payerKind: unknown;
  readonly graphId: string;
  readonly billingAccountId: string;
  readonly systemBillingAccountId: string;
  readonly modelRef: RunModelRef;
  readonly defaultModelRef: RunModelRef;
  /** Catalog answer for `modelRef.modelId` (only read when `payerKind` is `system_free`). */
  readonly modelIsFree: boolean;
}): RunPayerDecision {
  if (input.payerKind === undefined) return { ok: true, systemFree: false };
  if (input.payerKind !== "system_free") {
    return { ok: false, status: 400, errorCode: "payer_kind_unsupported" };
  }
  if (
    input.graphId !== SYSTEM_FREE_GRAPH_ID ||
    input.billingAccountId !== input.systemBillingAccountId
  ) {
    return {
      ok: false,
      status: 403,
      errorCode: "system_free_payer_not_permitted",
    };
  }
  if (input.modelRef.connectionId) {
    return {
      ok: false,
      status: 403,
      errorCode: "system_free_connection_not_permitted",
    };
  }
  if (
    input.modelRef.providerKey !== input.defaultModelRef.providerKey ||
    input.modelRef.modelId !== input.defaultModelRef.modelId
  ) {
    return {
      ok: false,
      status: 403,
      errorCode: "system_free_model_not_default",
    };
  }
  if (!input.modelIsFree) {
    return { ok: false, status: 403, errorCode: "system_free_model_not_free" };
  }
  return { ok: true, systemFree: true };
}

/** Preflight and BYO usage-commit closures that both read the payer through `payerAccountService`. */
export function createRunBillingHooks(payerAccountService: AccountService): {
  readonly preflightCheckFn: PreflightCreditCheckFn;
  readonly commitByoUsage: CommitUsageFactFn;
} {
  return {
    preflightCheckFn: (billingAccountId, model, messages) =>
      preflightCreditCheck({
        billingAccountId,
        messages: [...messages],
        model,
        accountService: payerAccountService,
      }),
    commitByoUsage: async (fact, log) => {
      await commitUsageFact(
        fact,
        {
          runId: fact.runId,
          attempt: fact.attempt,
          ingressRequestId: fact.runId,
        },
        payerAccountService,
        log as Logger
      );
    },
  };
}
