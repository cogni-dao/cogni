// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/attribution/epochs/[id]/review-subject-overrides/route`
 * Purpose: SIWE + approver-gated endpoint for subject-level review overrides.
 * Scope: Auth-protected GET/PATCH/DELETE endpoints. Requires wallet in activity_ledger.approvers for writes. Does not perform finalization or statement generation.
 * Invariants: NODE_SCOPED, WRITE_ROUTES_APPROVER_GATED, VALIDATE_IO.
 * Side-effects: IO (HTTP response, database write)
 * Links: docs/spec/attribution-ledger.md, contracts/attribution.review-subject-overrides.v1.contract
 * @public
 */

import {
  CLAIMANT_SHARE_DENOMINATOR_PPM,
  type ClaimantShare,
  claimantKey,
} from "@cogni/attribution-ledger";
import {
  deleteReviewSubjectOverrideOperation,
  getReviewSubjectOverridesOperation,
  patchReviewSubjectOverridesOperation,
} from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { checkApprover } from "@/app/api/v1/attribution/_lib/approver-guard";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getNodeId } from "@/shared/config";
import {
  EVENT_NAMES,
  logEvent,
  logRequestWarn,
  type RequestContext,
} from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function parseEpochId(id: string): bigint | null {
  try {
    return BigInt(id);
  } catch {
    return null;
  }
}

function handleRouteError(
  ctx: RequestContext,
  error: unknown
): NextResponse | null {
  if (error && typeof error === "object" && "issues" in error) {
    logRequestWarn(ctx.log, error, "VALIDATION_ERROR");
    return NextResponse.json(
      { error: "Invalid input format" },
      { status: 400 }
    );
  }
  return null;
}

// ── GET: list overrides for epoch ──────────────────────────────

export const GET = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: "ledger.get-review-subject-overrides",
    auth: { mode: "required", getSessionUser },
  },
  async (_ctx, _request, _sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    const { id } = await context.params;
    const epochId = parseEpochId(id);
    if (epochId === null) {
      return NextResponse.json({ error: "Invalid epoch ID" }, { status: 400 });
    }

    const store = getContainer().attributionStore;
    const epoch = await store.getEpoch(epochId);
    if (!epoch) {
      return NextResponse.json({ error: "Epoch not found" }, { status: 404 });
    }

    const overrides = await store.getReviewSubjectOverridesForEpoch(epochId);

    return NextResponse.json(
      getReviewSubjectOverridesOperation.output.parse({
        overrides: overrides.map((o) => ({
          id: o.id,
          subjectRef: o.subjectRef,
          overrideUnits: o.overrideUnits?.toString() ?? null,
          overrideShares: o.overrideSharesJson ?? null,
          overrideReason: o.overrideReason,
          createdAt: o.createdAt.toISOString(),
          updatedAt: o.updatedAt.toISOString(),
        })),
      })
    );
  }
);

// ── PATCH: upsert subject overrides ─────────────────────────────

