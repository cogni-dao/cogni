// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/citation-links`
 * Purpose: The ONE read of an endpoint's depth-1 citation links, shared by `GET /api/v1/citations/{id}`
 *   (the UI's EntityCitationLinks), the work item route's `?include=links` and core__work_item_read.
 * Scope: Maps one `listCitationLinks` page to the wire shape. No writes, no endpoint body reads.
 * Invariants:
 *   - ONE_LINKS_READ (task.0118): every consumer reads links through `readCitationLinksPage`, so the
 *     UI and agents see the same edges, labels and tones.
 *   - LINKS_BOUNDED: one page of at most five links plus `nextCursor`; the caller pages on.
 *   - DELIBERATE_NODE_PORT (task.0118): this file is the node-owned implementation of the work-items
 *     `ItemLinksPort`. The composition, the deadline and the `unavailable` mapping live in
 *     `@cogni/work-items` (`composeItemEnvelope`); only this store adapter and the citations route are node code.
 * Side-effects: IO (knowledge store read)
 * Links: app/src/app/api/v1/citations/[id]/route.ts, https://node-template.cognidao.org/knowledge/knowledge-recall-path
 * @internal
 */

import type { KnowledgeStorePort } from "@cogni/knowledge-store";
import { isWorkItemEndpointId } from "@cogni/knowledge-store";
import { describeCitation } from "@cogni/shared-knowledge-store";
import { CitationLinksPageSchema, type ItemLinksPort } from "@cogni/work-items";

/** Canonical human URL for a node-local work item. */
export function workItemPermalink(id: string): string {
  return `/work/items/${encodeURIComponent(id)}`;
}

function endpoint(id: string, title: string | null) {
  const isWork = isWorkItemEndpointId(id);
  return {
    id,
    kind: isWork ? ("work" as const) : ("knowledge" as const),
    title,
    href: isWork
      ? workItemPermalink(id)
      : `/knowledge/${encodeURIComponent(id)}`,
  };
}

/** One page of links for `id`, validated against the wire schema. */
export async function readCitationLinksPage(
  port: Pick<KnowledgeStorePort, "listCitationLinks">,
  id: string,
  cursor?: string
) {
  const page = await port.listCitationLinks(id, cursor);
  const links = page.links.map((c) => {
    const direction = c.citingId === id ? ("out" as const) : ("in" as const);
    return {
      id: c.id,
      direction,
      citationType: c.citationType,
      source: endpoint(c.citingId, c.sourceTitle),
      target: endpoint(c.citedId, c.targetTitle),
      context: c.context,
      ...describeCitation(c.citationType, direction),
    };
  });
  return CitationLinksPageSchema.parse({ links, nextCursor: page.nextCursor });
}

/**
 * The node's implementation of the work-items `ItemLinksPort`: the first citation page of an item.
 * It throws when the store is absent or fails; `composeItemEnvelope` bounds the call with the
 * shared deadline and maps any failure to `links.unavailable`, so this adapter stays a plain read.
 */
export function createCitationLinksPort(
  getPort: () => Pick<KnowledgeStorePort, "listCitationLinks"> | undefined
): ItemLinksPort {
  return {
    async firstPage(id) {
      const port = getPort();
      if (!port) throw new Error("knowledge store is not configured");
      const page = await readCitationLinksPage(port, id);
      return { items: page.links, nextCursor: page.nextCursor };
    },
  };
}
