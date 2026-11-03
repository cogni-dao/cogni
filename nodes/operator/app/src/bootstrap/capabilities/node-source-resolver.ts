// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/node-source-resolver`
 * Purpose: Factories for the `deploy/workloads` route's node source resolution and declaration read
 *   (story.5137). Routes may not import adapters.
 * Scope: Wiring only. The node source comes from the catalog baked into the operator image (the same
 *   `ImageCatalogNodes` the sequencer uses, root `COGNI_IMAGE_ROOT` or `/app`). The declaration reader
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
  ImageCatalogNodes,
} from "@/adapters/server";
import type { DeclarationReadPort, NodeSourceResolverPort } from "@/ports";
import type { ServerEnv } from "@/shared/env";
import { createOperatorDeployPlane } from "./operator-deploy-plane";

// One catalog index per process: the catalog is part of the immutable image.
let cachedNodeSource: NodeSourceResolverPort | undefined;

export function createNodeSourceResolver(): NodeSourceResolverPort {
  // The sequencer reads the same image root from the same variable (bootstrap/node-deploy-sequencer.ts).
  // biome-ignore lint/style/noProcessEnv: image-root override shared with the sequencer; not an app setting
  const root = process.env.COGNI_IMAGE_ROOT ?? "/app";
  cachedNodeSource ??= new ImageCatalogNodeSource(
    new ImageCatalogNodes({ root })
  );
  return cachedNodeSource;
}

export function createDeclarationReader(env: ServerEnv): DeclarationReadPort {
  return new AppOrPublicDeclarationReader(
    createOperatorDeployPlane(env),
    new GitHubPublicReader()
  );
}
