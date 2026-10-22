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
 *   - PRIORITY_RANGE (task.5294): after the gate, a priority outside 0..99 throws
 *     `WorkItemPriorityRangeError` (nothing written) — the same bound as the HTTP contracts.
 *   - P0P1_IS_NODE_ADMIN (task.5286, task.5294, story.5108): a `patch` that sets any priority <= 1,
 *     or moves an item OUT of p0/p1 (bound to the revision read), first runs
 *     `privilegedPriorityGate` — a `node.administer` check on the INVOKING actor, not the system
 *     principal the write is attributed to — and throws `WorkItemPriorityAuthzError` (nothing
 *     written) unless it allows. Unwired ⇒ fail closed. Priority 2+ and other fields are unchanged.
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

import {
  isPriorityInRange,
  isPrivilegedPriority,
  type NodeAdminGate,
  nodeAdminUnavailable,
} from "@/bootstrap/node-admin-gate";

/** A patch priority outside 0..99 (PRIORITY_RANGE). Nothing is written. */
export class WorkItemPriorityRangeError extends Error {
  constructor(priority: number) {
    super(`priority ${priority} is out of range: use an integer 0..99`);
    this.name = "WorkItemPriorityRangeError";
  }
}

/**
 * A priority-0/1 patch refused by the node-admin gate. `errorCode` keeps deny
 * (`authz_denied`) distinct from an authorization outage (`authz_unavailable`).
 */
export class WorkItemPriorityAuthzError extends Error {
  readonly errorCode: "authz_denied" | "authz_unavailable";

  constructor(
    errorCode: "authz_denied" | "authz_unavailable",
    priority: number
  ) {
    super(
      errorCode === "authz_denied"
        ? `${errorCode}: priority ${priority} requires node admin`
        : `${errorCode}: priority ${priority} could not be authorized`
    );
    this.name = "WorkItemPriorityAuthzError";
    this.errorCode = errorCode;
  }
}

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
    readonly store: Pick<WorkItemsDoltgresPort, "patch" | "get">;
    readonly principalId: string;
  };
  /**
   * P0P1_IS_NODE_ADMIN: decides whether the invoking actor may set priority 0/1. Called
   * only for those priorities, before any write. Absent ⇒ such patches fail closed.
   */
  readonly privilegedPriorityGate?: () => Promise<NodeAdminGate>;
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
      const priority = input.set.priority;
      const gatePriority = async (p: number) => {
        const gate = deps.privilegedPriorityGate
          ? await deps.privilegedPriorityGate()
          : nodeAdminUnavailable("no_priority_gate");
        if (!gate.ok) throw new WorkItemPriorityAuthzError(gate.errorCode, p);
      };
      // Demoting out of p0/p1 is privileged too (story.5108): gate on the stored priority.
      const gateDemotion = async (current: WorkItem | null) => {
        if (
          priority !== undefined &&
          current?.priority !== undefined &&
          current.priority !== priority &&
          isPrivilegedPriority(current.priority)
        )
          await gatePriority(current.priority);
      };
      if (priority !== undefined && isPrivilegedPriority(priority)) {
        await gatePriority(priority);
      }
      if (priority !== undefined && !isPriorityInRange(priority)) {
        throw new WorkItemPriorityRangeError(priority);
      }

      const writer = deps.backlogWriter;
      if (writer) {
        let expectedRevision = input.expectedRevision;
        if (priority !== undefined && !isPrivilegedPriority(priority)) {
          const current = await writer.store.get(toWorkItemId(input.id));
          await gateDemotion(current);
          if (current) {
            // The gate decided on THIS revision; a caller revision that differs is a lost CAS.
            if (
              expectedRevision !== undefined &&
              expectedRevision !== current.revision
            )
              throw new WorkItemPatchConflictError(
                input.id,
                expectedRevision,
                current.revision
              );
            expectedRevision = current.revision;
          }
        }
        try {
          const updated = await writer.store.patch(
            {
              id: toWorkItemId(input.id),
              ...(expectedRevision !== undefined && { expectedRevision }),
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
      await gateDemotion(current);

      const updated = await workItemCommand.patch({
        id: toWorkItemId(input.id),
        expectedRevision: String(current.revision),
        set: input.set,
      });

      return toWorkItemInfo(updated);
    },
  };
}
