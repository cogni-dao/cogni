// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/compute/akash-managed-definition`
 * Purpose: Reuse the existing YAML/Zod service-image projection for private managed reads.
 * Scope: In-memory parsing only. Retained-cell callers keep their own image/ownership guards.
 * Invariants: YAML duplicate keys fail; opaque env fields are never interpreted or returned.
 * Side-effects: none
 * Links: database-cell-applied-managed.adapter.ts, akash-compute.adapter.ts
 * @internal
 */
import { parse } from "yaml";
import { z } from "zod";

const Definition = z.object({
  services: z.record(z.string(), z.object({ image: z.string() })),
});

/** Same projection and parser options as the retained-cell reader. */
export function parseManagedServiceImages(
  sdl: string
): Record<string, { image: string }> {
  return Definition.parse(parse(sdl)).services;
}
