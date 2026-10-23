// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/work-item`
 * Purpose: Factory for WorkItemCapability — bridges ai-tools interface to WorkItemQueryPort + WorkItemCommandPort.
 * Scope: Creates WorkItemCapability that delegates to hexagonal ports. Does not implement transport.
 * Invariants:
 *   - PORTS_ARE_AUTHORITY: All operations delegate to WorkItemQueryPort/WorkItemCommandPort
 *   - TRANSITION_TABLE_ENFORCED: CommandPort validates transitions
 *   - QUERY_READS_THE_LIVE_BACKLOG (task.5282): `query` lists through `backlogReader`
 *     when wired — in operator that is the Doltgres read path `GET /api/v1/work/items`
 *     uses (read pool, never writer admission). The runtime image carries no `work/`
 *     tree, so a markdown-bound query always saw an empty backlog.
 *   - WRITES_NOT_WIDENED: `transitionStatus` keeps its lookup + command on
 *     `workItemQuery` / `workItemCommand`; rebinding reads does not route writes anywhere new.
 *   - PATCH_ON_THE_LIVE_BACKLOG (story.5096): when `backlogWriter` is wired, `patch` goes
 *     through the SAME Doltgres `patch` that `PATCH /api/v1/work/items/{id}` uses, attributed
 *     to `backlogWriter.principalId`. The store's own authority applies unchanged (a
 *     non-creator may set only triage fields priority/rank/labels). Without it, `patch`
 *     stays on the markdown ports, which have no compare-and-set for callers.
 *     Priority (including 0/1) carries no extra node-admin gate (task.5306).
 *   - PATCH_CAS_PASSTHROUGH: a caller `expectedRevision` is forwarded as the store's
 *     compare-and-set; the store's `WorkItemRevisionConflictError` becomes the ai-tools
 *     `WorkItemPatchConflictError` (nothing written). Absent ⇒ unconditioned patch.
 * Side-effects: none (factory only)
 * Links: docs/spec/development-lifecycle.md
 * @internal
 */

import {
  type WorkItemCapability,
  type WorkItemInfo,
  WorkItemPatchConflictError,
  type WorkItemQueryParams,
  type WorkItemTransitionResult,
} from "@cogni/ai-tools";
import type {
  ActorKind,
  SubjectRef,
  WorkItem,
  WorkItemCommandPort,
  WorkItemQueryPort,
  WorkItemStatus,
  WorkItemType,
} from "@cogni/work-items";
import { toWorkItemId } from "@cogni/work-items";
import {
  WorkItemRevisionConflictError,
  type WorkItemsDoltgresPort,
} from "@cogni/work-items/adapters/doltgres";

/**
 * Dependencies for creating the work item capability.
 */
export interface WorkItemCapabilityDeps {
  /** Lookup port for the command path (transition/patch), and the `query` fallback. */
  readonly workItemQuery: WorkItemQueryPort;
  readonly workItemCommand: WorkItemCommandPort;
  /**
   * Read-only list port for `query`. When set, `query` lists through it instead of
   * `workItemQuery`. Structural `list` only — a store's richer list result (e.g.
   * Doltgres `pageInfo`) is accepted and ignored.
   */
  readonly backlogReader?: Pick<WorkItemQueryPort, "list">;
  /**
   * Doltgres write path for `patch` (the store behind `PATCH /api/v1/work/items/{id}`).
   * When set, `patch` writes there as `principalId` instead of the markdown ports.
   */
  readonly backlogWriter?: {
    readonly store: Pick<WorkItemsDoltgresPort, "patch">;
    readonly principalId: string;
  };
}

function assigneeId(a: SubjectRef): string {
  switch (a.kind) {
    case "user":
      return a.userId;
    case "agent":
      return a.agentId;
    case "system":
      return a.serviceId;
  }
}

