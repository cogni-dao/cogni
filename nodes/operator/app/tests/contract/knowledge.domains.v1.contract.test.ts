// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/knowledge.domains.v1.contract`
 * Purpose: Pin domain delete response/conflict schemas and OpenAPI discovery.
 * Scope: Pure contract assertions; no route or persistence IO.
 * Invariants: MACHINE_DISCOVERABLE_DOMAIN_CONTROL_PLANE.
 * Side-effects: none
 * Links: packages/node-contracts/src/knowledge.domains.v1.contract.ts
 * @internal
 */

import {
  DomainsDeleteConflictResponseSchema,
  DomainsDeleteResponseSchema,
  OpenAPIV1,
} from "@cogni/node-contracts";
import { describe, expect, it } from "vitest";

describe("knowledge domains v1 contract", () => {
  it("accepts typed delete receipts and usage conflicts", () => {
    expect(
      DomainsDeleteResponseSchema.parse({ id: "temporary", deleted: true })
    ).toEqual({ id: "temporary", deleted: true });
    expect(
      DomainsDeleteConflictResponseSchema.parse({
        error: "domain_in_use",
        domain: "operator",
        entryCount: 68,
        referenceCount: 12,
      })
    ).toEqual({
      error: "domain_in_use",
      domain: "operator",
      entryCount: 68,
      referenceCount: 12,
    });
  });

  it("advertises list/create/delete with Bearer-or-session security", () => {
    const paths = OpenAPIV1.paths as Record<
      string,
      Record<string, { security?: unknown }>
    >;
    expect(paths["/knowledge/domains"]?.get).toBeDefined();
    expect(paths["/knowledge/domains"]?.post).toBeDefined();
    expect(paths["/knowledge/domains/{id}"]?.delete).toBeDefined();
    expect(paths["/knowledge/domains"]?.get?.security).toEqual([
      { bearerAuth: [] },
      { sessionCookie: [] },
    ]);
  });
});
