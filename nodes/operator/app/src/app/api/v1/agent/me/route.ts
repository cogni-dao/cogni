// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/agent/me`
 * Purpose: Exact self-identity, credential liveness, and grant introspection.
 * Scope: Human sessions, expiring v1 agents, and durable v2 agents.
 * Invariants: SELF_ONLY; CREDENTIAL_NE_PRINCIPAL; HUMAN_AND_AGENT_ARE_DISTINCT;
 *   GRANTS_NEVER_BLOCK_LIVENESS.
 * Side-effects: reads the credential store and OpenFGA.
 * Links: agent.me.v2.contract, story.5075, task.5252
 * @public
 */

import {
  authzUserResource,
  type AuthorizationPort,
} from "@cogni/authorization-core";
import {
  agentMeV2Operation,
  type AgentRequestPrincipal,
  type RequestPrincipal,
} from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import {
  RequestIdentityUnavailableError,
  resolveRequestPrincipal,
} from "@/app/_lib/auth/request-identity";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { requestBearer } from "../_shared";

const NODE_PREFIX = "node:";
const DURABLE_PREFIX = "cogni_ag_sk_v2_";

function authorizationSubjects(principal: RequestPrincipal): string[] {
  if (principal.kind === "agent") return [principal.principalId];
  const userId =
    principal.kind === "human" ? principal.userId : principal.legacyUserId;
  return [...new Set([principal.principalId, authzUserResource(userId)])];
}

async function readRoles(
  authorization: AuthorizationPort | undefined,
  principal: RequestPrincipal
): Promise<{
  grantsAvailable: boolean;
  nodes: Array<{ nodeId: string; roles: string[] }>;
}> {
  if (!authorization) return { grantsAvailable: false, nodes: [] };
  const rolesByNode = new Map<string, Set<string>>();
  for (const subject of authorizationSubjects(principal)) {
    const listed = await authorization.listRelations(subject);
    if (listed.decision !== "success") {
      return { grantsAvailable: false, nodes: [] };
    }
    for (const tuple of listed.tuples) {
      if (!tuple.object.startsWith(NODE_PREFIX)) continue;
      const nodeId = tuple.object.slice(NODE_PREFIX.length);
      const roles = rolesByNode.get(nodeId) ?? new Set<string>();
      roles.add(tuple.relation);
      rolesByNode.set(nodeId, roles);
    }
  }
  return {
    grantsAvailable: true,
    nodes: [...rolesByNode.entries()]
      .map(([nodeId, roles]) => ({ nodeId, roles: [...roles].sort() }))
      .sort((a, b) => a.nodeId.localeCompare(b.nodeId)),
  };
}

export const GET = wrapRouteHandlerWithLogging(
  { routeId: "agent.me.read", auth: { mode: "none" } },
  async (_ctx, request) => {
    const bearer = requestBearer(request);
    let principal: RequestPrincipal | null;
    let durableStatus: {
      principal: AgentRequestPrincipal;
      access: "active" | "renew_only";
      authenticateUntil: string;
      renewUntil: string;
    } | null = null;

    try {
      if (bearer?.startsWith(DURABLE_PREFIX)) {
        durableStatus = await getContainer().agentIdentity.authenticate(
          bearer,
          "renew"
        );
        principal = durableStatus?.principal ?? null;
      } else {
        principal = await resolveRequestPrincipal();
      }
    } catch (error) {
      if (error instanceof RequestIdentityUnavailableError || bearer) {
        return NextResponse.json(
          { error: "authn_unavailable" },
          { status: 503 }
        );
      }
      throw error;
    }

    if (!principal) {
      return NextResponse.json({ error: "invalid_token" }, { status: 401 });
    }

    const grants = await readRoles(getContainer().authorization, principal);
    const result =
      principal.kind === "agent" && durableStatus
        ? {
            kind: "agent" as const,
            identity: principal,
            credential: {
              kind: "durable_v2" as const,
              expiresAt: durableStatus.authenticateUntil,
              renewUntil: durableStatus.renewUntil,
              status: durableStatus.access,
            },
            ...grants,
          }
        : principal.kind === "legacy_agent"
          ? {
              kind: "legacy_agent" as const,
              identity: principal,
              credential: {
                kind: "legacy_v1" as const,
                expiresAt: principal.expiresAt,
                renewUntil: null,
                status: "active" as const,
              },
              ...grants,
            }
          : {
              kind: "human" as const,
              identity: principal,
              credential: null,
              ...grants,
            };

    return NextResponse.json(agentMeV2Operation.output.parse(result));
  }
);

export const dynamic = "force-dynamic";