function toWorkItemInfo(item: WorkItem): WorkItemInfo {
  return {
    id: item.id,
    type: item.type,
    title: item.title,
    status: item.status,
    labels: [...item.labels],
    assignees: item.assignees.map((a) => ({ kind: a.kind, id: assigneeId(a) })),
    updatedAt: item.updatedAt,
    ...(item.actor !== "either" && { actor: item.actor }),
    ...(item.priority !== undefined && { priority: item.priority }),
    ...(item.rank !== undefined && { rank: item.rank }),
    ...(item.summary !== undefined && { summary: item.summary }),
    ...(item.projectId !== undefined && { projectId: item.projectId }),
    ...(item.branch !== undefined && { branch: item.branch }),
    ...(item.pr !== undefined && { pr: item.pr }),
    ...(item.blockedBy !== undefined && { blockedBy: item.blockedBy }),
    ...(typeof item.revision === "number" && { revision: item.revision }),
    ...(item.outcome !== undefined && { outcome: item.outcome }),
    ...(item.estimate !== undefined && { estimate: item.estimate }),
    ...(item.scores !== undefined && { scores: item.scores }),
    ...(item.parentId !== undefined && { parentId: item.parentId }),
    ...(item.specRefs !== undefined && { specRefs: [...item.specRefs] }),
  };
}

/**
 * Create a WorkItemCapability backed by hexagonal ports.
 */
export function createWorkItemCapability(
  deps: WorkItemCapabilityDeps
): WorkItemCapability {
  const { workItemQuery, workItemCommand } = deps;
  const reader = deps.backlogReader ?? workItemQuery;

  async function listPage(params: WorkItemQueryParams) {
    return reader.list({
      ...(params.statuses && {
        statuses: params.statuses as readonly WorkItemStatus[],
      }),
      ...(params.types && {
        types: params.types as readonly WorkItemType[],
      }),
      ...(params.text && { text: params.text }),
      ...(params.actor && { actor: params.actor as ActorKind }),
      ...(params.projectId && {
        projectId: toWorkItemId(params.projectId),
      }),
      ...(params.ids && { ids: params.ids.map((id) => toWorkItemId(id)) }),
      ...(params.cursor && { cursor: params.cursor }),
      ...(params.limit && { limit: params.limit }),
    });
  }

  return {
    async queryPage(params) {
      const result = await listPage(params);
      return {
        items: result.items.map(toWorkItemInfo),
        ...(result.nextCursor !== undefined && {
          nextCursor: result.nextCursor,
        }),
      };
    },

    async query(params): Promise<readonly WorkItemInfo[]> {
      const result = await reader.list({
        ...(params.statuses && {
          statuses: params.statuses as readonly WorkItemStatus[],
        }),
        ...(params.types && {
          types: params.types as readonly WorkItemType[],
        }),
        ...(params.text && { text: params.text }),
        ...(params.actor && { actor: params.actor as ActorKind }),
        ...(params.projectId && {
          projectId: toWorkItemId(params.projectId),
        }),
        ...(params.limit && { limit: params.limit }),
      });
      return result.items.map(toWorkItemInfo);
    },

    async transitionStatus(input): Promise<WorkItemTransitionResult> {
      const current = await workItemQuery.get(toWorkItemId(input.id));
      if (!current) {
        throw new Error(`Work item not found: ${input.id}`);
      }

      const updated = await workItemCommand.transitionStatus({
        id: toWorkItemId(input.id),
        expectedRevision: String(current.revision),
        toStatus: input.toStatus as WorkItemStatus,
        ...(input.reason && { reason: input.reason }),
      });

      return {
        id: updated.id,
        previousStatus: current.status,
        newStatus: updated.status,
        revision: updated.revision as number,
      };
    },

    async patch(input): Promise<WorkItemInfo> {
      const writer = deps.backlogWriter;
      if (writer) {
        try {
          const updated = await writer.store.patch(
            {
              id: toWorkItemId(input.id),
              ...(input.expectedRevision !== undefined && {
                expectedRevision: input.expectedRevision,
              }),
              set: input.set,
            },
            writer.principalId
          );
          return toWorkItemInfo(updated);
        } catch (e) {
          if (e instanceof WorkItemRevisionConflictError) {
            throw new WorkItemPatchConflictError(
              e.id,
              e.expectedRevision,
              e.currentRevision
            );
          }
          throw e;
        }
      }

      if (input.expectedRevision !== undefined) {
        throw new Error(
          "expectedRevision requires the Doltgres backlog writer (not wired)"
        );
      }
      const current = await workItemQuery.get(toWorkItemId(input.id));
      if (!current) {
        throw new Error(`Work item not found: ${input.id}`);
      }

      const updated = await workItemCommand.patch({
        id: toWorkItemId(input.id),
        expectedRevision: String(current.revision),
        set: input.set,
      });

      return toWorkItemInfo(updated);
    },
  };
}
