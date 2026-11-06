// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/node-deploy/cloudflare-dns.adapter.test`
 * Purpose: Prove native zone identity parsing, bounded reads and credential-change invalidation.
 * Scope: The existing Cloudflare adapter with an injected HTTP transport; does not contact Cloudflare.
 * Invariants: A mismatched or unavailable identity cannot reach a DNS write; read access is not edit proof.
 * Side-effects: none
 * Links: cloudflare-dns.adapter.ts, subtask.5034
 * @internal
 */

import { describe, expect, it, vi } from "vitest";
import { resolveWorkloadZoneBinding } from "@/shared/node-registry/fleet-ownership";
import { CloudflareDnsRecords } from "./cloudflare-dns.adapter";

const binding = resolveWorkloadZoneBinding({
  fleetOwner: "cogni-test-org",
  zoneName: "cogni-testing.org",
});
const zoneId = "a".repeat(32);
const identity = (id = zoneId, name = binding.zoneName) =>
  Response.json({ success: true, result: { id, name } });
const input = {
  type: "CNAME",
  name: "spawny-boi-test.cogni-testing.org",
  content: "ingress.provider.example",
  proxied: true,
} as const;

function harness() {
  let credentials = { apiToken: "test-only-fake", zoneId };
  const fetchImpl = vi.fn<typeof fetch>();
  const config = {
    binding,
    ...credentials,
    fetchImpl,
    readCredentials: async () => ({ ...credentials }),
  };
  return {
    dns: new CloudflareDnsRecords(config),
    fetchImpl,
    config,
    rotate: (next: typeof credentials) => {
      credentials = next;
    },
  };
}

describe("Cloudflare workload zone identity", () => {
  it("reads the bound native ID with a timeout, parses its name, and reuses unchanged identity for DNS reads", async () => {
    const h = harness();
    h.fetchImpl
      .mockResolvedValueOnce(identity())
      .mockResolvedValueOnce(Response.json({ success: true, result: [] }));
    await h.dns.assertZoneIdentity(binding.zoneName);
    await h.dns.findByName(input.name);
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
    expect(h.fetchImpl.mock.calls[0]?.[0]).toBe(
      `https://api.cloudflare.com/client/v4/zones/${zoneId}`
    );
    expect(h.fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      signal: expect.any(AbortSignal),
    });
    expect(h.fetchImpl.mock.calls[1]?.[0]).toContain(
      `/zones/${zoneId}/dns_records?name=`
    );
  });

  it.each([
    "name",
    "id",
  ])("a wrong native %s is a typed mismatch and permits no edit", async (field) => {
    const h = harness();
    h.fetchImpl.mockResolvedValueOnce(
      field === "name"
        ? identity(zoneId, "cognidao.org")
        : identity("b".repeat(32))
    );
    await expect(
      h.dns.assertZoneIdentity(binding.zoneName)
    ).rejects.toMatchObject({ code: "zone_identity_mismatch" });
    await expect(h.dns.create(input)).rejects.toMatchObject({
      code: "zone_identity_unavailable",
    });
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    "denied",
    "malformed",
    "missing",
    "transport",
  ])("%s identity is typed unavailable", async (kind) => {
    const h = harness();
    if (kind === "transport")
      h.fetchImpl.mockRejectedValueOnce(new Error("timeout"));
    else
      h.fetchImpl.mockResolvedValueOnce(
        kind === "denied"
          ? new Response("denied", { status: 403 })
          : kind === "malformed"
            ? new Response("{")
            : Response.json({ success: true, result: {} })
      );
    await expect(
      h.dns.assertZoneIdentity(binding.zoneName)
    ).rejects.toMatchObject({ code: "zone_identity_unavailable" });
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    "token",
    "zoneId",
  ])("changed %s revalidates before a record call and fails closed on a mismatch", async (field) => {
    const h = harness();
    h.fetchImpl
      .mockResolvedValueOnce(identity())
      .mockResolvedValueOnce(identity("b".repeat(32), "cognidao.org"));
    await h.dns.assertZoneIdentity(binding.zoneName);
    h.rotate({
      apiToken: field === "token" ? "rotated-fake" : "test-only-fake",
      zoneId: field === "zoneId" ? "b".repeat(32) : zoneId,
    });
    await expect(h.dns.create(input)).rejects.toMatchObject({
      code: "zone_identity_mismatch",
    });
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
    expect(
      h.fetchImpl.mock.calls.every(([, options]) => options?.method === "GET")
    ).toBe(true);
  });

  it("a new adapter after restart has no inherited identity proof", async () => {
    const h = harness();
    h.fetchImpl
      .mockResolvedValueOnce(identity())
      .mockResolvedValueOnce(new Response("denied", { status: 403 }));
    await h.dns.assertZoneIdentity(binding.zoneName);
    await expect(
      new CloudflareDnsRecords(h.config).assertZoneIdentity(binding.zoneName)
    ).rejects.toMatchObject({ code: "zone_identity_unavailable" });
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("an identity read does not turn a denied edit into success", async () => {
    const h = harness();
    h.fetchImpl
      .mockResolvedValueOnce(identity())
      .mockResolvedValueOnce(
        Response.json({ success: false }, { status: 403 })
      );
    await h.dns.assertZoneIdentity(binding.zoneName);
    await expect(h.dns.create(input)).rejects.toThrow(/403/);
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
    expect(h.fetchImpl.mock.calls[1]?.[1]?.method).toBe("POST");
  });
});
