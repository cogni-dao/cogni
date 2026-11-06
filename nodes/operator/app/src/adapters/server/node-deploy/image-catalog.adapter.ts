// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/node-deploy/image-catalog.adapter`
 * Purpose: `NodeCatalogPort` over the catalog baked into the operator image (`infra/catalog/*.yaml`):
 *   node id -> { slug, row }. The sequencer reads a node's placement policy and pool limits from the
 *   row, and uses the slug as the OpenBao bucket name (task.5405).
 * Scope: Read-only filesystem. The catalog is part of the immutable image, so the index is built once
 *   per process (a failed build is not cached and is retried).
 * Invariants:
 *   - IMAGE_CATALOG_NOT_MUTABLE_MAIN: policy comes from the catalog bundled at the running build, never
 *     from a network read of mutable `main` (same rule as the database placement resolver).
 *   - NODE_ID_SOURCE: a SUBMODULE/fork row carries a drift-gated `node_id` projection; an IN-REPO row
 *     (no `source_repo`) has its identity in `nodes/<name>/.cogni/repo-spec.yaml`, which this reads.
 *   - SLUG_IS_THE_FILE_NAME: the slug is the catalog file's stem (the row's `name` must equal it);
 *     rows that fail either check are ignored, never guessed.
 *   - NO_NODE_NAMES: nothing here names a node.
 *   - FLEET_FILTER: `nodeDeploySlugs` admits only rows the configured fleet owns (`isFleetOwnedRow`).
 * Side-effects: IO (reads files under the image root)
 * Links: bootstrap/container.ts (readImageCatalogRow, the one-node twin), infra/catalog/_schema.json
 * @internal
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

import type { NodeCatalogEntry, NodeCatalogPort } from "@/ports";
import { isFleetOwnedRow } from "@/shared/node-registry/fleet-ownership";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z][a-z0-9-]{0,62}$/;

export interface ImageCatalogDeps {
  /** The image root that holds `infra/catalog` and `nodes/` (default `/app`). */
  readonly root: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export class ImageCatalogNodes implements NodeCatalogPort {
  private index: Map<string, NodeCatalogEntry> | undefined;
  private rows: NodeCatalogEntry[] = [];

  constructor(private readonly deps: ImageCatalogDeps) {}

  /**
   * Slugs of every node of THIS fleet whose catalog cell `compute_api[<env>]` is `node-deploy`: the nodes
   * the sequencer may deploy (and so may claim an edge host) in this env. Needs no node id.
   * FLEET_FILTER (story.5137 CD4): the same `isFleetOwnedRow` the route applies, so an operator never
   * claims a host for a node another fleet owns (the test operator never deploys canonical toks5). With no
   * `fleetOwner` a remote-source node is not admitted (fail closed).
   */
  async nodeDeploySlugs(
    env: string,
    fleetOwner: string | undefined
  ): Promise<string[]> {
    this.index ??= await this.build();
    return this.rows
      .filter((e) => {
        const cells = isRecord(e.row) ? e.row.compute_api : undefined;
        return (
          isRecord(cells) &&
          cells[env] === "node-deploy" &&
          isFleetOwnedRow(e.row, fleetOwner)
        );
      })
      .map((e) => e.slug);
  }

  async slugs(): Promise<readonly string[]> {
    this.index ??= await this.build();
    return this.rows.map((e) => e.slug);
  }

  async entryFor(nodeId: string): Promise<NodeCatalogEntry | undefined> {
    this.index ??= await this.build();
    return this.index.get(nodeId.toLowerCase());
  }

  private async build(): Promise<Map<string, NodeCatalogEntry>> {
    const dir = join(this.deps.root, "infra", "catalog");
    const index = new Map<string, NodeCatalogEntry>();
    this.rows = [];
    for (const file of await readdir(dir)) {
      if (!file.endsWith(".yaml") || file.startsWith("_")) continue;
      const slug = file.slice(0, -".yaml".length);
      if (!SLUG.test(slug)) continue;
      const row: unknown = parseYaml(await readFile(join(dir, file), "utf8"));
      if (!isRecord(row) || row.name !== slug) continue;
      this.rows.push({ slug, row });
      const nodeId = await this.nodeIdOf(row, slug);
      if (nodeId) index.set(nodeId.toLowerCase(), { slug, row });
    }
    return index;
  }

  private async nodeIdOf(
    row: Record<string, unknown>,
    slug: string
  ): Promise<string | undefined> {
    if (typeof row.node_id === "string" && UUID.test(row.node_id))
      return row.node_id;
    if (row.source_repo !== undefined) return undefined; // a submodule row must project its own id
    try {
      const spec: unknown = parseYaml(
        await readFile(
          join(this.deps.root, "nodes", slug, ".cogni", "repo-spec.yaml"),
          "utf8"
        )
      );
      return isRecord(spec) &&
        typeof spec.node_id === "string" &&
        UUID.test(spec.node_id)
        ? spec.node_id
        : undefined;
    } catch {
      return undefined;
    }
  }
}
