// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/node-deploy/image-catalog-source.adapter`
 * Purpose: Resolve a node's source repo and image repository from the catalog baked into the operator
 *   image (`ImageCatalogNodes`), so the deploy route resolves a node in EVERY env the way the
 *   sequencer does, not through a GitHub read of an env-specific parent repo (story.5137).
 * Scope: Read-only. Parses the row with the strict remote-source check the flight path uses
 *   (`parseRemoteSourceCatalogRow`: source/image agreement, path prefix).
 * Invariants:
 *   - ONE_CATALOG_ALL_ENVS: the image catalog is the only source; no env or parent repo changes the answer.
 *   - IN_REPO_NODE_KEEPS_PARENT: a row with no `source_repo` (the operator) resolves to the caller's
 *     parent repo with `imageRepository: null`.
 *   - ABSENT_IS_CATALOG_MISSING: an unknown node id is a coded `catalog_missing` (404).
 * Side-effects: IO (through the injected catalog)
 * Links: adapters/server/node-deploy/image-catalog.adapter.ts, ports/deploy-plane.port.ts
 * @internal
 */

import type {
  NodeCatalogPort,
  NodeSourceResolverPort,
  ResolvedNodeSource,
} from "@/ports";
import { parseRemoteSourceCatalogRow } from "../vcs/github-repo-write";

export class ImageCatalogNodeSource implements NodeSourceResolverPort {
  constructor(private readonly catalog: NodeCatalogPort) {}

  async resolveNodeSource(input: {
    readonly nodeId: string;
    readonly parentOwner: string;
    readonly parentRepo: string;
  }): Promise<ResolvedNodeSource> {
    const entry = await this.catalog.entryFor(input.nodeId);
    if (!entry)
      throw Object.assign(new Error("node catalog entry not found"), {
        code: "catalog_missing",
        status: 404,
      });
    const row = entry.row as { source_repo?: unknown } | null;
    if (row?.source_repo === undefined)
      return {
        owner: input.parentOwner,
        repo: input.parentRepo,
        imageRepository: null,
      };
    const remote = parseRemoteSourceCatalogRow(entry.row, entry.slug);
    return {
      owner: remote.sourceRepo.owner,
      repo: remote.sourceRepo.repo,
      imageRepository: remote.imageRepository,
    };
  }
}
