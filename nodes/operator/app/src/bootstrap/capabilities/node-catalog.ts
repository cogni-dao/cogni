// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/node-catalog`
 * Purpose: Factory for the image-baked node catalog (`NodeCatalogPort`) for the `deploy/workloads` routes,
 *   so the route and the sequencer read the SAME source: the catalog bundled in the running image
 *   (story.5137 CD4). Routes may not import adapters.
 * Scope: Wiring only. Resolves the image root once and memoizes the adapter (the catalog is immutable
 *   for the life of the image).
 * Invariants:
 *   - IMAGE_CATALOG_NOT_MUTABLE_MAIN: never a network read of mutable `main`.
 * Side-effects: IO (existence check of `infra/catalog` under candidate roots, once)
 * Links: src/adapters/server/node-deploy/image-catalog.adapter.ts, src/bootstrap/container.ts
 * @internal
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { ImageCatalogNodes } from "@/adapters/server";
import type { EdgeHostCatalogPort, NodeCatalogPort } from "@/ports";

let cached: ImageCatalogNodes | undefined;

/** First root that holds `infra/catalog`: the image (`/app`), then the monorepo checkout (dev, tests). */
function imageRoot(): string {
  const candidates = [
    "/app",
    resolve(process.cwd(), "../../.."),
    process.cwd(),
  ];
  return (
    candidates.find((root) => existsSync(join(root, "infra", "catalog"))) ??
    "/app"
  );
}

export function createNodeCatalog(): NodeCatalogPort {
  cached ??= new ImageCatalogNodes({ root: imageRoot() });
  return cached;
}

/** The same image catalog as the edge application roster (story.5148 `edge.caught@1`). */
export function createEdgeHostCatalog(): EdgeHostCatalogPort {
  cached ??= new ImageCatalogNodes({ root: imageRoot() });
  return cached;
}
