// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/deploy-state`
 * Purpose: The operator's read-only SEE flow — GET the per-env deploy state for ONE node so the app
 *   can show "candidate-a ✓ / preview ✓ / production ✗" and a wizard-test junk node (live nowhere) is
 *   visibly distinct from a real one. v0 is probe-backed (public `serving`): coarse live/not-live +
 *   `buildSha` per env, no cluster auth. Swaps to a richer Argo adapter behind `DeployCapability`.
 * Scope: Thin HTTP shell — Cogni-token auth, developer-RBAC gate (the SAME `node.flight` tuple as
 *   flight / flight-status / observability), resolve {id} via the shared node-rbac seam, delegate to
 *   the injected `DeployCapability`. No cluster/GH/Grafana auth. PLUS (story.5039) the money-loop
 *   read: this node's live paid-lease receipts + orphan diff via the injected
 *   `LeaseReadCapability` — omitted (not empty) when that capability is unwired. Closure is
 *   honestly "unknown" app-side: the app holds no Console key (task.5138); the authoritative
 *   closure proof is in-actuator (bug.5189). Adds all-state receipt evidence and exact-key
 *   lookup, with node/environment ownership checked before public native Akash reads (bug.5556).
 *   Native chain enums are facts, never Console lifecycle inputs or closure proof.
 * Invariants:
 *   - COGNI_TOKEN_ONLY (getSessionUser = Bearer-first); READ_ONLY; NO_CLUSTER_AUTH.
 *   - DEVELOPER_GATED: requires `node.flight` (→ `can_flight from developer`); fail-closed without a store.
 *   - CAPABILITY_INJECTION: reads `getContainer().deployCapability`; 503 when unwired (no base domain).
 *   - TERMINAL_EVENT: exactly one `feature.node_deploy_state.complete` per request — outcome + status +
 *     nodeId, coverage, counts and latency only (no secrets, keys or host list).
 * Side-effects: IO (registry/ledger reads, authz check, public network probes and LCD GETs)
 * Links: src/adapters/server/deploy/probe-deploy.adapter.ts, src/bootstrap/capabilities/deploy.ts,
 *   flight-status/route.ts (same tuple), docs/design/operator-managed-deployments.md § SEE
 * @public
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { getSessionUser } from "@/app/_lib/auth/session";
import { resolveNodeAndAuthorize } from "@/app/_lib/node-rbac";
import type { LeaseReadCapability } from "@/bootstrap/capabilities/compute-leases";
import { getContainer, resolveServiceDb } from "@/bootstrap/container";
import { getCurrentTraceId } from "@/bootstrap/otel";
import {
  classifyReceiptClosure,
  orphanDiff,
  verifyLeaseClosures,
} from "@/features/compute/lease-closure-verification";
import { FLIGHT_ENVS } from "@/features/nodes/flight-status";
import { nodeIdOrSlug } from "@/features/nodes/node-lookup";
import { nodes } from "@/shared/db/nodes";
import {
  createRequestContext,
  EVENT_NAMES,
  logEvent,
  makeLogger,
} from "@/shared/observability";
import type { AkashNativeObservation } from "@/types/akash-native-state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Probing three envs (each a /readyz + /version round-trip) can exceed the default budget on a cold edge.
export const maxDuration = 60;

const baseLog = makeLogger();
const clock = { now: () => new Date().toISOString() };

interface RouteParams {
  params: Promise<{ id: string }>;
}

const replicaCountsSchema = z.object({
  desired: z.number(),
  ready: z.number(),
});

const nodeDeployStateSchema = z.object({
  env: z.string(),
  node: z.string(),
  sourceSha: z.string().nullable(),
  digest: z.string().nullable(),
  buildSha: z.string().nullable(),
  health: z.enum(["healthy", "degraded", "provisioning", "unknown"]),
  replicas: replicaCountsSchema,
});

/** One durable paid-lease receipt + its closure verdict (story.5039, bug.5189, task.5138). */
const leaseStateSchema = z.object({
  environment: z.string(),
  cogniKey: z.string(),
  state: z.string(),
  externalName: z.string().nullable(),
  /** Console read-back verdict — `closed` is only ever asserted from provider evidence. */
  closure: z.enum(["closed", "open", "unknown"]),
});

