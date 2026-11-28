// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/agent-tool-authority`
 * Purpose: Compose the published capability host and bind its node-admin calls.
 * Scope: Service SQL, existing operator admin authority, and catalog wiring only.
 * Invariants: NO_DEFAULT_GRANTS; NO_NEW_AUTHORITY; PACKAGE_OWNS_DECISIONS.
 * Side-effects: IO only when a returned authority method is called.
 * Links: hub agent-run-authority, node-capability-grants-standard, story.0085
 * @internal
 */

import { COGNI_SYSTEM_PRINCIPAL_USER_ID } from "@cogni/node-shared";
import { LANGGRAPH_CATALOG } from "@cogni/operator-graphs";
import { CORE_TOOL_BUNDLE } from "@cogni/shared-ai-tools";
import {
  type AgentAuthoritySql,
  type AgentToolAuthority,
  type AgentToolAuthorityDeps,
  buildPermissionCatalog,
  buildRequiresById,
  createAgentToolAuthority as createSharedAgentToolAuthority,
} from "@cogni-dao/agent-grants/host";
import type { AdminAiAccessCalls } from "@cogni-dao/agent-grants/http";

import {
  type NodeAdminGate,
  nodeAdminUnavailable,
} from "@/bootstrap/node-admin-gate";
import { isDaoAdmin } from "@/shared/config/repoSpec.server";

export type {
  AgentAuthoritySql,
  AgentToolAuthority,
} from "@cogni-dao/agent-grants/host";

// This slice supplies only the tool scopes needed by the work-item door and
// Cogni. The package also owns its baseline route-only declarations. All names,
// descriptions and policy come from the release, with no local copy table.
const nodeScopes = new Set(["work_item:transition", "edo:write"]);
const tools = CORE_TOOL_BUNDLE.flatMap(({ contract }) =>
  contract.requires && nodeScopes.has(contract.requires.scope)
    ? [{ id: contract.name, requires: contract.requires }]
    : []
);

export const agentPermissions = buildPermissionCatalog(
  buildRequiresById(tools)
).permissions;

/** No seeds or grants: the shared host resolves this node's existing SQL rows. */
export function createAgentToolAuthority(
  deps: Pick<AgentToolAuthorityDeps, "sql" | "log"> & {
    readonly isAdminWallet?: (wallet: string | undefined) => boolean;
  }
): AgentToolAuthority {
  return createSharedAgentToolAuthority({
    sql: deps.sql,
    log: deps.log,
    nodeAdmin: {
      check: async ({ walletAddress }) =>
        (deps.isAdminWallet ?? isDaoAdmin)(walletAddress)
          ? { ok: true }
          : { ok: false, errorCode: "authz_denied" },
    },
    tools,
    graphs: Object.values(LANGGRAPH_CATALOG),
    systemUserIds: [COGNI_SYSTEM_PRINCIPAL_USER_ID],
  });
}

/** Lazy composition; obtaining a host does not read or change grants. */
export async function getAgentToolAuthority(): Promise<AgentToolAuthority> {
  const { getContainer, resolveServiceDb } = await import(
    "@/bootstrap/container"
  );
  const container = getContainer();
  return createAgentToolAuthority({
    // The same BYPASSRLS postgres.js connection used by the existing guards and
    // credential store. The package owns its transaction/store implementation.
    sql: resolveServiceDb().$client as unknown as AgentAuthoritySql,
    log: container.log,
  });
}

type AdminAuthority = Pick<
  AgentToolAuthority,
  | "adminCheck"
  | "listNodeAi"
  | "grantRole"
  | "revokeRole"
  | "denyRequest"
  | "previewAsk"
>;

export type AdminAiAccessBinding =
  | { readonly ok: true; readonly calls: AdminAiAccessCalls }
  | Exclude<NodeAdminGate, { readonly ok: true }>;

/**
 * Bind the authenticated caller, session or bearer, after the shared admin check.
 * The package keeps scope validation, self-approval refusal and the state machine.
 * The route must resolve userId from authentication, never from its JSON body.
 */
export async function bindAdminAiAccessCalls(
  authority: AdminAuthority,
  userId: string
): Promise<AdminAiAccessBinding> {
  let decision: Awaited<ReturnType<AgentToolAuthority["adminCheck"]>>;
  try {
    decision = await authority.adminCheck(userId);
  } catch {
    return nodeAdminUnavailable("agent_admin_check_threw");
  }
  if (decision === "unavailable")
    return nodeAdminUnavailable("agent_admin_unavailable");
  if (decision !== "allow")
    return { ok: false, status: 403, errorCode: "authz_denied" };

  const me = { userId, admin: Object.freeze({ userId }) };
  return {
    ok: true,
    calls: {
      list: () => authority.listNodeAi(),
      async on({ ref, scope }) {
        const { principalUserId, created } = await authority.grantRole({
          ...ref,
          scope,
          me,
        });
        return { principalUserId, changed: created };
      },
      async off({ ref, scope }) {
        const { principalUserId, revoked } = await authority.revokeRole({
          ...ref,
          scope,
          me,
        });
        return { principalUserId, changed: revoked };
      },
      async dismiss({ ref, scope }) {
        const { principalUserId, denied } = await authority.denyRequest({
          ...ref,
          scope,
          me,
        });
        return { principalUserId, changed: denied };
      },
      preview: (token) => authority.previewAsk({ token, resource: "node" }),
    },
  };
}

/** Pass an allowed binding's calls directly to adminAiAccessHttp. */
export async function getAdminAiAccessCalls(
  userId: string
): Promise<AdminAiAccessBinding> {
  return bindAdminAiAccessCalls(await getAgentToolAuthority(), userId);
}
