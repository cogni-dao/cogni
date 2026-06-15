// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/.well-known/agent.json`
 * Purpose: Discovery document for machine agents — publishes register,
 *   work-item, coordination, completions, run, validation, flight, and
 *   promote URLs plus the auth scheme so external clients can bootstrap
 *   without hard-coding paths or reading docs.
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

import { NextResponse } from "next/server";
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
    registrationUrl: `${origin}/api/v1/agent/register`,
    auth: { type: "bearer", keyPrefix: "cogni_ag_sk_v1_" },
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
      // CI/CD plane (see docs/spec/node-ci-cd-contract.md § Env-promotion).
      // flight → candidate-a (node.flight/can_flight); promote → production
      // (node.promote_production/can_promote_production). Both dispatch via the
      // operator GitHub App — never a personal gh credential. Promotion is
      // app-digest only (no infra). Grant the role via the access-request →
      // owner-approve loop below.
      flight: `${origin}/api/v1/vcs/flight`,
      promote: `${origin}/api/v1/deploy/promote`,
      nodeAccessRequest: `${origin}/api/v1/nodes/{id}/access-requests`,
      nodeDevelopers: `${origin}/api/v1/nodes/{id}/developers`,
    },
    process: {
      contributionSpec: "docs/spec/development-lifecycle.md",
      validationGuide: "docs/guides/agent-api-validation.md",
      validationSkill: ".claude/skills/validate-candidate",
      requiredLoop: [
        "discover",
        "register",
        "adopt_work_item",
        "claim_or_heartbeat",
        "push_pr",
        "flight_candidate_a",
        "validate_candidate_with_loki",
      ],
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
