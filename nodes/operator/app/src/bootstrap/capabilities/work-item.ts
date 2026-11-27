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
 *   - ACTOR_IS_PRINCIPAL: released host writers resolve attribution for each call; a missing principal writes nothing.
 *   - PATCH_REASON_CITES_CAS: forwards id/reason/cites/revision/set to the released Doltgres
 *     patch, translating only its revision conflict. Gate errors propagate unchanged.
 *   - NO_MARKDOWN_WRITE_FALLBACK: missing Doltgres writer refuses every patch.
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
} from "@cogni/shared-ai-tools";
import type {
  ActorKind,
  EnvelopeDegradedEvent,
  ItemArtifactsPort,
  ItemLinksPort,
  ItemRefPorts,
  MoveReadingPort,
  WorkItem,
  WorkItemQueryPort,
  WorkItemStatus,
  WorkItemType,
  WriteAttribution,
} from "@cogni/work-items";
import {
  composeItemEnvelope,
  type createWorkItemWriters,
  judgeMoveSummaries,
  toWorkItemDto,
  toWorkItemId,
  toWorkItemsPatchInput,
} from "@cogni/work-items";
import { WorkItemRevisionConflictError } from "@cogni/work-items/adapters/doltgres";

/**
 * Dependencies for creating the work item capability.
 */
export interface WorkItemCapabilityDeps {
  /** Fallback query port when the Doltgres reader is absent. */
  readonly workItemQuery: WorkItemQueryPort;
  /** Host-bound program limits, checked before the released attributed writer. */
  readonly patchFields?: () => "all" | readonly string[];
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
  readonly refs?: ItemRefPorts | undefined;
  readonly artifacts?: ItemArtifactsPort | undefined;
  /** One event per degraded envelope part (chain or links). */
  readonly log?: ((event: EnvelopeDegradedEvent) => void) | undefined;
  /** Released host binding; attribution is read per invocation, never cached or supplied by the model. */
  readonly backlogWriter?: ReturnType<
    typeof createWorkItemWriters
  >["backlogWriter"];
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
  const { workItemQuery } = deps;
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

  return {
    /**
     * THE single-item envelope (task.0118), the shape `GET /api/v1/work/items/{id}` serves: the item with each
     * move's readings, verdict and metric, KPI and goal, and with `includeLinks` the first page of citation links.
     */
    async read(id, options) {
      const result = await listPage({ ids: [id], limit: 1 });
      const matches = result.items.filter((entry) => entry.id === id);
      if (matches.length > 1)
        throw new Error("work_source_unavailable: ambiguous item");
      const item = matches[0] ? toWorkItemInfo(matches[0]) : undefined;
      if (!item) return null;
      if (!Number.isSafeInteger(item.revision)) {
        throw new Error(
          "work_source_revision_unavailable: exact item has no numeric revision"
        );
      }
      return composeItemEnvelope(
        item,
        {
          readings: deps.moveReadings,
          links: deps.links,
          artifacts: deps.artifacts,
          ...deps.refs,
          log: deps.log,
        },
        options
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

    async patch(input): Promise<WorkItemInfo> {
      const fields = deps.patchFields?.();
      if (fields !== undefined && fields !== "all") {
        const forbidden = Object.keys(input.set).filter(
          (field) => !fields.includes(field)
        );
        if (forbidden.length) {
          throw new Error(`work_item_field_denied: ${forbidden.join(", ")}`);
        }
      }
      const writer = deps.backlogWriter;
      if (writer) {
        let attribution: WriteAttribution;
        try {
          attribution = writer.attribution();
        } catch (error) {
          writer.attributionDenied({ workItemId: input.id, error });
          throw error;
        }
        try {
          const updated = await writer.store.patch(
            toWorkItemsPatchInput({
              id: input.id,
              expectedRevision: input.expectedRevision,
              reason: input.reason,
              cites: input.cites,
              set: input.set,
            }),
            attribution
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

      throw new Error(
        "Doltgres backlog writer required for attributed work item updates"
      );
    },
  };
}
