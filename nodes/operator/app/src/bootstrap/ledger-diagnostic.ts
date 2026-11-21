// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/ledger-diagnostic`
 * Purpose: Bound local identity/registry/grant preparation and wire the finite native reader.
 * Scope: Composition and local read-only ownership lookup; no foreign database or schedule writes.
 * Invariants: One second preparation, real SQL/HTTP deadlines, request-local clients and cancellation.
 * Side-effects: local database reads and OpenFGA check; cleanup closes only request-owned resources.
 * Links: https://cognidao.org/knowledge/node-temporal-health-contract
 * @public
 */
import { OpenFgaAuthorizationAdapter } from "@cogni/authorization-core";
import { executionGrants, schedules } from "@cogni/db-schema";
import { COGNI_SYSTEM_PRINCIPAL_USER_ID } from "@cogni/node-shared";
import {
  admitLedgerBinding,
  buildLedgerIngestInput,
  buildWorkflowArgs,
  emptyLedgerDiagnostic,
  governanceScheduleId,
  type LedgerDiagnosticBinding,
  type LedgerDiagnosticV1,
  legacyGovernanceScheduleId,
  nodeTaskScope,
  verifyCurrentLedgerOwnership,
} from "@cogni/scheduler-core";
import {
  type CredentialSql,
  createPostgresCredentialStore,
} from "@cogni-dao/agent-grants/credentials";
import { and, eq, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { TemporalLedgerDiagnosticAdapter } from "@/adapters/server";
import { getGovernanceConfig, getNodeId } from "@/shared/config";
import { nodes } from "@/shared/db/nodes";
import { serverEnv } from "@/shared/env";
import {
  type FlightEnv,
  isFlightEnv,
} from "@/shared/node-registry/deploy-hosts";
import {
  controlEnvFor,
  providerForEnv,
  toNodeDeploymentPlacement,
} from "@/shared/node-registry/placement";
import { isLocalActivityAuthority } from "./jobs/resolveRoutableNodeGovernanceConfigs";

export class LedgerRequestError extends Error {
  constructor(
    readonly code: string,
    readonly status: number
  ) {
    super(code);
  }
}
export function createDiagnosticRequestBudget(request: Request) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  if (request.signal.aborted) abort();
  const timer = setTimeout(abort, 4500);
  return {
    signal: controller.signal,
    startedAt,
    deadline: startedAt + 4500,
    dispose() {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", abort);
    },
  };
}
export type DiagnosticBudget = ReturnType<typeof createDiagnosticRequestBudget>;
export function createLedgerPreparation(
  budget: DiagnosticBudget,
  nodeIdOrSlug: (ref: string) => SQL
) {
  budget.signal.throwIfAborted();
  if (Date.now() >= budget.startedAt + 1000)
    throw new LedgerRequestError("deadline_exceeded", 503);
  const env = serverEnv();
  const operatorNodeId = getNodeId();
  const deadline = budget.startedAt + 1000;
  const controller = new AbortController();
  const abort = () => controller.abort();
  budget.signal.addEventListener("abort", abort, { once: true });
  if (budget.signal.aborted) abort();
  const timer = setTimeout(abort, Math.max(0, deadline - Date.now()));
  const check = () => {
    if (controller.signal.aborted || Date.now() >= deadline)
      throw new LedgerRequestError("deadline_exceeded", 503);
  };
  check();
  // Dedicated pool permits a hard abort without closing another request's client.
  const sql = postgres(env.DATABASE_SERVICE_URL, {
    max: 1,
    connect_timeout: 1,
    idle_timeout: 1,
    connection: {
      application_name: "epoch_diagnostic_read",
      statement_timeout: 500,
      default_transaction_read_only: true,
    },
  });
  const db = drizzle(sql);
  let closed = false;
  const close = () => {
    if (!closed) {
      closed = true;
      void sql.end({ timeout: 0 });
    }
  };
  controller.signal.addEventListener("abort", close, { once: true });
  const remaining = () => Math.max(1, deadline - Date.now());
  const authorization =
    env.OPENFGA_API_URL && env.OPENFGA_STORE_ID
      ? new OpenFgaAuthorizationAdapter({
          apiUrl: env.OPENFGA_API_URL,
          storeId: env.OPENFGA_STORE_ID,
          timeoutMs: remaining(),
          readTransport: { signal: controller.signal, timeoutMs: remaining() },
          ...(env.OPENFGA_API_TOKEN ? { apiToken: env.OPENFGA_API_TOKEN } : {}),
          ...(env.OPENFGA_AUTHORIZATION_MODEL_ID
            ? { authorizationModelId: env.OPENFGA_AUTHORIZATION_MODEL_ID }
            : {}),
        })
      : null;
  // This store is used only for lookup / supersession. Writes remain inaccessible to this request.
  const credentialStore = createPostgresCredentialStore(
    sql as unknown as CredentialSql,
    {
      hasRoles: async () => {
        throw new Error("diagnostic_identity_read_only");
      },
    }
  );
  return {
    credentialStore,
    check,
    async lookup(ref: string) {
      check();
      const rows = await db
        .select({
          nodeId: nodes.id,
          slug: nodes.slug,
          status: nodes.status,
          deployEnvs: nodes.deployEnvs,
          activityEnv: nodes.activityEnv,
          deploymentProviders: nodes.deploymentProviders,
        })
        .from(nodes)
        .where(nodeIdOrSlug(ref))
        .limit(2);
      check();
      const row = rows[0];
      if (rows.length !== 1 || !row)
        throw new LedgerRequestError("node_not_found", 404);
      return row;
    },
    async authorize(actorId: string, nodeId: string) {
      check();
      if (!authorization)
        throw new LedgerRequestError("authz_unavailable", 503);
      const decision = await authorization.check({
        actorId: `user:${actorId}`,
        action: "node.flight",
        resource: `node:${nodeId}`,
        context: { tenantId: nodeId, nodeId },
      });
      if (decision.code === "authz_unavailable")
        throw new LedgerRequestError("authz_unavailable", 503);
      check();
      if (decision.decision !== "allow")
        throw new LedgerRequestError("authz_denied", 403);
    },
    async bind(
      node: {
        nodeId: string;
        status: string;
        deployEnvs: readonly string[];
        activityEnv: string;
      },
      requestedEnv: FlightEnv
    ): Promise<LedgerDiagnosticBinding | LedgerDiagnosticV1> {
      check();
      if (requestedEnv !== env.DEPLOY_ENVIRONMENT)
        throw new LedgerRequestError("environment_mismatch", 400);
      const base = {
        nodeId: node.nodeId,
        env: requestedEnv,
        appBuildSha: env.APP_BUILD_SHA ?? "unknown",
        capability:
          node.nodeId === operatorNodeId
            ? ("operator_ledger" as const)
            : ("central_dispatch" as const),
      };
      if (env.TEMPORAL_NAMESPACE !== `cogni-${requestedEnv}`)
        throw new LedgerRequestError("temporal_environment_unavailable", 503);
      if (!env.TEMPORAL_ADDRESS)
        throw new LedgerRequestError("temporal_unwired", 503);
      const operator = node.nodeId === operatorNodeId;
      if (!operator && !isLocalActivityAuthority(node, requestedEnv))
        return emptyLedgerDiagnostic(
          { ...base, capability: "not_applicable" },
          "activity_elsewhere"
        );
      if (!operator && !["published", "active"].includes(node.status))
        return emptyLedgerDiagnostic(
          { ...base, capability: "not_applicable" },
          "dispatch_not_declared"
        );
      const config = getGovernanceConfig();
      if (
        operator &&
        (!config.ledger ||
          !config.schedules.some(
            (s) => s.charter.toUpperCase() === "LEDGER_INGEST"
          ))
      )
        return emptyLedgerDiagnostic(
          { ...base, capability: "not_applicable" },
          "dispatch_not_declared"
        );
      const scheduleId = operator
        ? legacyGovernanceScheduleId("LEDGER_INGEST")
        : governanceScheduleId(node.nodeId, "LEDGER_INGEST");
      const rows = await db
        .select()
        .from(schedules)
        .where(
          and(
            eq(schedules.ownerUserId, COGNI_SYSTEM_PRINCIPAL_USER_ID),
            eq(schedules.temporalScheduleId, scheduleId)
          )
        )
        .limit(2);
      check();
      const row = rows[0];
      if (rows.length !== 1 || !row)
        return emptyLedgerDiagnostic(base, "ownership_unproven");
      const grants = await db
        .select()
        .from(executionGrants)
        .where(eq(executionGrants.id, row.executionGrantId))
        .limit(2);
      check();
      const grant = grants[0];
      const requiredScope = operator
        ? "graph:execute:sandbox:openclaw"
        : nodeTaskScope(node.nodeId, "/api/internal/attribution/collect");
      const desired =
        operator && config.ledger
          ? buildLedgerIngestInput(config.ledger)
          : {
              route: "/api/internal/attribution/collect",
              payload: { nodeId: node.nodeId },
            };
      const graphId = operator
        ? "ledger:ingest"
        : "task:/api/internal/attribution/collect";
      const refusal = verifyCurrentLedgerOwnership({
        expectedInput: desired,
        expectedGraphId: graphId,
        systemUserId: COGNI_SYSTEM_PRINCIPAL_USER_ID,
        requiredScope,
        nowMs: Date.now(),
        schedule: row,
        grant:
          grants.length === 1 && grant
            ? {
                id: grant.id,
                userId: grant.userId,
                scopes: grant.scopes,
                revoked: grant.revokedAt !== null,
                expiresAtMs: grant.expiresAt?.getTime() ?? null,
              }
            : null,
      });
      if (refusal) return emptyLedgerDiagnostic(base, refusal);
      const workflowType = operator
        ? "CollectEpochWorkflow"
        : "NodeTaskWorkflow";
      return admitLedgerBinding({
        ...base,
        namespace: env.TEMPORAL_NAMESPACE,
        scheduleId,
        workflowType,
        currentQueue: operator
          ? `ledger-tasks-${operatorNodeId}`
          : `${env.TEMPORAL_TASK_QUEUE}-${operatorNodeId}`,
        legacyQueue: operator ? "ledger-tasks" : env.TEMPORAL_TASK_QUEUE,
        expectedEnvelope: buildWorkflowArgs(
          {
            scheduleId,
            nodeId: node.nodeId,
            dbScheduleId: row.id,
            ownerUserId: row.ownerUserId,
            cron: row.cron,
            timezone: row.timezone,
            graphId,
            executionGrantId: row.executionGrantId,
            input: desired,
          },
          workflowType
        ),
      });
    },
    workerSource(
      node: { nodeId: string; deploymentProviders: unknown },
      requestedEnv: FlightEnv
    ) {
      const placement = node.deploymentProviders;
      if (
        !placement ||
        typeof placement !== "object" ||
        Array.isArray(placement)
      )
        throw new LedgerRequestError("diagnostic_logs_unwired", 503);
      const declaredProvider = (placement as Record<string, unknown>)[
        requestedEnv
      ];
      if (
        declaredProvider !== undefined &&
        declaredProvider !== "k3s" &&
        declaredProvider !== "akash"
      )
        throw new LedgerRequestError("diagnostic_logs_unwired", 503);
      const physicalEnv =
        node.nodeId === operatorNodeId
          ? requestedEnv
          : controlEnvFor(
              requestedEnv,
              providerForEnv(
                toNodeDeploymentPlacement(placement),
                requestedEnv
              ),
              env.FLEET_CONTROL_ENV
            );
      if (!isFlightEnv(physicalEnv))
        throw new LedgerRequestError("diagnostic_logs_unwired", 503);
      return {
        physicalEnv,
        namespace: `cogni-${physicalEnv}`,
        container: "scheduler-worker" as const,
      };
    },
    reader: new TemporalLedgerDiagnosticAdapter(env.TEMPORAL_ADDRESS),
    finish() {
      check();
      clearTimeout(timer);
      budget.signal.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", close);
      close();
    },
    dispose() {
      clearTimeout(timer);
      budget.signal.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", close);
      close();
    },
  };
}
