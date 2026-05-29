// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/edo/_handlers`
 * Purpose: HTTP handlers for the external-agent EDO hypothesis-loop surface.
 *   Mirrors the bearer-auth + principal-derivation pattern from
 *   `knowledge/contributions/_handlers.ts`. Pulls `EdoCapability` from the
 *   container; principal is derived from the auth path (bearer = agent,
 *   session = human). All adapter invariants enforced by the capability /
 *   adapter — handlers map known typed errors to HTTP status codes.
 * Scope: Operator-side wiring for `POST /api/v1/edo/{hypothesize,decide,record-outcome}`.
 * Invariants: VALIDATE_IO, AUTH_VIA_GETSESSIONUSER, PRINCIPAL_DERIVES_SOURCE
 *   (caller MUST NOT supply sourceType/sourceRef/sourceNode — those are
 *   bound from the authenticated principal so external agents cannot forge
 *   identity).
 * Side-effects: IO (HTTP response, Doltgres write via container capability)
 * Links: docs/spec/knowledge-syntropy.md § The Hypothesis Loop
 * @internal
 */

import {
  EdoDecideInputSchema,
  EdoHypothesizeInputSchema,
  EdoRecordOutcomeInputSchema,
} from "@cogni/ai-tools";
import {
  CitationTargetNotFoundError,
  CitationTypeMismatchError,
  DomainNotRegisteredError,
  EdoEntryTypeRequiresAtomicToolError,
  HypothesisMissingEvaluateAtError,
  type PrincipalAuthSource,
  sessionUserToPrincipal,
} from "@cogni/knowledge-store";
import type { SessionUser } from "@cogni/node-shared";
import { NextResponse } from "next/server";

import { getContainer } from "@/bootstrap/container";

/**
 * Same auth-source detector used by knowledge/contributions. Bearer agents
 * become `kind: 'agent'` principals → sourceType 'agent'. Session-cookie
 * users become `kind: 'user'` principals → sourceType 'human'.
 */
function authSource(request: Request): PrincipalAuthSource {
  const authz = request.headers.get("authorization") ?? "";
  return authz.toLowerCase().startsWith("bearer ") ? "bearer" : "session";
}

function mapError(e: unknown): NextResponse {
  if (e instanceof HypothesisMissingEvaluateAtError)
    return NextResponse.json({ error: e.message }, { status: 400 });
  if (e instanceof CitationTargetNotFoundError)
    return NextResponse.json({ error: e.message }, { status: 404 });
  if (e instanceof CitationTypeMismatchError)
    return NextResponse.json({ error: e.message }, { status: 409 });
  if (e instanceof DomainNotRegisteredError)
    return NextResponse.json({ error: e.message }, { status: 400 });
  if (e instanceof EdoEntryTypeRequiresAtomicToolError)
    return NextResponse.json({ error: e.message }, { status: 400 });
  throw e;
}

/**
 * Strip principal-derivable fields from the tool input schemas. The wire
 * contract for the REST surface MUST NOT accept caller-supplied identity —
 * sourceType/sourceRef/sourceNode are bound from the authenticated principal.
 * Per the design-review feedback, this closes the forge-able-identity hole
 * that the langgraph tool surface tolerates (because langgraph callers are
 * already inside the trust boundary).
 */
const HypothesizeRequestSchema = EdoHypothesizeInputSchema.omit({
  sourceType: true,
  sourceRef: true,
  sourceNode: true,
});
const DecideRequestSchema = EdoDecideInputSchema.omit({
  sourceType: true,
  sourceRef: true,
  sourceNode: true,
});
const RecordOutcomeRequestSchema = EdoRecordOutcomeInputSchema.omit({
  sourceType: true,
  sourceRef: true,
  sourceNode: true,
});

interface DerivedSource {
  readonly sourceType: "agent" | "human";
  readonly sourceRef: string;
  readonly sourceNode: string;
}

