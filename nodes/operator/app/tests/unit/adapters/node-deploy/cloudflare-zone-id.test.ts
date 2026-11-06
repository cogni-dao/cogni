// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/node-deploy/cloudflare-zone-id`
 * Purpose: Preserve core story.5137's isolated DNS identity coverage through the sole native ID owner.
 * Scope: Injected HTTP transport only; no Cloudflare calls.
 * Invariants: The projected zone ID must name the configured zone; never substitute a by-name result.
 * Side-effects: none
 */

import { describe, expect, it, vi } from "vitest";
import { CloudflareDnsRecords } from "@/adapters/server/node-deploy/cloudflare-dns.adapter";
import { resolveWorkloadZoneBinding } from "@/shared/node-registry/fleet-ownership";

const binding = resolveWorkloadZoneBinding({
  fleetOwner: "cogni-test-org",
  zoneName: "cogni-testing.org",
});
const zoneId = "a".repeat(32);
const record = {
  type: "CNAME",
  name: "spawny-boi-test.cogni-testing.org",
  content: "ingress.provider.example",
  proxied: true,
} as const;
const harness = (body: unknown, status = 200) => {
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(JSON.stringify(body), { status }));
  return {
    fetchImpl,
    dns: new CloudflareDnsRecords({
      binding,
      zoneId,
      apiToken: "test-only-fake",
      fetchImpl,
    }),
  };
};

describe("configured Cloudflare zone ID", () => {
  it("reads the projected native ID with the scoped bearer and verifies the configured name", async () => {
    const h = harness({
      success: true,
      result: { id: zoneId, name: binding.zoneName },
    });
    await expect(
      h.dns.assertZoneIdentity(binding.zoneName)
    ).resolves.toBeUndefined();
    expect(h.fetchImpl).toHaveBeenCalledExactlyOnceWith(
      `https://api.cloudflare.com/client/v4/zones/${zoneId}`,
      expect.objectContaining({
        method: "GET",
        headers: { authorization: "Bearer test-only-fake" },
        signal: expect.any(AbortSignal),
      })
    );
  });

  it("refuses a native zone with another name without looking up or substituting another ID", async () => {
    const h = harness({
      success: true,
      result: { id: zoneId, name: "cognidao.org" },
    });
    await expect(
      h.dns.assertZoneIdentity(binding.zoneName)
    ).rejects.toMatchObject({ code: "zone_identity_mismatch" });
    await expect(h.dns.create(record)).rejects.toMatchObject({
      code: "zone_identity_unavailable",
    });
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses a denied identity read before any DNS edit", async () => {
    const h = harness(
      {
        success: false,
        errors: [{ code: 10000, message: "Authentication error" }],
      },
      403
    );
    await expect(
      h.dns.assertZoneIdentity(binding.zoneName)
    ).rejects.toMatchObject({ code: "zone_identity_unavailable" });
    await expect(h.dns.create(record)).rejects.toMatchObject({
      code: "zone_identity_unavailable",
    });
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
  });
});
