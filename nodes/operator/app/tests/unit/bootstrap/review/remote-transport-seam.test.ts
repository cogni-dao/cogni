// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/review/remote-transport-seam`
 * Purpose: Bound the CD10 seam of task.5448. `resolveTransportFactory` looks the shared transport up at runtime
 *   because the pinned `@cogni/shared-ai-tools` has no usable one. This test FAILS once the installed package
 *   exports `createRemoteKnowledgeTransport` with `index`, so the bump cannot leave the seam behind unnoticed.
 * Scope: The real installed package, no fakes.
 * Invariants:
 *   - Owner flock-leader (story.5167 dev-manager); expiry 2026-12-16.
 *   - Closing proof: PR1 pins shared ai-tools with index, and the lookup is replaced by a static import.
 * Side-effects: none
 * Links: src/bootstrap/review/remote-knowledge.ts, task.5448
 * @internal
 */

import { describe, expect, it, vi } from "vitest";
import { resolveTransportFactory } from "@/bootstrap/review/remote-knowledge";

describe("runtime transport lookup (CD10 seam, task.5448)", () => {
  it("the installed shared ai-tools does not yet export the transport WITH index; if it does, delete the seam", () => {
    const factory = resolveTransportFactory();
    if (!factory) return; // 0.12: no transport at all
    const reader = factory({
      targets: [
        {
          alias: "seam-probe",
          nodeId: "00000000-0000-4000-8000-000000000000",
          origin: "https://seam-probe.example",
        },
      ],
      authorize: vi.fn(async () => "Bearer probe"),
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    expect(
      typeof reader.index,
      "The installed @cogni/shared-ai-tools now exports createRemoteKnowledgeTransport with index (PR1 landed). " +
        "Replace resolveTransportFactory with a static import and delete this test (CD10 seam, task.5448)."
    ).not.toBe("function");
  });
});
