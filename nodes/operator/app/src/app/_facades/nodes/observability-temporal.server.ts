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
}> {
  let preparation: ReturnType<typeof createLedgerPreparation> | undefined;
  try {
    budget.signal.throwIfAborted();
    const env = parseLedgerDiagnosticQuery(new URL(request.url).searchParams);
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
        calls: 0,
      };
    if (!auth.user)
      return {
        status: 401,
        body: { error: "unauthorized" },
        code: "unauthorized",
        calls: 0,
      };
    const dto = await readLedgerDiagnostic(
      {
        ref,
        actorId: auth.user.id,
        env,
        signal: budget.signal,
        deadline: budget.deadline,
      },
      preparation
    );
    return {
      status: 200,
      body: dto,
      nodeId: dto.nodeId,
      code: dto.state,
      calls: dto.budgets.calls,
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
    return { status, body: { error: code }, code, calls: 0 };
  } finally {
    preparation?.dispose();
  }
}
