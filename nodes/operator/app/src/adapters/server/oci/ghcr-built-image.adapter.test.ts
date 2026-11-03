// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/oci/ghcr-built-image.adapter` (test)
 * Purpose: Pin the anonymous OCI resolution of `<image>:sha-<sha>` to a digest-pinned reference, with
 *   a fake fetch standing in for ghcr.io (story.5127).
 * Side-effects: none
 */

import { describe, expect, it, vi } from "vitest";

import { BuiltImageRegistryError } from "@/ports";

import { GhcrBuiltImageResolver } from "./ghcr-built-image.adapter";

const SHA = "3521b6422693fbbe1c7f80fe9ed9f476721e0970";
const DIGEST = `sha256:${"ab".repeat(32)}`;
const input = { imageRepository: "ghcr.io/cogni-dao/toks5", sourceSha: SHA };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

function fakeRegistry(manifest: Response) {
  return vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.startsWith("https://ghcr.io/token")) return json({ token: "tok" });
    return manifest.clone();
  });
}

describe("GhcrBuiltImageResolver", () => {
  it("asks for an anonymous pull token, then HEADs the sha tag and returns repo@digest", async () => {
    const fetchImpl = fakeRegistry(
      new Response(null, {
        status: 200,
        headers: { "docker-content-digest": DIGEST },
      })
    );
    const resolver = new GhcrBuiltImageResolver(
      fetchImpl as unknown as typeof fetch
    );
    await expect(resolver.resolveBuiltImage(input)).resolves.toBe(
      `ghcr.io/cogni-dao/toks5@${DIGEST}`
    );

    const [tokenUrl] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(tokenUrl).toBe(
      "https://ghcr.io/token?service=ghcr.io&scope=repository%3Acogni-dao%2Ftoks5%3Apull"
    );
    const [manifestUrl, manifestInit] = fetchImpl.mock.calls[1] as unknown as [
      string,
      RequestInit,
    ];
    expect(manifestUrl).toBe(
      `https://ghcr.io/v2/cogni-dao/toks5/manifests/sha-${SHA}`
    );
    expect(manifestInit.method).toBe("HEAD");
    const headers = manifestInit.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tok");
    expect(headers.accept).toContain("application/vnd.oci.image.index.v1+json");
    expect(headers.accept).toContain(
      "application/vnd.docker.distribution.manifest.list.v2+json"
    );
    expect(headers.accept).toContain(
      "application/vnd.oci.image.manifest.v1+json"
    );
  });

  it.each([
    401, 403, 404,
  ])("reads a %s manifest as an absent image (null, not an error)", async (status) => {
    const resolver = new GhcrBuiltImageResolver(
      fakeRegistry(new Response(null, { status })) as unknown as typeof fetch
    );
    await expect(resolver.resolveBuiltImage(input)).resolves.toBeNull();
  });

  it("fails with a registry error on a 5xx, a missing digest header, or a malformed digest", async () => {
    for (const manifest of [
      new Response(null, { status: 503 }),
      new Response(null, { status: 200 }),
      new Response(null, {
        status: 200,
        headers: { "docker-content-digest": "sha256:short" },
      }),
    ]) {
      const resolver = new GhcrBuiltImageResolver(
        fakeRegistry(manifest) as unknown as typeof fetch
      );
      await expect(resolver.resolveBuiltImage(input)).rejects.toBeInstanceOf(
        BuiltImageRegistryError
      );
    }
  });

  it("fails with a registry error when the registry is unreachable", async () => {
    const resolver = new GhcrBuiltImageResolver(
      vi.fn(async () => {
        throw new Error("ECONNRESET");
      }) as unknown as typeof fetch
    );
    await expect(resolver.resolveBuiltImage(input)).rejects.toBeInstanceOf(
      BuiltImageRegistryError
    );
  });

  it("refuses a non-ghcr repository or a non-sha tag before any request", async () => {
    const fetchImpl = vi.fn();
    const resolver = new GhcrBuiltImageResolver(
      fetchImpl as unknown as typeof fetch
    );
    await expect(
      resolver.resolveBuiltImage({
        imageRepository: "docker.io/library/python",
        sourceSha: SHA,
      })
    ).rejects.toBeInstanceOf(BuiltImageRegistryError);
    await expect(
      resolver.resolveBuiltImage({ ...input, sourceSha: "main" })
    ).rejects.toBeInstanceOf(BuiltImageRegistryError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
