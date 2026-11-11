// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/knowledge/contributions/_handlers`
 * Purpose: HTTP handlers for the external-agent knowledge contribution surface.
 *   Pulls the framework-agnostic ContributionService from the container, maps
 *   SessionUser → Principal, and translates typed service errors to HTTP statuses.
 * Scope: Operator HTTP wiring only. Does not implement contribution mutations or replay uncertain writes.
 * Invariants: VALIDATE_IO, AUTH_VIA_GETSESSIONUSER, KNOWLEDGE_MERGE_REQUIRES_ADMIN_SESSION,
 *   GOAL_CHANGE_IS_NODE_ADMIN (task.5286): a merge whose diff touches a `goal-*` row (or a
 *   citation from one) additionally requires `node.administer` on this node, checked BEFORE
 *   the merge — 403 `authz_denied`, 503 `authz_unavailable`. Every other merge is unchanged.
 *   ANNEX_NOT_CORE (story.0033): a metric row's `serves` and `band` sit beside the hashed spec;
 *   `validateMetricSpec` strips them before `registry.validate` (malformed 400, band unit mismatch 422).
 * Side-effects: IO (HTTP response, Doltgres read/write via container service)
 * Links: docs/design/knowledge-contribution-api.md, packages/knowledge-store
 * @internal
 */

import {
  CitationTargetNotFoundError,
  CitationTypeMismatchError,
  ContributionConflictError,
  ContributionForbiddenError,
  ContributionNotFoundError,
  ContributionStateError,
  DomainNotRegisteredError,
  EmptyKnowledgePatchError,
  HypothesisMissingEvaluateAtError,
  KnowledgeBusyError,
  type KnowledgeContributionEdit,
  KnowledgeGateError,
  KnowledgeWriteConflictError,
  KnowledgeWriteOutcomeUnknownError,
  KnowledgeWriteScopeRequiredError,
  type PrincipalAuthSource,
  sessionUserToPrincipal,
} from "@cogni/knowledge-store";
import {
  ContributionAppendCommitRequestSchema,
  ContributionCloseRequestSchema,
  ContributionMergeCheckRequestSchema,
  ContributionMergeCheckResponseSchema,
  ContributionMergeRequestSchema,
  ContributionsCreateRequestSchema,
  ContributionsListQuerySchema,
} from "@cogni/node-contracts";
import type { SessionUser } from "@cogni/node-shared";
import { calculatorShape } from "@cogni-dao/metrics";
import {
  displayFits,
  KpiBindingsSchema,
  StoredMetricSpecSchema,
} from "@cogni-dao/metrics/contracts";
import { NextResponse } from "next/server";

import { getContainer } from "@/bootstrap/container";
import {
  checkNodeAdmin,
  isGoalRowId,
  nodeAdminFailureBody,
} from "@/bootstrap/node-admin-gate";
import { getNodeId } from "@/shared/config/repoSpec.server";
import { citationEdgesFromDiff } from "./_citation-edges";

function service() {
  const svc = getContainer().knowledgeContributionService;
  if (!svc) {
    return null;
  }
  return svc;
}

/**
 * Detect whether the request resolved via Bearer agent token vs NextAuth cookie.
 * `wrapRouteHandlerWithLogging` resolves both paths to a `SessionUser`; this
 * inspection is the only place we re-derive the auth source for the
 * KNOWLEDGE_LOOP_CLOSED_VIA_SIGNED_IN_USER gate.
 */
function authSource(request: Request): PrincipalAuthSource {
  const authz = request.headers.get("authorization") ?? "";
  return authz.toLowerCase().startsWith("bearer ") ? "bearer" : "session";
}

