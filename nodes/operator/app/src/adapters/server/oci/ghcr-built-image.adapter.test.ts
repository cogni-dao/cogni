// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/oci/ghcr-built-image.adapter.test`
 * Purpose: Prove immutable OCI image and bundle reads through the native registry adapter.
 * Scope: Registry transport and artifact integrity; does not sequence releases or make network calls.
 * Invariants: Digests remain pinned; redirects contain registry credentials; IO has one bounded deadline.
 * Side-effects: none
 * Links: ghcr-built-image.adapter.ts, bug.5568
 */

import { createHash } from "node:crypto";
import {
  NODE_BUNDLE_ARTIFACT_TYPE,
  NODE_BUNDLE_PAYLOAD_FILE,
  NODE_BUNDLE_PAYLOAD_MEDIA_TYPE,
} from "@cogni/repo-spec";
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

const SHA_1 = "a".repeat(40);
const POLY_ID = "4b06359a-0000-4000-8000-0000000000aa";
const PUBLIC_IMAGE = `ghcr.io/example/node@sha256:${"c".repeat(64)}`;
const HELPER_IMAGE = `ghcr.io/example/node-helper@sha256:${"d".repeat(64)}`;
function requiredFixture<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("missing fixture");
  return value;
}

describe("bounded OCI publication read", () => {
  const digest = (s: string) =>
    `sha256:${createHash("sha256").update(s).digest("hex")}`;
  function registry(redirect = "", corrupt = false) {
    const payload = JSON.stringify({
      schema_version: 1,
      node_id: POLY_ID,
      source: { repository: "example/node", sha: SHA_1 },
      artifacts: [
        { name: "app", image: PUBLIC_IMAGE },
        { name: "helper", image: HELPER_IMAGE },
      ],
      services: [
        { name: "canary", artifact: "app" },
        { name: "helper", artifact: "helper" },
      ],
    });
    const manifest = JSON.stringify({
      artifactType: NODE_BUNDLE_ARTIFACT_TYPE,
      layers: [
        {
          digest: digest(payload),
          size: Buffer.byteLength(payload),
          mediaType: NODE_BUNDLE_PAYLOAD_MEDIA_TYPE,
          annotations: {
            "org.opencontainers.image.title": NODE_BUNDLE_PAYLOAD_FILE,
          },
        },
      ],
    });
    const calls: {
      url: string;
      authorization: string | null;
      redirect?: RequestRedirect;
    }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({
        url,
        authorization: new Headers(init?.headers).get("authorization"),
        ...(init?.redirect ? { redirect: init.redirect } : {}),
      });
      if (url.includes("/token?"))
        return new Response(JSON.stringify({ token: "registry-only" }));
      if (url.includes("/manifests/"))
        return new Response(manifest, {
          headers: { "docker-content-digest": digest(manifest) },
        });
      if (
        url.includes("/blobs/") &&
        new URL(url).origin === "https://ghcr.io" &&
        redirect
      )
        return new Response(null, {
          status: 307,
          headers: { location: redirect },
        });
      return new Response(corrupt ? "corrupted" : payload);
    };
    return {
      resolver: new GhcrBuiltImageResolver(fetcher),
      calls,
      ref: `ghcr.io/example/node@${digest(manifest)}`,
    };
  }
  it("reads accepted publication by digest and strips registry bearer on its one allowed blob redirect", async () => {
    const r = registry(
      "https://pkg-containers.githubusercontent.com/ghcr1/blobs/object"
    );
    const result = await r.resolver.resolveArtifactBundle({
      imageRepository: "ghcr.io/example/node",
      sourceSha: SHA_1,
      acceptedDigest: r.ref,
    });
    expect(result?.digestRef).toBe(r.ref);
    expect(r.calls[1]?.url).toContain(`/manifests/${r.ref.split("@")[1]}`);
    expect(r.calls.at(-1)?.authorization).toBeNull();
    expect(r.calls.at(-1)?.redirect).toBe("error");
  });
  it("refuses an external redirect without sending bearer credentials there", async () => {
    const r = registry("https://attacker.invalid/blob");
    await expect(
      r.resolver.resolveArtifactBundle({
        imageRepository: "ghcr.io/example/node",
        sourceSha: SHA_1,
      })
    ).rejects.toMatchObject({ invalid: true });
    expect(r.calls.some((c) => c.url.includes("attacker.invalid"))).toBe(false);
  });
  it("refuses payload bytes that differ from the manifest digest and size", async () => {
    const r = registry("", true);
    await expect(
      r.resolver.resolveArtifactBundle({
        imageRepository: "ghcr.io/example/node",
        sourceSha: SHA_1,
      })
    ).rejects.toMatchObject({ invalid: true });
  });
});

