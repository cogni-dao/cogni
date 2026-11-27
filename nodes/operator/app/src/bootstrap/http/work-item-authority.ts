// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/http/work-item-authority`
 * Purpose: Apply published work-item scope declarations at the authenticated HTTP door.
 * Scope: Node composition of released caller authorization; retains operator admin authority.
 * Invariants: SAME_DOOR; AUTHENTICATED_CALLER_IS_PRINCIPAL; NO_NEW_GRANTS; OUTAGE_IS_503.
 * Side-effects: IO (reads live role rows and the existing operator admin gate).
 * Links: hub agent-run-authority, adopt-node-package-release, story.0085
 * @internal
 */
import { CORE_TOOL_BUNDLE } from "@cogni/shared-ai-tools";
import {
  authorizeCaller,
  type GuardDeps,
  SAME_DOOR_ROUTES,
  type ToolRequires,
} from "@cogni-dao/agent-grants";

// The operator keeps its private coordination routes; map only their mutating
// doors to the released update policy before the wrapper invokes any facade.
const coordinationDoors: Readonly<Record<string, string>> = {
  "work.items.sessions.claim": "work.items.patch",
  "work.items.sessions.heartbeat": "work.items.patch",
  "work.items.sessions.pr": "work.items.patch",
};

/** Only declared work-item doors are in this repair's scope. Retired DELETE stays 410. */
export function workItemRouteRequires(
  routeId: string
): ToolRequires | undefined {
  if (!routeId.startsWith("work.items.")) return undefined;
  const publishedRouteId = coordinationDoors[routeId] ?? routeId;
  for (const [toolId, declaration] of Object.entries(SAME_DOOR_ROUTES)) {
    if (!declaration.routes.includes(publishedRouteId)) continue;
    const requires = CORE_TOOL_BUNDLE.find(
      (tool) => tool.contract.name === toolId
    )?.contract.requires;
    if (!requires || requires.scope !== declaration.scope)
      throw new Error(`Missing published work-item scope: ${routeId}`);
    return requires;
  }
  return undefined;
}

export async function authorizeWorkItemCaller(
  authority: Pick<GuardDeps, "withStore" | "adminCheck">,
  input: {
    userId: string;
    via: "bearer" | "session";
    requires: ToolRequires;
  }
) {
  try {
    return await authority.withStore((store) =>
      authorizeCaller(store, authority.adminCheck, input)
    );
  } catch {
    return {
      decision: "deny" as const,
      code: "authz_unavailable" as const,
      reason: "store_unavailable",
    };
  }
}

/** Real service-role store and the same operator admin gate used by graph tools. */
export async function workItemHttpAuthority() {
  const [{ getContainer, resolveServiceDb }, { checkNodeAdmin }, grants] =
    await Promise.all([
      import("@/bootstrap/container"),
      import("@/bootstrap/node-admin-gate"),
      import("@cogni-dao/agent-grants"),
    ]);
  return {
    withStore: (fn) =>
      fn(
        grants.createPostgresAgentGrantsStore((strings, ...values) =>
          resolveServiceDb().$client(strings, ...values)
        )
      ),
    adminCheck: async (userId) => {
      const container = getContainer();
      const decision = await checkNodeAdmin(container.authorization, {
        userId,
        nodeId: container.nodeId,
      });
      return decision.ok
        ? "allow"
        : decision.errorCode === "authz_unavailable"
          ? "unavailable"
          : "denied";
    },
  } satisfies Pick<GuardDeps, "withStore" | "adminCheck">;
}