function deriveSource(
  sessionUser: SessionUser,
  request: Request
): DerivedSource {
  const principal = sessionUserToPrincipal(sessionUser, authSource(request));
  return {
    sourceType: principal.kind === "user" ? "human" : "agent",
    sourceRef: `principal:${principal.id}${principal.name ? `:${principal.name}` : ""}`,
    sourceNode: "operator",
  };
}

async function readJson(
  request: Request
): Promise<{ ok: true; body: unknown } | { ok: false; res: NextResponse }> {
  try {
    return { ok: true, body: await request.json() };
  } catch {
    return {
      ok: false,
      res: NextResponse.json({ error: "invalid JSON body" }, { status: 400 }),
    };
  }
}

export async function handleHypothesize(
  request: Request,
  sessionUser: SessionUser | null
): Promise<NextResponse> {
  if (!sessionUser)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const json = await readJson(request);
  if (!json.ok) return json.res;
  const parsed = HypothesizeRequestSchema.safeParse(json.body);
  if (!parsed.success)
    return NextResponse.json(
      { error: "invalid input", issues: parsed.error.issues },
      { status: 400 }
    );

  const { sourceType, sourceRef, sourceNode } = deriveSource(
    sessionUser,
    request
  );
  const edo = getContainer().edoCapability;
  const log = getContainer().log;
  try {
    const entry = await edo.hypothesize({
      id: parsed.data.id,
      domain: parsed.data.domain,
      title: parsed.data.title,
      content: parsed.data.content,
      evaluateAt: new Date(parsed.data.evaluateAt),
      resolutionStrategy:
        parsed.data.resolutionStrategy === "manual" ||
        parsed.data.resolutionStrategy === undefined
          ? null
          : parsed.data.resolutionStrategy,
      sourceType,
      sourceRef,
      sourceNode,
      ...(parsed.data.evidenceForIds !== undefined
        ? { evidenceForIds: parsed.data.evidenceForIds }
        : {}),
      ...(parsed.data.tags !== undefined ? { tags: parsed.data.tags } : {}),
      ...(parsed.data.confidencePct !== undefined
        ? { confidencePct: parsed.data.confidencePct }
        : {}),
    });
    log.info(
      { route: "edo.hypothesize", entryId: entry.id, sourceRef },
      "edo.hypothesize.success"
    );
    return NextResponse.json(
      { entry, evaluateAt: parsed.data.evaluateAt, committed: true },
      { status: 201 }
    );
  } catch (e) {
    return mapError(e);
  }
}

export async function handleDecide(
  request: Request,
  sessionUser: SessionUser | null
): Promise<NextResponse> {
  if (!sessionUser)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const json = await readJson(request);
  if (!json.ok) return json.res;
  const parsed = DecideRequestSchema.safeParse(json.body);
  if (!parsed.success)
    return NextResponse.json(
      { error: "invalid input", issues: parsed.error.issues },
      { status: 400 }
    );

  const { sourceType, sourceRef, sourceNode } = deriveSource(
    sessionUser,
    request
  );
  const edo = getContainer().edoCapability;
  const log = getContainer().log;
  try {
    const entry = await edo.decide({
      id: parsed.data.id,
      domain: parsed.data.domain,
      title: parsed.data.title,
      content: parsed.data.content,
      derivesFromHypothesisId: parsed.data.derivesFromHypothesisId,
      sourceType,
      sourceRef,
      sourceNode,
      ...(parsed.data.tags !== undefined ? { tags: parsed.data.tags } : {}),
      ...(parsed.data.confidencePct !== undefined
        ? { confidencePct: parsed.data.confidencePct }
        : {}),
    });
    log.info(
      {
        route: "edo.decide",
        entryId: entry.id,
        sourceRef,
        derivesFromHypothesisId: parsed.data.derivesFromHypothesisId,
      },
      "edo.decide.success"
    );
    return NextResponse.json({ entry, committed: true }, { status: 201 });
  } catch (e) {
    return mapError(e);
  }
}

