// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/knowledge-contribution-read`
 * Purpose: Bind existing authenticated node-local contribution read scope to AI tools.
 * Scope: Bounded open-list and coherent selected diff; no mutation or new auth identity. Does not perform source mutations.
 * Invariants: Execution node and authenticated actor required; retain actual author metadata.
 * Side-effects: IO (existing ContributionService reads only).
 * Links: https://cognidao.org/work/items/task.5367
 * @internal
 */
import type { KnowledgeContributionReadCapability } from "@cogni/ai-tools";
import type { ContributionService } from "@cogni/knowledge-store";
import { getExecutionScope } from "@/adapters/server/ai/execution-scope";

export function createKnowledgeContributionReadCapability(deps: {
  nodeId: string;
  service: Pick<ContributionService, "list" | "getById" | "diff"> | undefined;
}): KnowledgeContributionReadCapability {
  return {
    read: async (input) => {
      const scope = getExecutionScope();
      if (scope.nodeId !== deps.nodeId || !scope.actorUserId)
        throw new Error("knowledge_inbox_scope_unavailable");
      const service = deps.service;
      if (!service) throw new Error("knowledge_inbox_source_unavailable");
      const metadata = (
        record: Awaited<ReturnType<ContributionService["getById"]>>
      ) => {
        if (!record || record.state !== "open")
          throw new Error("knowledge_inbox_not_open");
        return {
          contributionId: record.contributionId,
          headCommit: record.headCommit,
          state: "open" as const,
          principalKind: record.principalKind,
          principalId: record.principalId,
          message: record.message,
        };
      };
      if (input.mode === "list_open") {
        const records = await service.list({
          query: { state: "open", limit: 100 },
        });
        return {
          mode: "list_open",
          nodeId: deps.nodeId,
          complete: records.length < 100,
          contributions: records.map(metadata),
        };
      }
      const before = metadata(await service.getById(input.contributionId));
      if (!before.headCommit) throw new Error("knowledge_inbox_head_unknown");
      const entries = await service.diff(input.contributionId);
      const after = metadata(await service.getById(input.contributionId));
      if (before.headCommit !== after.headCommit)
        throw new Error("knowledge_inbox_head_moved");
      if (new TextEncoder().encode(JSON.stringify(entries)).length > 65536)
        throw new Error("knowledge_inbox_diff_incomplete");
      return {
        mode: "read_diff",
        nodeId: deps.nodeId,
        complete: true,
        contribution: after,
        entries,
      };
    },
  };
}