function mapError(e: unknown): NextResponse {
  if (e instanceof KnowledgeWriteOutcomeUnknownError)
    return NextResponse.json(
      {
        error: e.message,
        errorCode: e.code,
        retryable: false,
        ...e.receipt.lookup,
      },
      { status: 409 }
    );
  if (e instanceof KnowledgeWriteConflictError)
    return NextResponse.json(
      {
        error: e.message,
        errorCode: e.receipt.code,
        retryable: false,
        ...e.receipt.lookup,
      },
      { status: 409 }
    );
  if (e instanceof KnowledgeWriteScopeRequiredError)
    return NextResponse.json(
      {
        error: e.message,
        errorCode: "knowledge_write_scope_required",
        retryable: false,
      },
      { status: 500 }
    );
  if (e instanceof KnowledgeBusyError)
    return NextResponse.json(
      { error: e.message, retryable: true },
      { status: 503, headers: { "Retry-After": "2" } }
    );
  if (e instanceof ContributionForbiddenError)
    return NextResponse.json({ error: e.message }, { status: 403 });
  if (e instanceof ContributionNotFoundError)
    return NextResponse.json({ error: e.message }, { status: 404 });
  if (e instanceof ContributionStateError)
    return NextResponse.json({ error: e.message }, { status: 409 });
  if (e instanceof ContributionConflictError)
    return NextResponse.json({ error: e.message }, { status: 409 });
  if (e instanceof DomainNotRegisteredError)
    return NextResponse.json({ error: e.message }, { status: 400 });
  // PATCH_IS_NOT_EMPTY — a no-op patch is a client contract error, not a 500.
  if (e instanceof EmptyKnowledgePatchError)
    return NextResponse.json({ error: e.message }, { status: 400 });
  // HYPOTHESIS_HAS_EVALUATE_AT — a hypothesis insert without evaluateAt.
  if (e instanceof HypothesisMissingEvaluateAtError)
    return NextResponse.json({ error: e.message }, { status: 400 });
  // A cite/EDO edit whose target resolves on neither the branch nor main, or
  // whose edge type doesn't match the cited entry_type, is a client error —
  // never a 500 (bug.5024). The cross-plane (main ∪ branch) resolution lives in
  // the adapter; these map the genuinely-absent / mistyped cases to typed 4xx.
  if (e instanceof CitationTargetNotFoundError)
    return NextResponse.json(
      { error: e.message, code: "cited_not_found" },
      { status: 404 }
    );
  if (e instanceof CitationTypeMismatchError)
    return NextResponse.json(
      { error: e.message, code: "edge_type_mismatch" },
      { status: 400 }
    );
  if (e instanceof KnowledgeGateError)
    return NextResponse.json(
      { error: "knowledge gate rejected write", issues: e.errors },
      { status: 400 }
    );
  throw e;
}

export async function handleCreate(
  request: Request,
  sessionUser: SessionUser | null
): Promise<NextResponse> {
  if (!sessionUser)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const svc = service();
  if (!svc)
    return NextResponse.json(
      { error: "knowledge contribution service not configured" },
      { status: 503 }
    );

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = ContributionsCreateRequestSchema.safeParse(body);
  if (!parsed.success)
    return NextResponse.json(
      { error: "invalid input", issues: parsed.error.issues },
      { status: 400 }
    );
  const invalidMetric = validateMetricEdits(parsed.data.edits ?? []);
  if (invalidMetric) return invalidMetric;

  const principal = sessionUserToPrincipal(sessionUser, authSource(request));
  const createBody = {
    message: parsed.data.message,
    ...(parsed.data.edits ? { edits: parsed.data.edits } : {}),
    ...(parsed.data.idempotencyKey
      ? { idempotencyKey: parsed.data.idempotencyKey }
      : {}),
  };
  try {
    const record = await svc.create({ principal, body: createBody });
    return NextResponse.json(record, { status: 201 });
  } catch (e) {
    return mapError(e);
  }
}

export async function handleList(
  request: Request,
  sessionUser: SessionUser | null
): Promise<NextResponse> {
  if (!sessionUser)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const svc = service();
  if (!svc)
    return NextResponse.json(
      { error: "knowledge contribution service not configured" },
      { status: 503 }
    );

  const url = new URL(request.url);
  const stateParam = url.searchParams.get("state");
  const principalIdParam = url.searchParams.get("principalId");
  const limitParam = url.searchParams.get("limit");

  const parsed = ContributionsListQuerySchema.safeParse({
    state: stateParam ?? undefined,
    principalId: principalIdParam ?? undefined,
    limit: limitParam ? Number(limitParam) : undefined,
  });
  if (!parsed.success)
    return NextResponse.json(
      { error: "invalid query", issues: parsed.error.issues },
      { status: 400 }
    );

  const principal = sessionUserToPrincipal(sessionUser, authSource(request));
  const query = {
    state: parsed.data.state,
    limit: parsed.data.limit,
    ...(parsed.data.principalId
      ? { principalId: parsed.data.principalId }
      : {}),
  };
  const records = await svc.list({ principal, query });
  return NextResponse.json({ contributions: records });
}

