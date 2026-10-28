// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/node-code`
 * Purpose: Bind immutable code reads to this node, source repository and serving revision.
 * Scope: Existing App installation contents:read only; no local filesystem fallback or new grants. Does not perform source mutations.
 * Invariants: ToolRunner and this bound capability independently require computed node.flight authority; reject wrong execution node.
 * Side-effects: none
 * Links: https://cognidao.org/work/items/subtask.5027
 * @internal
 */

import type { NodeCodeCapability } from "@cogni/ai-tools";
import {
  type AuthorizationPort,
  type AuthzDecision,
  authzNodeResource,
} from "@cogni/authorization-core";
import { GitHubVcsAdapter, getExecutionScope } from "@/adapters/server";

export function createNodeCodeCapability(deps: {
  getAuthorization?: () => AuthorizationPort | undefined;
  nodeId: string;
  origin: string | undefined;
  owner: string;
  repo: string;
  commitSha: string | undefined;
  appId: string | undefined;
  privateKeyBase64: string | undefined;
  log: {
    info(fields: Record<string, unknown>): void;
    warn(fields: Record<string, unknown>): void;
  };
}): NodeCodeCapability {
  let reader: NodeCodeCapability | undefined;
  let origin: string | undefined;
  if (deps.origin) {
    try {
      const parsed = new URL(deps.origin);
      if (parsed.protocol === "https:" || parsed.protocol === "http:")
        origin = parsed.origin;
    } catch {
      /* Invalid optional source configuration remains unavailable. */
    }
  }
  if (
    origin &&
    deps.appId &&
    deps.privateKeyBase64 &&
    deps.commitSha &&
    /^[0-9a-f]{40}$/.test(deps.commitSha)
  ) {
    const adapter = new GitHubVcsAdapter({
      appId: deps.appId,
      privateKey: Buffer.from(deps.privateKeyBase64, "base64").toString("utf8"),
    });
    reader = adapter.nodeCodeReader(
      {
        nodeId: deps.nodeId,
        origin,
        owner: deps.owner,
        repo: deps.repo,
        commitSha: deps.commitSha,
        roots: [
          "packages",
          "nodes/operator/app/src",
          "nodes/operator/graphs",
          "docs/spec",
          "docs/guides",
          "tests",
        ],
        manifests: [
          "package.json",
          "pnpm-workspace.yaml",
          "tsconfig.json",
          "tsconfig.base.json",
          "biome.json",
        ],
      },
      deps.log
    );
  }
  async function scoped(): Promise<NodeCodeCapability> {
    const scope = getExecutionScope();
    if (!scope.actorUserId || scope.nodeId !== deps.nodeId)
      throw new Error("node_code_scope_unavailable");
    if (!reader) throw new Error("node_code_source_unavailable");
    const authorization = deps.getAuthorization?.();
    if (!authorization) throw new Error("node_code_authz_unavailable");
    let decision: AuthzDecision;
    try {
      decision = await authorization.check({
        actorId: `user:${scope.actorUserId}`,
        action: "node.flight",
        resource: authzNodeResource(deps.nodeId),
        context: {
          nodeId: deps.nodeId,
          tenantId: scope.billing.billingAccountId,
          ...(scope.grantId ? { grantId: scope.grantId } : {}),
        },
      });
    } catch {
      throw new Error("node_code_authz_unavailable");
    }
    if (decision.decision !== "allow")
      throw new Error(
        decision.code === "authz_unavailable"
          ? "node_code_authz_unavailable"
          : "node_code_authz_denied"
      );
    return reader;
  }
  return {
    read: async (input) => (await scoped()).read(input),
    list: async (input) => (await scoped()).list(input),
  };
}