describe("accepted manifest transport", () => {
  it.each([
    200, 401, 403, 404, 503, 307, 999,
  ])("checks digest without tag replacement, registry status %s", async (status) => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const resolver = new GhcrBuiltImageResolver(async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/token?"))
        return new Response(JSON.stringify({ token: "scoped-pull" }));
      return new Response(null, {
        status: status === 999 ? 200 : status,
        headers: {
          "docker-content-digest":
            status === 999
              ? `sha256:${"f".repeat(64)}`
              : requiredFixture(HELPER_IMAGE.split("@")[1]),
          location: "https://attacker.invalid/manifest",
        },
      });
    });
    if ([503, 307, 999].includes(status))
      await expect(
        resolver.checkImageManifests([HELPER_IMAGE])
      ).rejects.toBeInstanceOf(BuiltImageRegistryError);
    else
      expect(await resolver.checkImageManifests([HELPER_IMAGE])).toBe(
        status === 200
      );
    expect(calls.map((c) => c.url)).toEqual([
      "https://ghcr.io/token?service=ghcr.io&scope=repository%3Aexample%2Fnode-helper%3Apull",
      `https://ghcr.io/v2/example/node-helper/manifests/${HELPER_IMAGE.split("@")[1]}`,
    ]);
    expect(calls[1]?.init).toMatchObject({
      method: "HEAD",
      redirect: "manual",
      headers: { authorization: "Bearer scoped-pull" },
    });
  });
  it("checks all selected images and never forwards a GHCR bearer to an upstream registry", async () => {
    const upstream = `registry.example/upstream@sha256:${"e".repeat(64)}`;
    const heads: string[] = [];
    const resolver = new GhcrBuiltImageResolver(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/token")
        return new Response(JSON.stringify({ token: "ghcr-only" }));
      heads.push(url.href);
      const image = url.hostname === "ghcr.io" ? PUBLIC_IMAGE : upstream;
      expect(new Headers(init?.headers).get("authorization")).toBe(
        url.hostname === "ghcr.io" ? "Bearer ghcr-only" : null
      );
      return new Response(null, {
        headers: {
          "docker-content-digest": requiredFixture(image.split("@")[1]),
        },
      });
    });
    expect(await resolver.checkImageManifests([PUBLIC_IMAGE, upstream])).toBe(
      true
    );
    expect(heads).toHaveLength(2);
  });
  it("checks a declared Docker Hub tag+digest by digest with only its own anonymous token", async () => {
    const digest = `sha256:${"e".repeat(64)}`;
    const calls: string[] = [];
    const resolver = new GhcrBuiltImageResolver(async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith("https://auth.docker.io/token?")) {
        expect(new Headers(init?.headers).get("authorization")).toBeNull();
        return new Response(JSON.stringify({ token: "docker-only" }));
      }
      expect(url).toBe(
        `https://registry-1.docker.io/v2/library/postgres/manifests/${digest}`
      );
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer docker-only"
      );
      return new Response(null, {
        headers: { "docker-content-digest": digest },
      });
    });
    expect(await resolver.checkImageManifests([`postgres:16@${digest}`])).toBe(
      true
    );
    expect(calls).toHaveLength(2);
  });

  it("bounds stalled manifest IO by the shared operation deadline", async () => {
    const resolver = new GhcrBuiltImageResolver(
      async (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("timeout")),
            { once: true }
          );
        }),
      5
    );
    await expect(
      resolver.checkImageManifests([HELPER_IMAGE])
    ).rejects.toMatchObject({ invalid: false });
  });
});