export async function handleGetById(
  contributionId: string,
  sessionUser: SessionUser | null
): Promise<NextResponse> {
  if (!sessionUser)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const svc = service();
  if (!svc)
    return NextResponse.json(
      { error: "knowledge contribution service not configured" },
      { status: 503 }
    );

  const record = await svc.getById(contributionId);
  if (!record)
    return NextResponse.json(
      { error: `contribution not found: ${contributionId}` },
      { status: 404 }
    );
  return NextResponse.json(record);
}

export async function handleAppendCommit(
  request: Request,
  contributionId: string,
  sessionUser: SessionUser | null
): Promise<NextResponse> {
  if (!sessionUser)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const svc = service();
  if (!svc)
    return NextResponse.json(
      { error: "knowledge contribution service not configured" },
      { status: 503 }
    );

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = ContributionAppendCommitRequestSchema.safeParse(body);
  if (!parsed.success)
    return NextResponse.json(
      { error: "invalid input", issues: parsed.error.issues },
      { status: 400 }
    );
  const invalidMetric = validateMetricEdits(parsed.data.edits ?? []);
  if (invalidMetric) return invalidMetric;

  const principal = sessionUserToPrincipal(sessionUser, authSource(request));
  try {
    const commit = await svc.appendCommit({
      principal,
      contributionId,
      body: parsed.data,
    });
    return NextResponse.json(commit, { status: 201 });
  } catch (e) {
    return mapError(e);
  }
}

export async function handleListCommits(
  contributionId: string,
  sessionUser: SessionUser | null
): Promise<NextResponse> {
  if (!sessionUser)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const svc = service();
  if (!svc)
    return NextResponse.json(
      { error: "knowledge contribution service not configured" },
      { status: 503 }
    );

  const record = await svc.getById(contributionId);
  if (!record)
    return NextResponse.json(
      { error: `contribution not found: ${contributionId}` },
      { status: 404 }
    );
  const commits = await svc.listCommits(contributionId);
  return NextResponse.json({ contributionId, commits });
}

export async function handleDiff(
  contributionId: string,
  sessionUser: SessionUser | null
): Promise<NextResponse> {
  if (!sessionUser)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const svc = service();
  if (!svc)
    return NextResponse.json(
      { error: "knowledge contribution service not configured" },
      { status: 503 }
    );

  const record = await svc.getById(contributionId);
  if (!record)
    return NextResponse.json(
      { error: `contribution not found: ${contributionId}` },
      { status: 404 }
    );
  const entries = await svc.diff(contributionId);
  return NextResponse.json({
    contributionId,
    branch: record.branch,
    entries,
    citations: citationEdgesFromDiff(entries),
  });
}

/** Explicit admitted diagnostic; an empty displayed diff is never merge proof. */
export async function handleMergeCheck(
  request: Request,
  contributionId: string,
  sessionUser: SessionUser | null
): Promise<NextResponse> {
  const headers = { "Cache-Control": "no-store" };
  if (!sessionUser)
    return NextResponse.json(
      { error: "unauthorized" },
      { status: 401, headers }
    );
  const svc = service();
  if (!svc)
    return NextResponse.json(
      { error: "knowledge contribution service not configured" },
      { status: 503, headers }
    );
  let body: unknown;
  try {
    const text = await request.text();
    body = text ? JSON.parse(text) : {};
  } catch {
    return NextResponse.json(
      { error: "invalid JSON body" },
      { status: 400, headers }
    );
  }
  if (!ContributionMergeCheckRequestSchema.safeParse(body).success)
    return NextResponse.json(
      { error: "merge check accepts only an empty object" },
      { status: 400, headers }
    );
  const result = ContributionMergeCheckResponseSchema.parse(
    await svc.previewMerge(contributionId)
  );
  return NextResponse.json(result, { headers });
}

/** A diff entry that changes a goal row, or a citation edge leaving one. */
function touchesGoal(entry: {
  rowId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}): boolean {
  return (
    isGoalRowId(entry.rowId) ||
    isGoalRowId(entry.before?.citingId) ||
    isGoalRowId(entry.after?.citingId)
  );
}

