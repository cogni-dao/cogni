// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/node-registry/db-node-registry.adapter`
 * Purpose: NodeRegistryPort adapter projecting publicly-listed nodes from the operator `nodes` table.
 *   This is what makes wizard- and submodule-born nodes discoverable: their app tree is absent from
 *   the operator image (never fs-discoverable), but their row is always in the DB — so the table is
 *   the only viable projection.
 * Scope: Reads the live registry via an injected `listListedNodes` reader (service-role, non-RLS) and
 *   maps slug → NodeSummary by the catalog host convention. Degrades to [] on read failure so the
 *   homepage never breaks.
 * Invariants: PUBLIC_READ_IS_SEPARATE — the reader is service-role, never owner-scoped. `kind` is
 *   `full-app` (deployed homepage); hrefs derive from slug. No thumbnail → tile placeholder.
 * Side-effects: none here (IO is in the injected reader).
 * Links: src/ports/node-registry.port.ts, src/shared/node-registry/resolve.ts, src/shared/db/nodes.ts
 * @public
 */

import type { NodeRegistryPort, NodeSummary } from "@/ports";
import { resolveHref } from "@/shared/node-registry/resolve";

/** Title-case a kebab/snake slug for display (e.g. "node-template" → "Node Template"). */
function titleFromSlug(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export interface DbNodeRegistryDeps {
  /** Service-role read of publicly-listed node rows (status='active'). Throwing is tolerated → []. */
  readonly listListedNodes: () => Promise<
    readonly {
      readonly id: string;
      readonly slug: string;
      readonly repoOwner: string;
      readonly repoName: string;
      readonly repoUrl: string;
    }[]
  >;
  readonly domain: string | undefined;
}

/** Projects publicly-listed nodes from the `nodes` table. */
export class DbNodeRegistryAdapter implements NodeRegistryPort {
  constructor(private readonly deps: DbNodeRegistryDeps) {}

  async listPublic(): Promise<readonly NodeSummary[]> {
    let rows: Awaited<ReturnType<DbNodeRegistryDeps["listListedNodes"]>>;
    try {
      rows = await this.deps.listListedNodes();
    } catch {
      return [];
    }
    return rows.map(
      (row): NodeSummary => ({
        slug: row.slug,
        nodeId: row.id,
        title: titleFromSlug(row.slug),
        tagline: "",
        kind: "full-app",
        repo: {
          owner: row.repoOwner,
          name: row.repoName,
          url: row.repoUrl,
        },
        href: resolveHref({ name: row.slug }, this.deps.domain),
      })
    );
  }
}
