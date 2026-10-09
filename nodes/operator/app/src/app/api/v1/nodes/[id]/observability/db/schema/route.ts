// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/observability/db/schema`
 * Purpose: Serve a node's APPLIED migration state as operator-held deployment metadata.
 * Scope: Thin shell that does not connect to a node database and holds no node DSN — Cogni-token auth,
 *   developer-RBAC gate (the SAME `node.flight` tuple as flight), resolve {slug|node_id} via the shared
 *   node-rbac seam, read the injected store. Answers "did my migration land?" without SSH, without a box.
 * Invariants:
 *   - COGNI_TOKEN_ONLY (Bearer-first); DEVELOPER_GATED (`node.flight`); fail-closed without a store.
 *   - OPERATOR_HOLDS_METADATA_NOT_DATA_ACCESS: the answer comes from the OPERATOR's own Postgres,
 *     populated by the node's own migrator. There is no credential here that can read `cogni_<node>`
 *     (docs/spec/multi-node-tenancy.md NO_CROSS_NODE_QUERIES).
 *   - SILENCE_IS_NOT_SUCCESS: a node that has never reported returns `state:"never_reported"` with null
 *     contents — never an empty applied list, which would read as "migrated, nothing pending".
 *   - GRACEFUL_UNWIRED: 503 `observability_unwired` when the report store is not wired on this runtime.
 *   - TERMINAL_EVENT: exactly one `feature.node_observability_db_schema.complete` per request — outcome
 *     + errorCode + nodeId/env + counts + state only. Never a migration tag, hash, or DSN.
 * Side-effects: IO (registry read, authz check, operator Postgres read)
 * Links: src/features/nodes/observability-db-schema.ts, src/ports/node-migration-report.port.ts,
 *   observability/logs/route.ts (same tuple, same shape), docs/spec/databases.md § 2
 * @public
 */

import { NextResponse } from "next/server";

import { getSessionUser } from "@/app/_lib/auth/session";
import { resolveNodeAndAuthorize } from "@/app/_lib/node-rbac";
import { getContainer } from "@/bootstrap/container";
import { getCurrentTraceId } from "@/bootstrap/otel";
import {
  FLIGHT_ENVS,
  isFlightEnv,
  shapeSchemaReadout,
} from "@/features/nodes/observability-db-schema";
import {
  createRequestContext,
  EVENT_NAMES,
  logEvent,
  makeLogger,
} from "@/shared/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const baseLog = makeLogger();
const clock = { now: () => new Date().toISOString() };

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(
  request: Request,
  ctx: RouteParams
): Promise<NextResponse> {
  const startedAt = performance.now();
  const reqCtx = createRequestContext({ baseLog, clock }, request, {
    routeId: "nodes.observability-db-schema",
    traceId: getCurrentTraceId(),
    session: undefined,
  });

  // Single deterministic terminal event. Privacy: enums/ids/counts only — never a migration tag or
  // hash (row contents) and never a DSN.
  const logComplete = (fields: {
    outcome: "success" | "error";
    status: number;
    errorCode?: string;
    nodeRef?: string;
    nodeId?: string;
    env?: string;
    state?: string;
    appliedCount?: number;
    missingCount?: number;
  }): void => {
    const payload = {
      reqId: reqCtx.reqId,
      routeId: reqCtx.routeId,
      durationMs: Math.round(performance.now() - startedAt),
      ...fields,
    };
    if (fields.outcome === "success") {
      logEvent(
        reqCtx.log,
        EVENT_NAMES.NODE_OBSERVABILITY_DB_SCHEMA_COMPLETE,
        payload,
        EVENT_NAMES.NODE_OBSERVABILITY_DB_SCHEMA_COMPLETE
      );
      return;
    }
    const level = fields.status >= 500 ? "error" : "warn";
    reqCtx.log[level](
      {
        event: EVENT_NAMES.NODE_OBSERVABILITY_DB_SCHEMA_COMPLETE,
        ...payload,
      },
      EVENT_NAMES.NODE_OBSERVABILITY_DB_SCHEMA_COMPLETE
    );
  };

  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    logComplete({ outcome: "error", status: 401, errorCode: "unauthorized" });
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;

  // Resolve {id} (repo-spec node_id OR slug) against the FULL registry, any status, then
  // developer-gate on the SAME `node.flight` tuple as flight — fail-closed without a store.
  const gate = await resolveNodeAndAuthorize({
    id,
    userId: sessionUser.id,
    action: "node.flight",
  });
  if (!gate.ok) {
    logComplete({
      outcome: "error",
      status: gate.status,
      errorCode: gate.errorCode,
      nodeRef: id,
    });
    return NextResponse.json(
      { error: gate.errorCode },
      { status: gate.status }
    );
  }
  const node = gate.node;

  const env = new URL(request.url).searchParams.get("env");
  if (!isFlightEnv(env)) {
    logComplete({
      outcome: "error",
      status: 400,
      errorCode: "invalid_env",
      nodeId: node.nodeId,
    });
    return NextResponse.json(
      {
        error: "invalid_env",
        message: `env must be one of ${FLIGHT_ENVS.join(", ")}`,
      },
      { status: 400 }
    );
  }

  // The operator holds the metadata; a dev holds no database credential. 503 until the store is
  // wired on this runtime (no operator DATABASE_URL ⇒ no deployment metadata to serve).
  const store = getContainer().nodeMigrationReportStore;
  if (!store) {
    logComplete({
      outcome: "error",
      status: 503,
      errorCode: "observability_unwired",
      nodeId: node.nodeId,
      env,
    });
    return NextResponse.json(
      {
        error: "observability_unwired",
        message:
          "operator holds no migration-report store on this runtime — applied migration state " +
          "is operator Postgres metadata and is unavailable until it is wired",
      },
      { status: 503 }
    );
  }

  let readout: ReturnType<typeof shapeSchemaReadout>;
  try {
    readout = shapeSchemaReadout({
      nodeId: node.nodeId,
      slug: node.slug,
      env,
      record: await store.read({ nodeId: node.nodeId, environment: env }),
    });
  } catch (err) {
    logComplete({
      outcome: "error",
      status: 502,
      errorCode: "schema_read_failed",
      nodeId: node.nodeId,
      env,
    });
    return NextResponse.json(
      {
        error: "schema_read_failed",
        message: err instanceof Error ? err.message : "unknown error",
      },
      { status: 502 }
    );
  }

  logComplete({
    outcome: "success",
    status: 200,
    nodeId: node.nodeId,
    env,
    state: readout.state,
    ...(readout.appliedCount === null
      ? {}
      : { appliedCount: readout.appliedCount }),
    ...(readout.drift ? { missingCount: readout.drift.missing.length } : {}),
  });
  return NextResponse.json(readout);
}