// ---------------------------------------------------------------------------
// Chain-walk read
// ---------------------------------------------------------------------------

const CHAIN_DIRECTIONS = new Set(["out", "in", "both"] as const);
type ChainDir = "out" | "in" | "both";
const CHAIN_MAX_DEPTH = 10;
const CHAIN_DEFAULT_DEPTH = 5;

export async function handleChainGet(
  request: Request,
  sessionUser: SessionUser | null,
  rootId: string
): Promise<NextResponse> {
  if (!sessionUser)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (!rootId || rootId.length > 200) {
    return NextResponse.json(
      { error: "invalid root id" },
      { status: 400 }
    );
  }

  const url = new URL(request.url);
  const directionRaw = url.searchParams.get("direction") ?? "both";
  if (!CHAIN_DIRECTIONS.has(directionRaw as ChainDir)) {
    return NextResponse.json(
      { error: "invalid direction; expected out|in|both" },
      { status: 400 }
    );
  }
  const direction = directionRaw as ChainDir;

  const maxDepthRaw = url.searchParams.get("maxDepth");
  let maxDepth = CHAIN_DEFAULT_DEPTH;
  if (maxDepthRaw !== null) {
    const parsed = Number(maxDepthRaw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > CHAIN_MAX_DEPTH) {
      return NextResponse.json(
        { error: `invalid maxDepth; expected integer 1..${CHAIN_MAX_DEPTH}` },
        { status: 400 }
      );
    }
    maxDepth = parsed;
  }

  const edo = getContainer().edoCapability;
  const log = getContainer().log;
  try {
    const result = await edo.getChain({ rootId, direction, maxDepth });
    log.info(
      {
        route: "edo.chain",
        rootId,
        direction,
        maxDepth,
        chainLength: result.chain.length,
      },
      "edo.chain.success"
    );
    return NextResponse.json(result, { status: 200 });
  } catch (e) {
    if (
      e instanceof Error &&
      e.message.startsWith("getChain: root entry ")
    ) {
      return NextResponse.json({ error: e.message }, { status: 404 });
    }
    return mapError(e);
  }
}

export async function handleRecordOutcome(
  request: Request,
  sessionUser: SessionUser | null
): Promise<NextResponse> {
  if (!sessionUser)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const json = await readJson(request);
  if (!json.ok) return json.res;
  const parsed = RecordOutcomeRequestSchema.safeParse(json.body);
  if (!parsed.success)
    return NextResponse.json(
      { error: "invalid input", issues: parsed.error.issues },
      { status: 400 }
    );

  const { sourceType, sourceRef, sourceNode } = deriveSource(
    sessionUser,
    request
  );
  const edo = getContainer().edoCapability;
  const log = getContainer().log;
  try {
    const result = await edo.recordOutcome({
      id: parsed.data.id,
      domain: parsed.data.domain,
      title: parsed.data.title,
      content: parsed.data.content,
      hypothesisId: parsed.data.hypothesisId,
      edge: parsed.data.edge,
      sourceType,
      sourceRef,
      sourceNode,
      ...(parsed.data.tags !== undefined ? { tags: parsed.data.tags } : {}),
      ...(parsed.data.confidencePct !== undefined
        ? { confidencePct: parsed.data.confidencePct }
        : {}),
    });
    log.info(
      {
        route: "edo.record_outcome",
        outcomeId: result.outcome.id,
        sourceRef,
        hypothesisId: result.hypothesisId,
        edge: parsed.data.edge,
        resolvedConfidence: result.resolvedConfidence,
        alreadyResolved: result.alreadyResolved,
      },
      "edo.record_outcome.success"
    );
    return NextResponse.json(
      { ...result, committed: true },
      { status: result.alreadyResolved ? 200 : 201 }
    );
  } catch (e) {
    return mapError(e);
  }
}
