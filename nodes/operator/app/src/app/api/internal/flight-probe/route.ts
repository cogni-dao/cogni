// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/internal/flight-probe`
 * Purpose: Bounded node-local service endpoint proving the target can carry one real graph run.
 * Scope: Authenticate the fixed flight-prober service identity, resolve local system billing, and
 *   await one fixed `langgraph:poet` GraphRunWorkflow. The caller controls no execution input.
 * Invariants:
 *   - SERVICE_PRINCIPAL_ONLY: identity is `service:{nodeId}/flight-prober`, never an agent/human.
 *   - BOUNDED_ROTATION_RING: FLIGHT_PROBE_API_KEY is strict `{active,previous}` JSON (max two keys),
 *     both accepted constant-time during rotation; there is no scheduler/fleet fallback.
 *   - FIXED_PROBE: graph, prompt, model, actor, and billing context are all server-selected.
 *   - SERVER_BOUND_ATTEMPT: caller supplies no flight ID. Workflow identity is target build SHA plus
 *     a server-derived 15-minute window with REJECT_DUPLICATE: one billable run per node/build/window
 *     (96 per aligned UTC day; at most 97 windows overlap any rolling 24 hours).
 *   - REAL_SUBSTRATE_PROOF: completion traverses the node queue, worker, scheduler callback, graph,
 *     and run ledger; a downstream graph failure still returns its created runId with `ok:false`.
 * Side-effects: Temporal workflow start/result, database reads and graph execution through workflow.
 * Links: task.5218, task.5223, flight-probe.internal.v1.contract
 * @internal
 */

import { timingSafeEqual } from "node:crypto";
import {
  type InternalFlightProbeOutput,
  InternalFlightProbeOutputSchema,
} from "@cogni/node-contracts";
import {
  COGNI_SYSTEM_BILLING_ACCOUNT_ID,
  COGNI_SYSTEM_PRINCIPAL_USER_ID,
} from "@cogni/node-shared";
import type { GraphRunResult } from "@cogni/temporal-workflows";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getContainer, getTemporalWorkflowClient } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getNodeId } from "@/shared/config";
import { serverEnv } from "@/shared/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_AUTH_HEADER_LENGTH = 512;
const PROBE_WINDOW_MS = 15 * 60 * 1000;
const BUILD_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const FlightProbeKeyRingSchema = z
  .strictObject({
    active: z.string().min(32),
    previous: z.string().min(32).nullable(),
  })
  .refine((ring) => ring.previous === null || ring.previous !== ring.active, {
    message: "active and previous keys must differ",
  });

function parseKeyRing(serialized: string | undefined): {
  readonly active: string;
  readonly previous: string | null;
} | null {
  if (!serialized) return null;
  try {
    const parsed = FlightProbeKeyRingSchema.safeParse(JSON.parse(serialized));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Server-derived durable Temporal identity window; caller cannot choose it. */
export function flightProbeWindow(nowMs: number): number {
  return Math.floor(nowMs / PROBE_WINDOW_MS);
}

function extractBearer(authHeader: string | null): string | null {
  if (!authHeader || authHeader.length > MAX_AUTH_HEADER_LENGTH) return null;
  const trimmed = authHeader.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) return null;
  const token = trimmed.slice(7).trim();
  return token || null;
}

function safeCompare(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function servicePrincipal(nodeId: string): string {
  return `service:${nodeId}/flight-prober`;
}

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "flight-probe.internal", auth: { mode: "none" } },
  async (ctx, request) => {
    const env = serverEnv();
    const keyRing = parseKeyRing(env.FLIGHT_PROBE_API_KEY);
    const buildSha = env.APP_BUILD_SHA;
    if (!keyRing || !buildSha || !BUILD_SHA_PATTERN.test(buildSha)) {
      ctx.log.error("Flight probe configuration unavailable");
      return NextResponse.json(
        { error: "Service not configured" },
        { status: 503 }
      );
    }

    const provided = extractBearer(request.headers.get("authorization"));
    const matchesActive = provided
      ? safeCompare(provided, keyRing.active)
      : false;
    const matchesPrevious =
      provided && keyRing.previous
        ? safeCompare(provided, keyRing.previous)
        : false;
    if (!matchesActive && !matchesPrevious) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const nodeId = getNodeId();
    const principalId = servicePrincipal(nodeId);
    const billingAccount =
      await getContainer().serviceAccountService.getBillingAccountById(
        COGNI_SYSTEM_BILLING_ACCOUNT_ID
      );
    if (!billingAccount) {
      ctx.log.error("Flight probe system billing account not found");
      return NextResponse.json(
        { error: "Service not configured" },
        { status: 503 }
      );
    }

    const { client, taskQueue } = await getTemporalWorkflowClient();
    const probeWindow = flightProbeWindow(Date.now());
    const triggerRef = `${buildSha}:${probeWindow}`;
    const workflowId = `flight-probe:${nodeId}:${triggerRef}`;
    let handle = client.getHandle(workflowId);
    try {
      handle = await client.start("GraphRunWorkflow", {
        taskQueue,
        workflowId,
        workflowIdReusePolicy: "REJECT_DUPLICATE",
        args: [
          {
            nodeId,
            graphId: "langgraph:poet",
            executionGrantId: null,
            input: {
              messages: [{ role: "user", content: "flight-status gate ping" }],
              modelRef: {
                providerKey: "platform",
                modelId: "gpt-4o-mini",
              },
              actorUserId: COGNI_SYSTEM_PRINCIPAL_USER_ID,
              billingAccountId: COGNI_SYSTEM_BILLING_ACCOUNT_ID,
              virtualKeyId: billingAccount.defaultVirtualKeyId,
            },
            runKind: "system_webhook" as const,
            triggerSource: "flight_probe",
            triggerRef,
            requestedBy: principalId,
          },
        ],
      });
    } catch (error) {
      if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
    }

    const result = (await handle.result()) as GraphRunResult;
    const output: InternalFlightProbeOutput =
      InternalFlightProbeOutputSchema.parse({
        ok: result.ok,
        runId: result.runId,
        principalId,
      });
    return NextResponse.json(output);
  }
);
