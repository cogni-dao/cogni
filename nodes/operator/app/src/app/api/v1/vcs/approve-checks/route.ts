// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/vcs/approve-checks`
 * Purpose: Operator-as-maintainer auto-approval of fork-PR workflow runs.
 *   GitHub holds `pull_request` workflow runs from first-time / outside fork
 *   contributors behind a maintainer-approval gate. This endpoint lets a
 *   contract-compliant agent release its own held checks without a human click.
 * Scope: Auth → work-item gate → approve. No slot lease, no CI gate (this runs
 *   BEFORE CI can go green — approval is what lets CI run at all).
 * Invariants:
 *   - AUTH_REQUIRED: Bearer token (machine agents) or SIWE session.
 *   - WORK_ITEM_GATE: The PR must be linked to the named work item by the
 *     calling principal (assertPrLinkedBySession) — proves contract compliance
 *     and agent attribution before we spend runner minutes on a fork.
 *   - CAPABILITY_BOUNDARY: Calls VcsCapability only — no direct Octokit here.
 *   - CONTRACTS_ARE_TRUTH: Input/output parsed through approveChecksOperation.
 * Side-effects: IO (GitHub REST API via VcsCapability)
 * Links: docs/design/operator-approve-fork-checks.md,
 *   packages/node-contracts/src/vcs.approve-checks.v1.contract.ts
 * @public
 */

import { approveChecksOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import {
  assertPrLinkedBySession,
  CoordinationWorkItemNotFoundError,
  WorkItemSessionForbiddenError,
  WorkItemSessionNotFoundError,
  WorkItemSessionPrMismatchError,
} from "@/app/_facades/work/coordination.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getGithubRepo } from "@/shared/config/repoSpec.server";
import { logRequestWarn } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "vcs.approveChecks", auth: { mode: "required", getSessionUser } },
  async (ctx, request, sessionUser) => {
    if (!sessionUser) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const parsed = approveChecksOperation.input.safeParse(await request.json());
    if (!parsed.success) {
      logRequestWarn(ctx.log, parsed.error, "VALIDATION_ERROR");
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }
    const { workItemId, prNumber } = parsed.data;

    // Work-item gate: the PR must be linked to this item by THIS principal.
    try {
      await assertPrLinkedBySession({ workItemId, prNumber, sessionUser });
    } catch (error) {
      if (
        error instanceof CoordinationWorkItemNotFoundError ||
        error instanceof WorkItemSessionNotFoundError
      ) {
        return NextResponse.json(
          { error: (error as Error).message },
          { status: 404 }
        );
      }
      if (
        error instanceof WorkItemSessionForbiddenError ||
        error instanceof WorkItemSessionPrMismatchError
      ) {
        logRequestWarn(ctx.log, error, "APPROVE_CHECKS_GATE_REJECT");
        return NextResponse.json(
          { error: (error as Error).message },
          { status: 403 }
        );
      }
      throw error;
    }

    const { owner, repo } = getGithubRepo();
    const vcs = getContainer().vcsCapability;
    const result = await vcs.approveForkChecks({ owner, repo, prNumber });

    return NextResponse.json(
      approveChecksOperation.output.parse(result),
      { status: 202 }
    );
  }
);
