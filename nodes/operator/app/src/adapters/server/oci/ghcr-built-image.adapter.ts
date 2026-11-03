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
