// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/built-image-resolver`
 * Purpose: Factory for the built-image digest resolver behind its port, for the `deploy/workloads`
 *   route (story.5127). Routes may not import adapters.
 * Scope: Wiring only. The resolver is anonymous; it needs no env or credential.
 * Side-effects: none
 * Links: src/ports/built-image.port.ts, src/adapters/server/oci/ghcr-built-image.adapter.ts
 * @internal
 */

import { GhcrBuiltImageResolver } from "@/adapters/server";
import type { BuiltImageResolverPort } from "@/ports";

export function createBuiltImageResolver(): BuiltImageResolverPort {
  return new GhcrBuiltImageResolver();
}
