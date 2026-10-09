// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/internal/flight-probe`
 * Purpose: Bounded node-local service endpoint proving the target can carry one real graph run.
 * Scope: Authenticate the fixed flight-prober service identity, resolve local system billing, and
 *   await one fixed `langgraph:poet` GraphRunWorkflow. The caller controls only idempotency.
 * Invariants:
 *   - SERVICE_PRINCIPAL_ONLY: identity is `service:{nodeId}/flight-prober`, never an agent/human.
 *   - NODE_LOCAL_CREDENTIAL: only FLIGHT_PROBE_API_KEY is accepted; no scheduler/fleet fallback.
 *   - FIXED_PROBE: graph, prompt, model, actor, and billing context are all server-selected.
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
import {
  getContainer,
  getTemporalWorkflowClient,
} from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getNodeId } from "@/shared/config";
import { serverEnv } from "@/shared/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_AUTH_HEADER_LENGTH = 512;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

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
    const configured = serverEnv().FLIGHT_PROBE_API_KEY;
    if (!configured) {
      ctx.log.error("Flight probe credential not configured");
      return NextResponse.json(
        { error: "Service not configured" },
        { status: 503 }
      );
    }

    const provided = extractBearer(request.headers.get("authorization"));
    if (!provided || !safeCompare(provided, configured)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const idempotencyKey = request.headers.get("idempotency-key")?.trim();
    if (
      !idempotencyKey ||
      idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH
    ) {
      return NextResponse.json(
        { error: "Valid Idempotency-Key header required" },
        { status: 400 }
      );
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
    const workflowId = `flight-probe:${nodeId}:${idempotencyKey}`;
    let handle = client.getHandle(workflowId);
    try {
      handle = await client.start("GraphRunWorkflow", {
        taskQueue,
        workflowId,
        args: [
          {
            nodeId,
            graphId: "langgraph:poet",
            executionGrantId: null,
            input: {
              messages: [
                { role: "user", content: "flight-status gate ping" },
              ],
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
            triggerRef: idempotencyKey,
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
