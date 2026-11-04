// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/oci/ghcr-built-image.adapter`
 * Purpose: Resolve `ghcr.io/<owner>/<image>:sha-<sourceSha>` to its manifest digest through the
 *   anonymous OCI distribution API (story.5127): `GET /token?scope=repository:<path>:pull`, then
 *   `HEAD /v2/<path>/manifests/sha-<sha>` and read `Docker-Content-Digest`.
 * Scope: Read-only and unauthenticated; no credential is held. A private image reads as absent.
 * Invariants:
 *   - DIGEST_PINNED: returns `<imageRepository>@sha256:<64 hex>`, never a tag.
 *   - NOT_FOUND_IS_NULL: 404 (and 401/403, an image not publicly readable) is `null`.
 *   - BOUNDED: every request has a timeout; a transport error, a 5xx or a malformed digest throws
 *     `BuiltImageRegistryError`.
 * Side-effects: IO (HTTPS to ghcr.io)
 * Links: ports/built-image.port.ts
 * @internal
 */

import { createHash } from "node:crypto";
import {
  buildNodeBundleTagRef,
  verifyNodeBundleManifest,
} from "@cogni/repo-spec";

import { BuiltImageRegistryError, type BuiltImageResolverPort } from "@/ports";

const GHCR_HOST = "ghcr.io";
const IMAGE_REPOSITORY_RE =
  /^ghcr\.io\/([a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*)$/;
const SOURCE_SHA_RE = /^[0-9a-f]{40}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

const isAbsent = (status: number): boolean =>
  status === 401 || status === 403 || status === 404;

export class GhcrBuiltImageResolver implements BuiltImageResolverPort {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 10_000
  ) {}

  async resolveBuiltImage(input: {
    readonly imageRepository: string;
    readonly sourceSha: string;
  }): Promise<string | null> {
    const path = IMAGE_REPOSITORY_RE.exec(input.imageRepository)?.[1];
    if (!path || !SOURCE_SHA_RE.test(input.sourceSha))
      throw new BuiltImageRegistryError("invalid image repository or sha");

    const scope = encodeURIComponent(`repository:${path}:pull`);
    const tokenRes = await this.request(
      `https://${GHCR_HOST}/token?service=${GHCR_HOST}&scope=${scope}`,
      "GET"
    );
    if (isAbsent(tokenRes.status)) return null;
    if (!tokenRes.ok)
      throw new BuiltImageRegistryError(`ghcr token ${tokenRes.status}`);
    const body = (await tokenRes.json().catch(() => null)) as {
      token?: unknown;
    } | null;
    const token = body?.token;
    if (typeof token !== "string" || token.length === 0)
      throw new BuiltImageRegistryError("ghcr token response had no token");

    const manifestRes = await this.request(
      `https://${GHCR_HOST}/v2/${path}/manifests/sha-${input.sourceSha}`,
      "HEAD",
      { authorization: `Bearer ${token}`, accept: MANIFEST_ACCEPT }
    );
    if (isAbsent(manifestRes.status)) return null;
    if (!manifestRes.ok)
      throw new BuiltImageRegistryError(`ghcr manifest ${manifestRes.status}`);
    const digest = manifestRes.headers.get("docker-content-digest");
    if (!digest || !DIGEST_RE.test(digest))
      throw new BuiltImageRegistryError("ghcr manifest had no valid digest");
    return `${input.imageRepository}@${digest}`;
  }

  async resolveArtifactBundle(input: {
    readonly imageRepository: string;
    readonly sourceSha: string;
    readonly acceptedDigest?: string;
  }): Promise<{ digestRef: string; bundle: unknown } | null> {
    const path = IMAGE_REPOSITORY_RE.exec(input.imageRepository)?.[1];
    if (!path || !SOURCE_SHA_RE.test(input.sourceSha))
      throw new BuiltImageRegistryError(
        "invalid bundle repository or source",
        true
      );
    if (
      input.acceptedDigest &&
      (input.acceptedDigest.split("@")[0] !== input.imageRepository ||
        !DIGEST_RE.test(input.acceptedDigest.split("@")[1] ?? ""))
    )
      throw new BuiltImageRegistryError(
        "accepted bundle repository mismatch",
        true
      );
    const { request, bounded } = this.transport();
    const tr = await request(
      `https://${GHCR_HOST}/token?service=${GHCR_HOST}&scope=${encodeURIComponent(`repository:${path}:pull`)}`
    );
    if (isAbsent(tr.status)) return null;
    if (!tr.ok) throw new BuiltImageRegistryError("bundle token unavailable");
    let token: unknown;
    try {
      token = JSON.parse((await bounded(tr, 16384)).toString()).token;
    } catch {
      throw new BuiltImageRegistryError("bundle token invalid");
    }
    if (typeof token !== "string" || !token.length)
      throw new BuiltImageRegistryError("bundle token missing");
    const headers = {
      authorization: `Bearer ${token}`,
      accept: MANIFEST_ACCEPT,
    };
    const ref =
      input.acceptedDigest?.split("@")[1] ??
      buildNodeBundleTagRef({
        repository: input.imageRepository,
        sourceSha: input.sourceSha,
      })
        .split(":")
        .at(-1);
    const mr = await request(
      `https://${GHCR_HOST}/v2/${path}/manifests/${ref}`,
      headers
    );
    if (isAbsent(mr.status)) return null;
    if (!mr.ok)
      throw new BuiltImageRegistryError("bundle manifest unavailable");
    const bytes = await bounded(mr, 65536);
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    try {
      if (
        digest !== mr.headers.get("docker-content-digest") ||
        (input.acceptedDigest &&
          `${input.imageRepository}@${digest}` !== input.acceptedDigest)
      )
        throw new Error("manifest digest mismatch");
      const manifest = JSON.parse(bytes.toString());
      const { digestRef } = verifyNodeBundleManifest({
        repository: input.imageRepository,
        digest,
        manifest,
      });
      const layer = manifest.layers[0] as { digest?: unknown; size?: unknown };
      if (
        typeof layer.digest !== "string" ||
        !DIGEST_RE.test(layer.digest) ||
        typeof layer.size !== "number" ||
        layer.size < 1 ||
        layer.size > 65536
      )
        throw new Error("invalid bundle layer");
      const lr = await request(
        `https://${GHCR_HOST}/v2/${path}/blobs/${layer.digest}`,
        headers,
        true
      );
      if (isAbsent(lr.status)) return null;
      if (!lr.ok)
        throw new BuiltImageRegistryError("bundle payload unavailable");
      const payload = await bounded(lr, 65536);
      if (
        payload.length !== layer.size ||
        `sha256:${createHash("sha256").update(payload).digest("hex")}` !==
          layer.digest
      )
        throw new Error("payload digest mismatch");
      return { digestRef, bundle: JSON.parse(payload.toString()) };
    } catch (e) {
      if (e instanceof BuiltImageRegistryError) throw e;
      throw new BuiltImageRegistryError("invalid OCI bundle publication", true);
    }
  }

  async checkImageManifests(images: readonly string[]): Promise<boolean> {
    if (images.length < 1 || images.length > 8)
      throw new BuiltImageRegistryError("invalid selected image count", true);
    const { request, bounded } = this.transport();
    for (const image of new Set(images)) {
      const match =
        /^([a-z0-9][a-z0-9._/-]*)(?::[A-Za-z0-9._-]+)?@(sha256:[0-9a-f]{64})$/.exec(
          image
        );
      if (!match?.[1] || !match[2])
        throw new BuiltImageRegistryError(
          "invalid selected image digest",
          true
        );
      const repository = match[1];
      const digest = match[2];
      const parts = repository.split("/");
      const qualified = parts.length > 1 && parts[0]?.includes(".");
      const registry = qualified ? parts.shift() : "docker.io";
      const path =
        !qualified && parts.length === 1
          ? `library/${parts[0]}`
          : parts.join("/");
      const headers: Record<string, string> = { accept: MANIFEST_ACCEPT };
      // Only these fixed anonymous token issuers are trusted. Ignore arbitrary
      // WWW-Authenticate destinations. Each bearer stays on its own registry.
      const scope = encodeURIComponent(`repository:${path}:pull`);
      const tokenUrl =
        registry === GHCR_HOST
          ? `https://${GHCR_HOST}/token?service=${GHCR_HOST}&scope=${scope}`
          : registry === "docker.io" || registry === "registry-1.docker.io"
            ? `https://auth.docker.io/token?service=registry.docker.io&scope=${scope}`
            : undefined;
      if (tokenUrl) {
        const tr = await request(tokenUrl);
        if (isAbsent(tr.status)) return false;
        if (!tr.ok)
          throw new BuiltImageRegistryError("image token unavailable");
        let token: unknown;
        try {
          token = JSON.parse((await bounded(tr, 16384)).toString()).token;
        } catch {
          throw new BuiltImageRegistryError("image token invalid");
        }
        if (typeof token !== "string" || !token.length)
          throw new BuiltImageRegistryError("image token missing");
        headers.authorization = `Bearer ${token}`;
      }
      // Explicit upstream digests keep their repository/tag syntax; the request
      // uses only the digest. Other registries are anonymous and never redirected.
      const host = registry === "docker.io" ? "registry-1.docker.io" : registry;
      const mr = await request(
        `https://${host}/v2/${path}/manifests/${digest}`,
        headers,
        false,
        "HEAD"
      );
      if (isAbsent(mr.status)) return false;
      if (!mr.ok)
        throw new BuiltImageRegistryError("selected image unavailable");
      if (mr.headers.get("docker-content-digest") !== digest)
        throw new BuiltImageRegistryError(
          "selected image digest mismatch",
          true
        );
    }
    return true;
  }

  /** One deadline and the same bounded, redirect-fenced transport for each registry operation. */
  private transport() {
    const signal = AbortSignal.timeout(this.timeoutMs);
    const request = async (
      url: string,
      headers: Record<string, string> = {},
      blob = false,
      method: "GET" | "HEAD" = "GET"
    ) => {
      try {
        let response = await this.fetchImpl(url, {
          headers,
          method,
          signal,
          redirect: "manual",
        });
        if (response.status >= 300 && response.status < 400) {
          const location = new URL(response.headers.get("location") ?? "", url);
          // GHCR's documented package storage is the only permitted blob redirect. Never forward bearer auth.
          // https://docs.github.com/en/actions/reference/runners/github-hosted-runners#communication-requirements-for-github-hosted-runners
          if (
            !blob ||
            location.protocol !== "https:" ||
            location.hostname !== "pkg-containers.githubusercontent.com" ||
            location.port ||
            location.username ||
            location.password
          )
            throw new BuiltImageRegistryError(
              "registry redirect refused",
              true
            );
          await response.body?.cancel();
          response = await this.fetchImpl(location, {
            signal,
            redirect: "error",
          });
        }
        return response;
      } catch (e) {
        if (e instanceof BuiltImageRegistryError) throw e;
        throw new BuiltImageRegistryError("bundle registry unavailable");
      }
    };
    const bounded = async (res: Response, max: number) => {
      if (Number(res.headers.get("content-length")) > max)
        throw new BuiltImageRegistryError("bundle exceeds byte limit", true);
      const reader = res.body?.getReader();
      if (!reader)
        throw new BuiltImageRegistryError("bundle has no body", true);
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > max) {
            await reader.cancel();
            throw new BuiltImageRegistryError(
              "bundle exceeds byte limit",
              true
            );
          }
          chunks.push(value);
        }
      } catch (e) {
        if (e instanceof BuiltImageRegistryError) throw e;
        throw new BuiltImageRegistryError("bundle body unavailable");
      }
      return Buffer.concat(chunks);
    };
    return { request, bounded };
  }

  private async request(
    url: string,
    method: "GET" | "HEAD",
    headers: Record<string, string> = {}
  ): Promise<Response> {
    try {
      return await this.fetchImpl(url, {
        method,
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new BuiltImageRegistryError(
        error instanceof Error
          ? error.message.slice(0, 200)
          : "ghcr unreachable"
      );
    }
  }
}
