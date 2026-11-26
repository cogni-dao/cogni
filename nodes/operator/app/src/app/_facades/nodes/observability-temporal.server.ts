// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { resolveRequestIdentity } from "@/app/_lib/auth/request-identity";
/**
 * Module: `@app/_facades/nodes/observability-temporal`
 * Purpose: Compose bounded authentication/preparation and the finite diagnostic service.
 * Scope: HTTP refusal mapping only; no native payload or error text crosses this facade.
 * Invariants: Actual preparation transports cancel; finally disposes all request-owned resources.
 * Side-effects: local identity, registry, grant and native reads.
 * Links: https://cognidao.org/knowledge/node-temporal-health-contract
 * @public
 */
import { resolveRouteIdentity } from "@/app/_lib/auth/route-identity";
import {
  createLedgerPreparation,
  type DiagnosticBudget,
  LedgerRequestError,
} from "@/bootstrap/ledger-diagnostic";
import { nodeIdOrSlug } from "@/features/nodes/node-lookup";
import {
  DiagnosticInputError,
  parseLedgerDiagnosticQuery,
  readLedgerDiagnostic,
} from "@/features/nodes/observability-temporal";

export async function ledgerDiagnosticResponse(
  request: Request,
  ref: string,
  budget: DiagnosticBudget
): Promise<{
  status: number;
  body: unknown;
  nodeId?: string;
  code: string;
  calls: number;
  env?: "candidate-a" | "preview" | "production";
  reasonCodes: readonly string[];
}> {
  let env: "candidate-a" | "preview" | "production" | undefined;
  let nodeId: string | undefined;
  let calls = 0;
  let preparation: ReturnType<typeof createLedgerPreparation> | undefined;
  try {
    budget.signal.throwIfAborted();
    const parsedEnv: "candidate-a" | "preview" | "production" =
      parseLedgerDiagnosticQuery(new URL(request.url).searchParams);
    env = parsedEnv;
    preparation = createLedgerPreparation(budget, nodeIdOrSlug);
    const credentialStore = preparation.credentialStore;
    const auth = await resolveRouteIdentity(() =>
      resolveRequestIdentity({ credentialStore })
    );
    preparation.check();
    if (!auth.ok)
      return {
        status: auth.status,
        body: { error: auth.errorCode },
        code: auth.errorCode,
        calls,
        env: parsedEnv,
        reasonCodes: [auth.errorCode],
      };
    if (!auth.user)
      return {
        status: 401,
        body: { error: "unauthorized" },
        code: "unauthorized",
        calls,
        env: parsedEnv,
        reasonCodes: ["unauthorized"],
      };
    const dto = await readLedgerDiagnostic(
      {
        ref,
        actorId: auth.user.id,
        env: parsedEnv,
        signal: budget.signal,
        deadline: budget.deadline,
        onNodeResolved: (resolved) => {
          nodeId = resolved;
        },
        onAttempt: () => {
          calls += 1;
        },
      },
      preparation
    );
    return {
      status: 200,
      body: dto,
      nodeId: dto.nodeId,
      code: dto.state,
      calls,
      env: parsedEnv,
      reasonCodes: dto.reasonCodes,
    };
  } catch (error) {
    const code =
      error instanceof LedgerRequestError ||
      error instanceof DiagnosticInputError
        ? error.code
        : error instanceof Error &&
            ["deadline_exceeded", "temporal_read_failed"].includes(
              error.message
            )
          ? error.message
          : budget.signal.aborted || error instanceof DOMException
            ? "deadline_exceeded"
            : "temporal_read_failed";
    const status =
      error instanceof LedgerRequestError
        ? error.status
        : error instanceof DiagnosticInputError
          ? 400
          : code === "deadline_exceeded"
            ? 503
            : 502;
    return {
      status,
      body: { error: code },
      code,
      calls,
      ...(env === undefined ? {} : { env }),
      ...(nodeId === undefined ? {} : { nodeId }),
      reasonCodes: [code],
    };
  } finally {
    preparation?.dispose();
  }
}