export async function handleMerge(
  request: Request,
  contributionId: string,
  sessionUser: SessionUser | null
): Promise<NextResponse> {
  if (!sessionUser)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const svc = service();
  if (!svc)
    return NextResponse.json(
      { error: "knowledge contribution service not configured" },
      { status: 503 }
    );

  let body: unknown = {};
  try {
    const text = await request.text();
    body = text ? JSON.parse(text) : {};
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = ContributionMergeRequestSchema.safeParse(body);
  if (!parsed.success)
    return NextResponse.json(
      { error: "invalid input", issues: parsed.error.issues },
      { status: 400 }
    );

  const principal = sessionUserToPrincipal(sessionUser, authSource(request));
  try {
    // GOAL_CHANGE_IS_NODE_ADMIN — read the diff first so the check precedes the merge.
    const entries = await svc.diff(contributionId);
    if (entries.some(touchesGoal)) {
      const gate = await checkNodeAdmin(getContainer().authorization, {
        userId: sessionUser.id,
        nodeId: getNodeId(),
      });
      if (!gate.ok) {
        return NextResponse.json(
          nodeAdminFailureBody(gate, "knowledge.contributions.merge.goal"),
          { status: gate.status }
        );
      }
    }
    const result = await svc.merge({
      principal,
      contributionId,
    });
    return NextResponse.json({ contributionId, ...result });
  } catch (e) {
    return mapError(e);
  }
}

export async function handleClose(
  request: Request,
  contributionId: string,
  sessionUser: SessionUser | null
): Promise<NextResponse> {
  if (!sessionUser)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const svc = service();
  if (!svc)
    return NextResponse.json(
      { error: "knowledge contribution service not configured" },
      { status: 503 }
    );

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = ContributionCloseRequestSchema.safeParse(body);
  if (!parsed.success)
    return NextResponse.json(
      { error: "invalid input", issues: parsed.error.issues },
      { status: 400 }
    );

  const principal = sessionUserToPrincipal(sessionUser, authSource(request));
  try {
    await svc.close({
      principal,
      contributionId,
      reason: parsed.data.reason,
    });
    return NextResponse.json({ contributionId, closed: true });
  } catch (e) {
    return mapError(e);
  }
}

/**
 * Goal-metric configuration gate (story.0021): a `metricSpec` must parse strictly, name a
 * registered @cogni-dao/metrics calculator, and carry a display its unit can honour (plus an
 * optional `serves` link and `band` whose target unit matches the metric unit, story.0033);
 * `kpiBindings` must parse, and hypothesis bindings must pin evaluation + baseline.
 */
function validateMetricEdits(
  edits: readonly KnowledgeContributionEdit[]
): NextResponse | null {
  for (const edit of edits) {
    if (edit.op !== "insert" && edit.op !== "update") continue;
    const entry = edit.entry;
    if (entry.metricSpec != null) {
      const invalid = validateMetricSpec(
        entry.metricSpec,
        edit.op === "update" ? edit.targetRowId : entry.id,
        entry.title
      );
      if (invalid) return invalid;
    }
    if (entry.kpiBindings == null) continue;
    const bindings = KpiBindingsSchema.safeParse(entry.kpiBindings);
    if (!bindings.success)
      return NextResponse.json(
        { error: "invalid KPI bindings" },
        { status: 400 }
      );
    if (
      entry.entryType === "hypothesis" &&
      bindings.data.length > 0 &&
      !bindings.data.every((b) => b.evaluationAt && b.baselineObservationId)
    )
      return NextResponse.json(
        {
          error:
            "hypothesis KPI bindings require a fixed evaluation and baseline observation",
        },
        { status: 422 }
      );
  }
  return null;
}

/**
 * A stored metric spec must parse strictly. The core spec names a registered calculator and
 * carries a display its unit can honour; `serves` and `band` (story.0033) are validated by
 * their own schemas (a malformed one is a 400 here, at authoring) and never reach the strict
 * MetricSpecSchema, so they cannot fork the series hash.
 */
export function validateMetricSpec(
  stored: unknown,
  id: string,
  title: string
): NextResponse | null {
  const parsed = StoredMetricSpecSchema.safeParse(stored);
  if (!parsed.success)
    return NextResponse.json(
      { error: "invalid metric definition", issues: parsed.error.issues },
      { status: 400 }
    );
  const { display, serves: _serves, band, ...spec } = parsed.data;
  const registry = getContainer().goalMetrics?.registry;
  try {
    registry?.validate({ id, title, revision: "proposed", spec });
  } catch {
    return NextResponse.json(
      { error: "unsupported calculator or parameters" },
      { status: 422 }
    );
  }
  const unit = registry
    ? calculatorShape(registry.get(spec.calculatorId), spec.params).unit
    : null;
  if (display && unit !== null && !displayFits(display, unit))
    return NextResponse.json(
      { error: "display does not fit the metric unit (slo needs %)" },
      { status: 422 }
    );
  if (band && unit !== null && band.target.unit !== unit)
    return NextResponse.json(
      { error: `band target unit must match the metric unit (${unit})` },
      { status: 422 }
    );
  return null;
}
