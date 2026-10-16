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
 * Side-effects: none
 * Links: docs/spec/development-lifecycle.md, docs/guides/agent-api-validation.md
 * @public
 */

import {
  agentMeV2Operation,
  flightOperation,
  workItemsCreateOperation,
  workItemsPatchOperation,
} from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { z } from "zod";
import { readAgentBillingAccountOperation } from "@/contracts/agent-account-access.v1.contract";
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
    registration: {
      mode: "spawn_grant_redemption",
      note: "An authorized human first creates a one-use spawn grant; name-only anonymous registration is not supported.",
    },
    auth: { type: "bearer", keyPrefix: "cogni_ag_sk_v2_" },
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
      runStream: `${origin}/api/v1/agent/runs/{runId}/stream`,
      // Agent self-identity: one authed read for "am I live, who am I, when does
      // my key expire, what can I do". A 200 proves the key is live; a 401 proves
      // it is expired/invalid — unlike `users/me`, which is session-cookie-only
      // and 401s every agent key regardless of liveness. See `actions.agentMe`.
      agentIdentity: `${origin}/api/v1/agent/me`,
      billingAccount: `${origin}/api/v1/accounts/{billingAccountId}`,
      // CI/CD plane (see docs/spec/node-ci-cd-contract.md § Env-promotion).
      // flight → candidate-a (node.flight/can_flight); promote → production
      // (node.promote_production/can_promote_production). Both dispatch via the
      // operator GitHub App — never a personal gh credential. Promotion is
      // app-digest only; infraReconcile is the separate, operator-node-only
      // production substrate lever. Grant the role via the access-request →
      // owner-approve loop below.
      flight: `${origin}/api/v1/vcs/flight`,
      promote: `${origin}/api/v1/deploy/promote`,
      infraReconcile: `${origin}/api/v1/deploy/infra-reconcile`,
      openapi: `${origin}/openapi.json`,
      nodeAccessRequest: `${origin}/api/v1/nodes/{id}/access-requests`,
      nodeDevelopers: `${origin}/api/v1/nodes/{id}/developers`,
      // Cognition substrate: the session-start bundle (irreducible invariants +
      // live skills index + domain pointers). A SessionStart hook fetches this
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
        outputSchema: z.toJSONSchema(agentMeV2Operation.output),
      },
      readBillingAccount: {
        method: "GET",
        endpoint: `${origin}/api/v1/accounts/{billingAccountId}`,
        auth: { type: "bearer", principal: "durable_agent" },
        inputSchema: z.toJSONSchema(readAgentBillingAccountOperation.input),
        outputSchema: z.toJSONSchema(readAgentBillingAccountOperation.output),
      },
      flightCandidate: {
        method: "POST",
        endpoint: `${origin}/api/v1/vcs/flight`,
        auth: {
          type: "bearer",
          capability: "node.flight",
        },
        inputSchema: z.toJSONSchema(flightOperation.input),
        outputSchema: z.toJSONSchema(flightOperation.output),
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
      updateWorkItem: {
        method: "PATCH",
        endpoint: `${origin}/api/v1/work/items/{id}`,
        auth: { type: "bearer" },
        inputSchema: z.toJSONSchema(workItemsPatchOperation.input),
        outputSchema: z.toJSONSchema(workItemsPatchOperation.output),
      },
    },
    process: {
      contributionSpec: "docs/spec/development-lifecycle.md",
      validationGuide: "docs/guides/agent-api-validation.md",
      validationSkill: ".claude/skills/validate-candidate",
      requiredLoop: [
        "discover",
        "redeem_spawn_grant",
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
      // principal-authenticated + index-first (full entry bodies stay behind
      // the same target-node bearer authority).
      bootstrapUrl: `${origin}/api/v1/cognition`,
      sessionStartHook: `curl -fsS -H "Authorization: Bearer $COGNI_NODE_API_KEY" ${origin}/api/v1/cognition | jq -r .markdown`,
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
