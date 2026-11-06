// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/node-source-resolver`
 * Purpose: Factories for the `deploy/workloads` route's node source resolution and declaration read
 *   (story.5137). Routes may not import adapters.
 * Scope: Wiring only. The node source comes from the catalog baked into the operator image (the same
 *   `ImageCatalogNodes` the sequencer and the lane guard use, via `createNodeCatalog`). The declaration reader
 *   is the operator App read with an anonymous public fallback for a repo the App is not installed on.
 * Side-effects: none (adapter calls deferred to callers)
 * Links: src/ports/deploy-plane.port.ts, src/adapters/server/node-deploy/image-catalog-source.adapter.ts,
 *   src/adapters/server/vcs/github-declaration-reader.adapter.ts
 * @internal
 */

import {
  AppOrPublicDeclarationReader,
  GitHubPublicReader,
  ImageCatalogNodeSource,
} from "@/adapters/server";
import type { DeclarationReadPort, NodeSourceResolverPort } from "@/ports";
import type { ServerEnv } from "@/shared/env";
import { createNodeCatalog } from "./node-catalog";
import { createOperatorDeployPlane } from "./operator-deploy-plane";

// ONE catalog source (story.5137): the image-baked catalog the route's lane guard and the sequencer read.
let cachedNodeSource: NodeSourceResolverPort | undefined;

export function createNodeSourceResolver(): NodeSourceResolverPort {
  cachedNodeSource ??= new ImageCatalogNodeSource(createNodeCatalog());
  return cachedNodeSource;
}

export function createDeclarationReader(env: ServerEnv): DeclarationReadPort {
  return new AppOrPublicDeclarationReader(
    createOperatorDeployPlane(env),
    new GitHubPublicReader()
  );
}
