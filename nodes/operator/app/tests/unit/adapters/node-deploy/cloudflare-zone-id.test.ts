// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/node-deploy/cloudflare-zone-id`
 * Purpose: Pin `resolveCloudflareZoneId` (story.5137): the edge zone id comes from the zone NAME and the
 *   token's own scope, and anything but exactly one matching zone is refused.
 * Side-effects: none (fetch is injected)
 */

import { describe, expect, it } from "vitest";

import { resolveCloudflareZoneId } from "@/adapters/server/node-deploy/cloudflare-dns.adapter";

const reply = (status: number, body: unknown): typeof fetch =>
  (async () =>
    new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("resolveCloudflareZoneId", () => {
  it("asks for the zone by name with the bearer token and returns its id", async () => {
    let url = "";
    let auth = "";
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      url = input;
      auth = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(
        JSON.stringify({
          success: true,
          result: [{ id: "zone-test", name: "cogni-testing.org" }],
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;
    await expect(
      resolveCloudflareZoneId({
        apiToken: "tok",
        zoneName: "cogni-testing.org",
        fetchImpl,
      })
    ).resolves.toBe("zone-test");
    expect(url).toBe(
      "https://api.cloudflare.com/client/v4/zones?name=cogni-testing.org"
    );
    expect(auth).toBe("Bearer tok");
  });

  it("refuses when the token sees no zone by that name", async () => {
    await expect(
      resolveCloudflareZoneId({
        apiToken: "tok",
        zoneName: "cogni-testing.org",
        fetchImpl: reply(200, {
          success: true,
          result: [{ id: "zone-prod", name: "cognidao.org" }],
        }),
      })
    ).rejects.toThrow(/token sees 0 zones/);
  });

  it("refuses an API error", async () => {
    await expect(
      resolveCloudflareZoneId({
        apiToken: "tok",
        zoneName: "cogni-testing.org",
        fetchImpl: reply(403, {
          success: false,
          errors: [{ code: 10000, message: "Authentication error" }],
        }),
      })
    ).rejects.toThrow(/cloudflare GET \/zones -> 403/);
  });
});