type Receipt = NonNullable<Awaited<ReturnType<LeaseReadCapability["read"]>>>;
const coverageSchema = z.object({
  status: z.enum(["complete", "truncated", "potentially_truncated", "unknown"]),
  observedAt: z.string().nullable(),
  limit: z.number().optional(),
});
const nativeSchema = z.object({
  source: z.string().nullable(),
  observedAt: z.string().nullable(),
  deploymentState: z.enum(["active", "closed"]).nullable(),
  deploymentCoverage: z.enum(["complete", "unknown"]),
  deploymentObservedAt: z.string().nullable(),
  leaseStates: z.array(
    z.object({
      id: z.object({
        owner: z.string(),
        dseq: z.string(),
        gseq: z.number(),
        oseq: z.number(),
        provider: z.string(),
        bseq: z.number(),
      }),
      state: z.enum(["active", "insufficient_funds", "closed", "reclaiming"]),
      observedAt: z.string(),
    })
  ),
  leaseCoverage: z.enum(["complete", "partial", "unknown"]),
  leasePages: z.array(z.object({ observedAt: z.string(), count: z.number() })),
  errorCode: z.string().nullable(),
});
const receiptStateSchema = z.object({
  environment: z.string(),
  cogniKey: z.string(),
  ledgerState: z.string(),
  externalName: z.string().nullable(),
  ledgerProvider: z.string().nullable(),
  closure: z.enum(["closed", "open", "unknown"]),
  native: nativeSchema,
});
const querySchema = z
  .object({
    cogniKey: z
      .string()
      .min(1)
      .max(512)
      .refine(
        (s) =>
          s.trim() === s &&
          [...s].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
      )
      .optional(),
    environment: z.enum(FLIGHT_ENVS).optional(),
  })
  .strict();
const unknownNative = (
  errorCode: "not_requested" | "reader_unavailable"
): AkashNativeObservation => ({
  source: null,
  observedAt: null,
  deploymentState: null,
  deploymentCoverage: "unknown",
  deploymentObservedAt: null,
  leaseStates: [],
  leaseCoverage: "unknown",
  leasePages: [],
  errorCode,
});
const projectReceipt = (receipt: Receipt, native: AkashNativeObservation) => ({
  environment: receipt.environment,
  cogniKey: receipt.cogniKey,
  ledgerState: receipt.state,
  externalName: receipt.externalName ?? null,
  ledgerProvider: receipt.providerAccount ?? null,
  closure: classifyReceiptClosure(receipt, undefined),
  native,
});

const deployStateResponseSchema = z.object({
  nodeId: z.string(),
  slug: z.string(),
  /** Per-env deploy state for this node, one cell per deploy env. */
  envs: z.array(nodeDeployStateSchema),
  /** Convenience rollup: the envs the node is currently live (serving) in. */
  liveEnvs: z.array(z.string()),
  /**
   * This node's LIVE paid-lease receipts (akash lanes) — the money-loop SEE half of the env
   * verb (story.5039). Closure reads "unknown" app-side (no Console key, task.5138). Absent
   * when the lease read capability is unwired (AKASH_ACTUATOR_ACCOUNT_ID not pinned on the runtime).
   */
  leases: z.array(leaseStateSchema).optional(),
  /**
   * `allocated` receipts whose (node, environment) the catalog no longer declares — paid
   * leases nothing in git points at (the undetectable orphan of bug.5189). Break-glass:
   * scripts/ops/recover-orphaned-akash-lease.sh.
   */
  orphans: z.array(leaseStateSchema).optional(),
  receiptStates: z.array(receiptStateSchema).max(50),
  receiptCoverage: coverageSchema,
  exactReceipt: receiptStateSchema.optional(),
  exactCoverage: coverageSchema.optional(),
  legacyCoverage: coverageSchema,
});

export type DeployStateResponse = z.infer<typeof deployStateResponseSchema>;

