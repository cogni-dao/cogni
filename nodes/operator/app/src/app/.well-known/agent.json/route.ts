// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/.well-known/agent.json`
 * Purpose: Discovery document for machine agents — publishes register,
 *   self-identity, work-item, coordination, completions, run, validation,
 *   flight, and promote URLs plus the auth scheme so external clients can
 *   bootstrap without hard-coding paths or reading docs.
 * Scope: Single GET handler. Honors `x-forwarded-host`/`x-forwarded-proto`
 *   from Caddy / k8s ingress so the published URLs are externally reachable
 *   (falling back to the raw Host header then request.url for local dev).
 *   Public endpoint — no auth.
 * Invariants:
 *   - NO_INTERNAL_BIND_ADDR: URLs must never expose `0.0.0.0:3000` or other
 *     in-pod addresses. Always derive origin from forwarded headers first.
 *   - MOVES_SCHEMA_IS_THE_CONTRACT (story.0033): the create and PATCH `moves` schemas come from the shared work-items schema (at most 3 of { metricId, direction }) and offer no baseline; the GET output schema carries the pinned baseline and the read-time fields.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/work-item-status-machine, docs/guides/agent-api-validation.md
 * @public
 */

import {
  agentMeOperation,
  flightOperation,
  knowledgeHistoryOperation,
  reviewOperation,
  workItemsCreateOperation,
  workItemsGetOperation,
  workItemsHistoryOperation,
  workItemsPatchOperation,
} from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { z } from "zod";
import { LangfuseObservationQuerySchema } from "@/contracts/nodes.langfuse.observations.v1.contract";
import {
  getNodeBrandColor,
  getNodeBrandIcon,
  getNodeHook,
  getNodeMission,
  getNodeName,
  getNodeThumbnail,
} from "@/shared/config/repoSpec.server";
import { serverEnv } from "@/shared/env";

export const runtime = "nodejs";

/**
 * Resolve the public origin this request reached us through. In prod the app
 * runs behind Caddy / k8s ingress, so Next.js's `request.url` exposes the
 * in-pod bind address (e.g. `http://0.0.0.0:3000`) rather than the external
 * host clients are using. Prefer the forwarded headers the proxy injects,
 * falling back to the raw `host` and `request.url` for local/dev usage.
 */
function publicOrigin(request: Request): string {
  const url = new URL(request.url);
  const host =
    request.headers.get("x-forwarded-host") ??
    request.headers.get("host") ??
    url.host;
  const proto =
    request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  return `${proto}://${host}`;
}

