// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/node-code`
 * Purpose: Bind immutable code reads to this node, source repository and serving revision.
 * Scope: Existing App installation contents:read only; no local filesystem fallback or new grants.
 * Invariants: Normal ToolRunner requires node.flight developer authority; reject wrong execution node.
 * Side-effects: none at construction; injected capability performs GitHub reads.
 * Links: https://cognidao.org/work/items/subtask.5027
 * @internal
 */
import type { NodeCodeCapability } from "@cogni/ai-tools";
import { GitHubVcsAdapter } from "@/adapters/server";
import { getExecutionScope } from "@/adapters/server/ai/execution-scope";

export function createNodeCodeCapability(deps: {
  nodeId: string;
  origin: string;
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
  if (
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
        origin: new URL(deps.origin).origin,
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
  function scoped(): NodeCodeCapability {
    const scope = getExecutionScope();
    if (!scope.actorUserId || scope.nodeId !== deps.nodeId)
      throw new Error("node_code_scope_unavailable");
    if (!reader) throw new Error("node_code_source_unavailable");
    return reader;
  }
  return {
    read: async (input) => scoped().read(input),
    list: async (input) => scoped().list(input),
  };
}