export async function GET(
  request: Request,
  ctx: RouteParams
): Promise<NextResponse> {
  const startedAt = performance.now();
  const reqCtx = createRequestContext({ baseLog, clock }, request, {
    routeId: "nodes.deploy-state",
    traceId: getCurrentTraceId(),
    session: undefined,
  });

  // Single deterministic terminal event — enums/ids/counts only (no secrets, no host list).
  const complete = (fields: {
    outcome: "success" | "error";
    status: number;
    errorCode?: string;
    nodeId?: string;
    liveEnvs?: number;
    receiptCount?: number;
    receiptCoverage?: string;
    legacyCoverage?: string;
    nativeComplete?: number;
    nativeUnknown?: number;
    nativeDurationMs?: number;
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
        EVENT_NAMES.NODE_DEPLOY_STATE_COMPLETE,
        payload,
        EVENT_NAMES.NODE_DEPLOY_STATE_COMPLETE
      );
      return;
    }
    const level = fields.status >= 500 ? "error" : "warn";
    reqCtx.log[level](
      { event: EVENT_NAMES.NODE_DEPLOY_STATE_COMPLETE, ...payload },
      EVENT_NAMES.NODE_DEPLOY_STATE_COMPLETE
    );
  };

  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    complete({ outcome: "error", status: 401, errorCode: "unauthorized" });
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;

  // Resolve {id} (UUID or slug) + developer-gate (`node.flight`) via the shared node-rbac seam —
  // fail-closed without a store.
  const gate = await resolveNodeAndAuthorize({
    id,
    userId: sessionUser.id,
    action: "node.flight",
  });
  if (!gate.ok) {
    complete({
      outcome: "error",
      status: gate.status,
      errorCode: gate.errorCode,
    });
    return NextResponse.json(
      { error: gate.errorCode },
      { status: gate.status }
    );
  }
  const node = gate.node;

  const search = new URL(request.url).searchParams;
  const parsed = querySchema.safeParse(Object.fromEntries(search));
  if (
    !parsed.success ||
    [...search.keys()].some((key) => search.getAll(key).length !== 1)
  ) {
    complete({
      outcome: "error",
      status: 400,
      errorCode: "invalid_query",
      nodeId: node.nodeId,
    });
    return NextResponse.json({ error: "invalid_query" }, { status: 400 });
  }
  const { cogniKey, environment } = parsed.data;
  const leaseRead = getContainer().leaseReadCapability;
  let exact: Receipt | null = null;
  let exactObservedAt: string | null = null;
  if (cogniKey !== undefined) {
    try {
      if (!leaseRead) throw new Error("unwired");
      exact = await leaseRead.read({ cogniKey });
      exactObservedAt = clock.now();
    } catch {
      complete({
        outcome: "error",
        status: 503,
        errorCode: "evidence_unavailable",
        nodeId: node.nodeId,
      });
      return NextResponse.json(
        { error: "evidence_unavailable" },
        { status: 503 }
      );
    }
    if (
      !exact ||
      exact.cogniKey !== cogniKey ||
      exact.identity.nodeId !== node.nodeId ||
      (environment !== undefined && exact.environment !== environment)
    ) {
      complete({
        outcome: "error",
        status: 404,
        errorCode: "key_not_found",
        nodeId: node.nodeId,
      });
      return NextResponse.json({ error: "key_not_found" }, { status: 404 });
    }
  }
  // Exact native work completes before optional historical enumeration. Its budget cannot
  // be spent on older handles; history stays visible with explicit not_requested evidence.
  let nativeDurationMs = 0;
  const readNative = async (receipts: readonly Receipt[]) => {
    const dseqs = [
      ...new Set(
        receipts.flatMap((r) =>
          r.externalName === undefined ? [] : [r.externalName]
        )
      ),
    ];
    if (!leaseRead || dseqs.length === 0) return {};
    const start = performance.now();
    try {
      return await leaseRead.readNativeStates({
        dseqs,
        signal: request.signal,
      });
    } catch {
      return {};
    } finally {
      nativeDurationMs += Math.round(performance.now() - start);
    }
  };
  let nativeByHandle: Readonly<Record<string, AkashNativeObservation>> = exact
    ? await readNative([exact])
    : {};
  let receiptCoverage: z.infer<typeof coverageSchema> = {
    status: "unknown",
    observedAt: null,
    limit: 50,
  };
  let receiptRecords: readonly Receipt[] = [];
  if (leaseRead) {
    try {
      const page = await leaseRead.listReceipts({
        nodeId: node.nodeId,
        ...(environment !== undefined ? { environment } : {}),
        limit: 51,
      });
      receiptRecords = page
        .slice(0, 50)
        .filter(
          (r) =>
            r.identity.nodeId === node.nodeId &&
            (environment === undefined || r.environment === environment)
        );
      receiptCoverage = {
        status:
          receiptRecords.length !== Math.min(page.length, 50)
            ? "unknown"
            : page.length > 50
              ? "truncated"
              : "complete",
        observedAt: clock.now(),
        limit: 50,
      };
    } catch {
      reqCtx.log.warn(
        { nodeId: node.nodeId },
        "node_deploy_state_receipts_unavailable"
      );
    }
  }
  if (!exact) nativeByHandle = await readNative(receiptRecords);
  const nativeFor = (receipt: Receipt) =>
    receipt.externalName === undefined
      ? unknownNative("not_requested")
      : (nativeByHandle[receipt.externalName] ??
        unknownNative(
          exact && receipt.externalName !== exact.externalName
            ? "not_requested"
            : "reader_unavailable"
        ));
  const receiptStates = receiptRecords.map((r) =>
    projectReceipt(r, nativeFor(r))
  );

  // CAPABILITY_INJECTION: read the deploy capability off the container. 503 when unwired (operator
  // DOMAIN/APP_BASE_URL unset — the probe adapter cannot derive hosts).
  const deployCapability = getContainer().deployCapability;
  if (!deployCapability) {
    complete({
      outcome: "error",
      status: 503,
      errorCode: "deploy_unwired",
      nodeId: node.nodeId,
    });
    return NextResponse.json(
      {
        error: "deploy_unwired",
        message:
          "operator DOMAIN/APP_BASE_URL unset — cannot derive node hosts",
      },
      { status: 503 }
    );
  }

  // Fan out over all deploy envs via the capability interface (ADAPTER_SWAPPABLE — no concrete
  // adapter type leaks into the app layer).
  const envs = await Promise.all(
    FLIGHT_ENVS.map((env) =>
      deployCapability.getDeployState({ env, node: node.slug })
    )
  );

  const liveEnvs = envs.filter((e) => e.health === "healthy").map((e) => e.env);

  // Money-loop SEE (story.5039): enumerate this node's live paid leases from the durable
  // allocation ledger + the existing pure closure classifier (cluster state is never spend truth). Optional by wiring: absent capability omits the block rather than emitting an
  // empty (and therefore lying) list. A read failure degrades the SAME way, with a warn — the
  // probe-backed deploy view must not 500 because the ledger is unreachable.
  let leaseBlock: {
    leases: ReadonlyArray<z.infer<typeof leaseStateSchema>>;
    orphans: ReadonlyArray<z.infer<typeof leaseStateSchema>>;
  } | null = null;
  let legacyCoverage: z.infer<typeof coverageSchema> = {
    status: "unknown",
    observedAt: null,
    limit: 50,
  };
  if (leaseRead) {
    try {
      const [registryRow] = await resolveServiceDb()
        .select()
        .from(nodes)
        .where(nodeIdOrSlug(node.nodeId))
        .limit(1);
      const receipts = await leaseRead.listAllocated({
        nodeId: node.nodeId,
        limit: 50,
      });
      legacyCoverage = {
        status: receipts.length >= 50 ? "potentially_truncated" : "complete",
        observedAt: clock.now(),
        limit: 50,
      };
      // No Console read-back app-side (ONE_CONSOLE_KEY_PER_ACCOUNT, task.5138): closure
      // reads `unknown`; the authoritative proof runs inside the actuator pod (bug.5189).
      const verified = await verifyLeaseClosures({ receipts });
      const closureByKey = new Map(
        verified.map((v) => [v.receipt.cogniKey, v.closure])
      );
      const toLease = (
        receipt: (typeof receipts)[number]
      ): z.infer<typeof leaseStateSchema> => ({
        environment: receipt.environment,
        cogniKey: receipt.cogniKey,
        state: receipt.state,
        externalName: receipt.externalName ?? null,
        closure: closureByKey.get(receipt.cogniKey) ?? "unknown",
      });
      const declaredPairs = ((registryRow?.deployEnvs ?? []) as string[]).map(
        (environment) => ({ nodeId: node.nodeId, environment })
      );
      leaseBlock = {
        leases: verified.map((v) => toLease(v.receipt)),
        orphans: orphanDiff(receipts, declaredPairs).map(toLease),
      };
    } catch {
      reqCtx.log.warn(
        {
          nodeId: node.nodeId,
          errorCode: "legacy_evidence_unavailable",
        },
        "node_deploy_state_lease_read_failed"
      );
    }
  }

  const body = deployStateResponseSchema.parse({
    nodeId: node.nodeId,
    slug: node.slug,
    envs,
    liveEnvs,
    ...(leaseBlock ?? {}),
    receiptStates,
    receiptCoverage,
    legacyCoverage,
    ...(exact
      ? {
          exactReceipt: projectReceipt(exact, nativeFor(exact)),
          exactCoverage: { status: "complete", observedAt: exactObservedAt },
        }
      : {}),
  });

  complete({
    outcome: "success",
    status: 200,
    nodeId: node.nodeId,
    liveEnvs: liveEnvs.length,
    receiptCount: receiptStates.length,
    receiptCoverage: receiptCoverage.status,
    legacyCoverage: legacyCoverage.status,
    nativeComplete: Object.values(nativeByHandle).filter(
      (o) =>
        o.deploymentCoverage === "complete" && o.leaseCoverage === "complete"
    ).length,
    nativeUnknown: [
      ...new Set(
        (exact ? [exact] : receiptRecords).flatMap((r) =>
          r.externalName === undefined ? [] : [r.externalName]
        )
      ),
    ].filter(
      (handle) =>
        nativeByHandle[handle]?.deploymentCoverage !== "complete" ||
        nativeByHandle[handle]?.leaseCoverage !== "complete"
    ).length,
    nativeDurationMs,
  });
  return NextResponse.json(body);
}