export async function GET(request: Request) {
  const env = serverEnv();
  const origin = publicOrigin(request);
  return NextResponse.json({
    name: "Cogni Node API",
    version: "v1",
    buildSha: env.APP_BUILD_SHA,
    // IDENTITY_IS_REPO_SPEC_PROJECTION: the node's display identity, projected from its own repo-spec
    // `intent` (never hardcoded). The operator reads THIS to render gallery cards — no operator-side
    // per-node literals. A node customizes itself by editing repo-spec, not operator code.
    identity: {
      name: getNodeName(),
      hook: getNodeHook(),
      mission: getNodeMission(),
      brand: {
        icon: getNodeBrandIcon(),
        color: getNodeBrandColor(),
        thumbnail: getNodeThumbnail(),
      },
    },
    registrationUrl: `${origin}/api/v1/agent/register`,
    auth: { type: "bearer", keyPrefix: "cogni_ag_sk_v1_" },
    traceObservability: {
      contractVersion: "langfuse-observations-v2.1",
      querySchema: z.toJSONSchema(LangfuseObservationQuerySchema),
      auth: "Cogni Bearer; node.flight developer permission",
      nodeReference: "node UUID or slug",
      operations: ["GET /api/public/v2/observations"],
      applicationRootSelector:
        "type=SPAN&traceId=<32-hex-trace-id>; exact app root only, independently verified from Loki creation/terminal receipts",
      defaults: {
        environment: "production",
        limit: 50,
        maxLimit: 100,
        maxWindowHours: 24,
      },
      result: "Native Langfuse data/meta; scope and partiality in meta.cogni",
      privacy:
        "Allowlisted metadata; scrubbed bounded IO. Shared backend credentials stay server-side.",
    },
    // Fleet identity (task.5024): public keys nodes use to verify operator-signed
    // identity attestations. Nodes start the round trip at `/identity/attest`, which
    // authenticates a GitHub account through this environment's OAuth client — no
    // operator account is involved on either side of the seam.
    jwks_uri: `${origin}/.well-known/jwks.json`,
    endpoints: {
      completions: `${origin}/api/v1/chat/completions`,
      graphs: `${origin}/api/v1/ai/agents`,
      workItems: `${origin}/api/v1/work/items`,
      workItem: `${origin}/api/v1/work/items/{id}`,
      workItemClaim: `${origin}/api/v1/work/items/{id}/claims`,
      workItemHeartbeat: `${origin}/api/v1/work/items/{id}/heartbeat`,
      workItemPr: `${origin}/api/v1/work/items/{id}/pr`,
      workItemCoordination: `${origin}/api/v1/work/items/{id}/coordination`,
      runs: `${origin}/api/v1/agent/runs`,
      nodeTraceObservations: `${origin}/api/v1/nodes/{id}/observability/langfuse/api/public/v2/observations`,
      runStream: `${origin}/api/v1/agent/runs/{runId}/stream`,
      // Agent self-identity: one authed read for "am I live, who am I, when does
      // my key expire, what can I do". A 200 proves the key is live; a 401 proves
      // it is expired/invalid — unlike `users/me`, which is session-cookie-only
      // and 401s every agent key regardless of liveness. See `actions.agentMe`.
      agentIdentity: `${origin}/api/v1/agent/me`,
      // CI/CD plane. flight + promote are OPERATOR-ONLY (task.5411, CD4
      // ONE_WRITER_PER_NODE_LANE): they deploy the operator control plane itself and
      // refuse every other node with 409 `node_on_deploy_verb`. Every other node
      // deploys through `deployWorkloads` below. Promote also takes an optional `service`: an in-repo
      // operator catalog service (e.g. scheduler-worker) promotes on its own lane, never bundled into
      // an operator promote (CD5, bug.5599). infraReconcile is the separate,
      // operator-node-only production substrate lever. Grant the role via the
      // access-request → owner-approve loop below.
      flight: `${origin}/api/v1/vcs/flight`,
      // Developer-requested PR review (story.5102) — the ONLY review trigger; no webhook starts one.
      review: `${origin}/api/v1/vcs/review`,
      promote: `${origin}/api/v1/deploy/promote`,
      // Node-deploy verb (task.5400): POST records intent to blue/green-deploy one declared
      // workload at a sha; GET reads desired + releaseState (queued|deploying|active|parked|
      // superseded|failed) + attempts with step timelines; `<this>/releases/{releaseId}?nodeId&env`
      // follows one release; `/api/v1/nodes/{id}/observability/logs?service=deploy` is the node's own
      // sequencer events. Same per-env gates as promote.
      deployWorkloads: `${origin}/api/v1/deploy/workloads`,
      infraReconcile: `${origin}/api/v1/deploy/infra-reconcile`,
      openapi: `${origin}/openapi.json`,
      nodeAccessRequest: `${origin}/api/v1/nodes/{id}/access-requests`,
      nodeDevelopers: `${origin}/api/v1/nodes/{id}/developers`,
      // Cognition substrate: the session-start bundle (irreducible invariants +
      // live governing index + domain pointers). A SessionStart hook fetches this
      // and injects it — replaces git-synced AGENTS.md sprawl.
      cognition: `${origin}/api/v1/cognition`,
    },
    actions: {
      // IDENTITY_SEAM_IS_DISCOVERABLE: `endpoints.agentIdentity` is only a URL.
      // This action tells an agent the method, that a bearer key is required, and
      // the exact response shape (principal, key expiry, per-node grants) — so a
      // fresh agent can verify its own liveness and capabilities from one read
      // instead of guessing from a 401 or firing a gated write to probe RBAC.
      agentMe: {
        method: "GET",
        endpoint: `${origin}/api/v1/agent/me`,
        auth: { type: "bearer" },
        outputSchema: z.toJSONSchema(agentMeOperation.output),
      },
      flightCandidate: {
        method: "POST",
        endpoint: `${origin}/api/v1/vcs/flight`,
        // Operator node only; any other node → 409 node_on_deploy_verb, use deployWorkloads.
        scope: "operator",
        auth: {
          type: "bearer",
          capability: "node.flight",
        },
        inputSchema: z.toJSONSchema(flightOperation.input),
        outputSchema: z.toJSONSchema(flightOperation.output),
      },
      // REVIEW_IS_DEV_TRIGGERED (story.5102): a developer asks for a PR review; the requester is
      // the run actor and pays. The check run carries `external_id = requestId` and its summary
      // ends with one machine-readable block (marker `<!-- cogni-review-result v1 -->`).
      requestReview: {
        method: "POST",
        endpoint: `${origin}/api/v1/vcs/review`,
        auth: {
          type: "bearer",
          capability: "node.flight",
        },
        inputSchema: z.toJSONSchema(reviewOperation.input),
        outputSchema: z.toJSONSchema(reviewOperation.output),
      },
      // WRITE_SEAM_IS_DISCOVERABLE: `endpoints.workItems` is only a URL — it cannot
      // tell an agent that the route accepts POST, what body it takes, or that the
      // server allocates the id. Agents that lacked these schemas fell back to
      // harness-local slash commands, which hardcode the operator apex and so file
      // every node's work onto operator. Schemas are projected from the zod
      // contracts, so they cannot drift from the handlers.
      createWorkItem: {
        method: "POST",
        endpoint: `${origin}/api/v1/work/items`,
        auth: { type: "bearer" },
        inputSchema: z.toJSONSchema(workItemsCreateOperation.input),
        outputSchema: z.toJSONSchema(workItemsCreateOperation.output),
      },
      // MOVES_READ_SHOWS_THE_BASELINE (story.0033): a single-item read returns each move with its pinned
      // baseline and, at read time, the current reading and `moved`. The create and PATCH schemas above
      // take `{ metricId, direction }` only; the server pins the baseline.
      getWorkItem: {
        method: "GET",
        endpoint: `${origin}/api/v1/work/items/{id}`,
        auth: { type: "bearer" },
        inputSchema: z.toJSONSchema(workItemsGetOperation.input),
        outputSchema: z.toJSONSchema(workItemsGetOperation.output),
      },
      updateWorkItem: {
        method: "PATCH",
        endpoint: `${origin}/api/v1/work/items/{id}`,
        auth: { type: "bearer" },
        inputSchema: z.toJSONSchema(workItemsPatchOperation.input),
        outputSchema: z.toJSONSchema(workItemsPatchOperation.output),
      },
      // CHANGE_HISTORY (story.0023): versions of one row, newest first, each with its
      // change reason. Schemas are the package-owned operations, projected like the rest.
      getWorkItemHistory: {
        method: "GET",
        endpoint: `${origin}/api/v1/work/items/{id}/history`,
        auth: { type: "bearer" },
        inputSchema: z.toJSONSchema(workItemsHistoryOperation.input),
        outputSchema: z.toJSONSchema(workItemsHistoryOperation.output),
      },
      getKnowledgeHistory: {
        method: "GET",
        endpoint: `${origin}/api/v1/knowledge/{id}/history`,
        auth: { type: "bearer" },
        inputSchema: z.toJSONSchema(knowledgeHistoryOperation.input),
        outputSchema: z.toJSONSchema(knowledgeHistoryOperation.output),
      },
    },
    process: {
      contributionSpec:
        "https://node-template.cognidao.org/knowledge/work-item-status-machine",
      validationGuide: "docs/guides/agent-api-validation.md",
      validationSkill: ".claude/skills/validate-candidate",
      requiredLoop: [
        "discover",
        "register",
        // Adopt over create (anti-sprawl), but creating is a first-class step of
        // the loop — `actions.createWorkItem` carries the schema.
        "adopt_or_create_work_item",
        "claim_or_heartbeat",
        "push_pr",
        "flight_candidate_a",
        "validate_candidate_with_loki",
      ],
    },
    cognition: {
      // The node serves an agent's session-start cognition as a substrate.
      // Wire a SessionStart hook that echoes the bundle's markdown into context;
      // Claude Code and Codex both inject SessionStart stdout. The bundle is
      // public + index-only (full entry bodies stay behind the authed routes).
      bootstrapUrl: `${origin}/api/v1/cognition`,
      sessionStartHook: `curl -fsS ${origin}/api/v1/cognition | jq -r .markdown`,
    },
    defaults: {
      model: "gpt-4o-mini",
      graph_name: "poet",
    },
    usage: {
      note: "completions requires graph_name for newly registered agents",
      example: {
        model: "gpt-4o-mini",
        graph_name: "poet",
        messages: [{ role: "user", content: "Hello" }],
      },
    },
  });
}
