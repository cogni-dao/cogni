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
 *     non-creator may set only triage fields priority/rank/labels/scores). Without it, `patch`
 *     stays on the markdown ports, which have no compare-and-set for callers.
 *     Priority (including 0/1) carries no extra node-admin gate (task.5306).
 *   - PATCH_REASON_AND_CITES (task.0086): the required `reason` and the optional `cites` are forwarded to the Doltgres store, the one enforcer;
 *     the markdown fallback (development only) has no history and ignores both.
 *   - PATCH_CAS_PASSTHROUGH: a caller `expectedRevision` is forwarded as the store's
 *     compare-and-set; the store's `WorkItemRevisionConflictError` becomes the ai-tools
 *     `WorkItemPatchConflictError` (nothing written). Absent ⇒ unconditioned patch.
 *   - MOVES_READ_AT_READ_TIME (story.0033): a `query` that returns exactly one item adds each move's baseline, current reading and verdict
 *     from `moveReadings`; a list or page read returns the stored moves only, so a page costs no metric lookup.
 *   - ONE_ITEM_ENVELOPE (task.0118): `read` (the `core__work_item_read` path) is the single-item envelope: it also adds each move's metric, KPI
 *     and goal (`moveReadings.context`) and, on request, the first page of citation links (`links`), both through the package's
 *     `composeItemEnvelope`, the same call the HTTP facade makes. `query` and `queryPage` never do.
 * Evaluation: returns package rankScore and forwards whole-score CAS patches without changing priority.
 * Side-effects: none (factory only)
 * Links: https://node-template.cognidao.org/knowledge/work-item-status-machine
 * @internal
 */

import {
  type WorkItemCapability,
  type WorkItemInfo,
  WorkItemPatchConflictError,
  type WorkItemQueryParams,
  type WorkItemTransitionResult,
} from "@cogni/shared-ai-tools";
import type {
  ActorKind,
  EnvelopeDegradedEvent,
  ItemLinksPort,
  MoveReadingPort,
  WorkItem,
  WorkItemCommandPort,
  WorkItemQueryPort,
  WorkItemStatus,
  WorkItemType,
} from "@cogni/work-items";
import {
  composeItemEnvelope,
  judgeMoveSummaries,
  toWorkItemDto,
  toWorkItemId,
  toWorkItemsPatchInput,
} from "@cogni/work-items";
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
  /** Reads the metrics a single item moves; absent means no metrics service (every move reads `unknown`). */
  readonly moveReadings?: MoveReadingPort | undefined;
  /** First page of an item's citation links (`read` with `includeLinks`); absent reads `unavailable`. */
  readonly links?: ItemLinksPort | undefined;
  /** One event per degraded envelope part (chain or links). */
  readonly log?: ((event: EnvelopeDegradedEvent) => void) | undefined;
  /**
   * Doltgres write path for `patch` (the store behind `PATCH /api/v1/work/items/{id}`).
   * When set, `patch` writes there as `principalId` instead of the markdown ports.
   */
  readonly backlogWriter?: {
    readonly store: Pick<WorkItemsDoltgresPort, "patch">;
    readonly principalId: string;
  };
}

function toWorkItemInfo(item: WorkItem): WorkItemInfo {
  const dto = toWorkItemDto(item);
  return {
    ...dto,
    assignees: dto.assignees.map((a) => ({
      ...a,
      id:
        a.kind === "user"
          ? a.userId
          : a.kind === "agent"
            ? a.agentId
            : a.serviceId,
    })),
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
      ...(params.labels && { labels: params.labels }),
      ...(params.labelPrefix && { labelPrefix: params.labelPrefix }),
      ...(params.scored !== undefined && { scored: params.scored }),
      ...(params.actor && { actor: params.actor as ActorKind }),
      ...(params.projectId && {
        projectId: toWorkItemId(params.projectId),
      }),
      ...(params.ids && { ids: params.ids.map((id) => toWorkItemId(id)) }),
      ...(params.cursor && { cursor: params.cursor }),
      ...(params.limit && { limit: params.limit }),
      ...(params.sortBy && { sortBy: params.sortBy }),
      ...(params.sortDirection && { sortDirection: params.sortDirection }),
    });
  }

  /** A one-item read gets each move judged from its observations (bounded: at most 3 moves). */
  async function withMoveReadings(
    items: readonly WorkItemInfo[]
  ): Promise<readonly WorkItemInfo[]> {
    const only = items.length === 1 ? items[0] : undefined;
    if (!only?.moves?.length) return items;
    return judgeMoveSummaries([only], deps.moveReadings);
  }

  /** The patch `set` without explicit-undefined keys (the route facade drops them the same way). */
  const definedOnly = (set: object): object =>
    Object.fromEntries(Object.entries(set).filter(([, v]) => v !== undefined));

  return {
    /**
     * THE single-item envelope (task.0118), the shape `GET /api/v1/work/items/{id}` serves: the item with each
     * move's readings, verdict and metric, KPI and goal, and with `includeLinks` the first page of citation links.
     */
    async read(id, options): Promise<WorkItemInfo | null> {
      const result = await listPage({ ids: [id], limit: 1 });
      const item = result.items
        .map(toWorkItemInfo)
        .find((entry) => entry.id === id);
      if (!item) return null;
      return composeItemEnvelope(
        item,
        { readings: deps.moveReadings, links: deps.links, log: deps.log },
        { includeLinks: options?.includeLinks === true }
      );
    },

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
      const result = await listPage(params);
      return withMoveReadings(result.items.map(toWorkItemInfo));
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
            toWorkItemsPatchInput({
              id: input.id,
              expectedRevision: input.expectedRevision,
              reason: input.reason,
              cites: input.cites,
              set: input.set,
            }),
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
        set: definedOnly(input.set) as NonNullable<
          Parameters<typeof workItemCommand.patch>[0]["set"]
        >,
      });

      return toWorkItemInfo(updated);
    },
  };
}