export const PATCH = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: "ledger.patch-review-subject-overrides",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser, context) => {
    try {
      const denied = checkApprover(ctx, sessionUser?.walletAddress);
      if (denied) return denied;

      if (!context) throw new Error("context required for dynamic routes");
      const { id } = await context.params;
      const epochId = parseEpochId(id);
      if (epochId === null) {
        return NextResponse.json(
          { error: "Invalid epoch ID" },
          { status: 400 }
        );
      }

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return NextResponse.json(
          { error: "Invalid JSON body" },
          { status: 400 }
        );
      }

      const input = patchReviewSubjectOverridesOperation.input.parse(body);

      const store = getContainer().attributionStore;
      const epoch = await store.getEpoch(epochId);
      if (!epoch) {
        return NextResponse.json({ error: "Epoch not found" }, { status: 404 });
      }

      if (epoch.status !== "review") {
        return NextResponse.json(
          { error: "Epoch must be in review status for overrides" },
          { status: 409 }
        );
      }

      // Load locked claimants to validate subject refs and claimant keys
      const lockedClaimants = await store.loadLockedClaimants(epochId);
      if (lockedClaimants.length === 0) {
        return NextResponse.json(
          {
            error:
              "No locked claimants found — epoch must have locked claimants before overrides",
          },
          { status: 409 }
        );
      }

      // Build lookup: receiptId → claimantKeys
      const receiptClaimantMap = new Map(
        lockedClaimants.map((c) => [c.receiptId, c.claimantKeys])
      );

      // Validate each override
      for (const override of input.overrides) {
        const claimantKeys = receiptClaimantMap.get(override.subjectRef);
        if (!claimantKeys) {
          return NextResponse.json(
            {
              error: `Unknown subject_ref: ${override.subjectRef}`,
            },
            { status: 400 }
          );
        }

        if (override.overrideShares) {
          // Validate shares sum to exactly DENOMINATOR PPM
          const shareSum = override.overrideShares.reduce(
            (sum, s) => sum + s.sharePpm,
            0
          );
          if (shareSum !== CLAIMANT_SHARE_DENOMINATOR_PPM) {
            return NextResponse.json(
              {
                error: `Shares for ${override.subjectRef} sum to ${shareSum}, must be exactly ${CLAIMANT_SHARE_DENOMINATOR_PPM}`,
              },
              { status: 400 }
            );
          }

          // Validate unique claimant keys (no duplicates)
          const overrideKeys = override.overrideShares.map((s) =>
            claimantKey(s.claimant)
          );
          if (new Set(overrideKeys).size !== overrideKeys.length) {
            return NextResponse.json(
              {
                error: `Duplicate claimant keys in override shares for ${override.subjectRef}`,
              },
              { status: 400 }
            );
          }

          // Validate completeness: must include ALL locked claimants (explicit 0 allowed)
          const existingClaimantKeys = new Set(claimantKeys);
          for (const key of overrideKeys) {
            if (!existingClaimantKeys.has(key)) {
              return NextResponse.json(
                {
                  error: `Claimant ${key} not found in original subject ${override.subjectRef} — cannot add new claimants via override`,
                },
                { status: 400 }
              );
            }
          }
          const overrideKeySet = new Set(overrideKeys);
          for (const key of claimantKeys) {
            if (!overrideKeySet.has(key)) {
              return NextResponse.json(
                {
                  error: `Locked claimant ${key} missing from override shares for ${override.subjectRef} — all claimants must be included (use sharePpm: 0 to exclude)`,
                },
                { status: 400 }
              );
            }
          }

          // Validate deterministic sort order
          const expectedOrder = [...overrideKeys].sort((a, b) =>
            a.localeCompare(b)
          );
          for (let i = 0; i < overrideKeys.length; i++) {
            if (overrideKeys[i] !== expectedOrder[i]) {
              return NextResponse.json(
                {
                  error: `Override shares for ${override.subjectRef} must be sorted by claimant key (lexicographic)`,
                },
                { status: 400 }
              );
            }
          }
        }
      }

      // Upsert all overrides atomically in a single transaction
      const nodeId = getNodeId();
      const results = await store.batchUpsertReviewSubjectOverrides(
        input.overrides.map((override) => ({
          nodeId,
          epochId,
          subjectRef: override.subjectRef,
          overrideUnits: override.overrideUnits ?? null,
          overrideSharesJson: override.overrideShares
            ? (override.overrideShares as ClaimantShare[])
            : null,
          overrideReason: override.overrideReason ?? null,
        }))
      );
      const upserted = results.length;

      logEvent(ctx.log, EVENT_NAMES.LEDGER_REVIEW_SUBJECT_OVERRIDES_UPDATED, {
        reqId: ctx.reqId,
        routeId: "ledger.patch-review-subject-overrides",
        epochId: id,
        upserted,
      });

      return NextResponse.json(
        patchReviewSubjectOverridesOperation.output.parse({ upserted })
      );
    } catch (error) {
      const errorResponse = handleRouteError(ctx, error);
      if (errorResponse) return errorResponse;
      throw error;
    }
  }
);

// ── DELETE: remove a subject override ────────────────────────────

export const DELETE = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: "ledger.delete-review-subject-override",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser, context) => {
    try {
      const denied = checkApprover(ctx, sessionUser?.walletAddress);
      if (denied) return denied;

      if (!context) throw new Error("context required for dynamic routes");
      const { id } = await context.params;
      const epochId = parseEpochId(id);
      if (epochId === null) {
        return NextResponse.json(
          { error: "Invalid epoch ID" },
          { status: 400 }
        );
      }

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return NextResponse.json(
          { error: "Invalid JSON body" },
          { status: 400 }
        );
      }

      const input = deleteReviewSubjectOverrideOperation.input.parse(body);

      const store = getContainer().attributionStore;
      const epoch = await store.getEpoch(epochId);
      if (!epoch) {
        return NextResponse.json({ error: "Epoch not found" }, { status: 404 });
      }

      if (epoch.status !== "review") {
        return NextResponse.json(
          { error: "Epoch must be in review status for overrides" },
          { status: 409 }
        );
      }

      await store.deleteReviewSubjectOverride(epochId, input.subjectRef);

      logEvent(ctx.log, EVENT_NAMES.LEDGER_REVIEW_SUBJECT_OVERRIDES_UPDATED, {
        reqId: ctx.reqId,
        routeId: "ledger.delete-subject-override",
        epochId: id,
        subjectRef: input.subjectRef,
      });

      return NextResponse.json({ deleted: true });
    } catch (error) {
      const errorResponse = handleRouteError(ctx, error);
      if (errorResponse) return errorResponse;
      throw error;
    }
  }
);
