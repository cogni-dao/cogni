// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/work-item-refs`
 * Purpose: The node's adapters for the work-items envelope's ref ports (story.0058): the first page of artifact refs, the
 *   first page of history refs and one artifact by id. The HTTP facade and core__work_item_read wire the same ports.
 * Scope: Maps the Doltgres store to `ItemArtifactRefsPort`, `ItemHistoryRefsPort` and `ItemArtifactByIdPort`. The page cut,
 *   the ref shape, the deadline and the `unavailable` mapping live in `@cogni/work-items`.
 * Invariants:
 *   - REFS_FIRST: lists carry refs only; one artifact in full comes from `artifactById`.
 *   - ABSENT_STORE_IS_ABSENT_PORT: a node without the store gets no port, so the part reads `unavailable`.
 * Side-effects: IO (Doltgres reads through the store)
 * Links: hub work-item-artifacts, change-history-design
 * @internal
 */

import {
  type ItemArtifactByIdPort,
  type ItemArtifactRefsPort,
  type ItemHistoryRefsPort,
  readArtifactRefsPage,
  readHistoryRefsPage,
  toWorkItemId,
  type WorkItemArtifactStore,
  type WorkItemHistoryStore,
} from "@cogni/work-items";

export interface ItemRefPorts {
  readonly artifactRefs?: ItemArtifactRefsPort;
  readonly historyRefs?: ItemHistoryRefsPort;
  readonly artifactById?: ItemArtifactByIdPort;
}

export function createItemRefPorts(deps: {
  readonly artifacts?: WorkItemArtifactStore | undefined;
  readonly history?: Pick<WorkItemHistoryStore, "historyPage"> | undefined;
}): ItemRefPorts {
  const { artifacts } = deps;
  const historyPage = deps.history?.historyPage?.bind(deps.history);
  return {
    ...(artifacts
      ? {
          artifactRefs: {
            firstPage: (id) => readArtifactRefsPage(artifacts, id),
          },
          artifactById: {
            get: (id, artifactId) => artifacts.get(id, artifactId),
          },
        }
      : {}),
    ...(historyPage
      ? {
          historyRefs: {
            firstPage: (id) =>
              readHistoryRefsPage({ historyPage }, toWorkItemId(id)),
          },
        }
      : {}),
  };
}
