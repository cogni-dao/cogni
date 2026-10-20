// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/compute/ghcr-node-bundle-reader.adapter`
 * Purpose: Read the public TEST node's immutable OCI bundle without workflow dispatch.
 * Scope: Bounded anonymous GHCR reads; does not publish artifacts or read runtime secrets.
 * Invariants: Manifest and payload hashes are verified before any artifact is returned.
 * Side-effects: IO (anonymous registry GETs)
 * Links: ports/preview-flight.port.ts, features/compute/node-artifact-bundle-oci.ts
 * @internal
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { NodeBundleReaderPort } from "@/ports";
import {
  buildNodeBundleTagRef,
  verifyNodeBundleManifest,
} from "@/shared/node-app-scaffold/node-artifact-bundle-oci.data";

const manifestSchema = z
  .object({
    artifactType: z.literal("application/vnd.cogni.node-artifact-bundle.v1"),
    layers: z
      .array(
        z
          .object({
            digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
            size: z.number().int().min(1).max(1_048_576),
            mediaType: z.literal(
              "application/vnd.cogni.node-artifact-bundle.v1+json"
            ),
            annotations: z
              .object({
                "org.opencontainers.image.title": z.literal(
                  "node-artifact-bundle.json"
                ),
              })
              .passthrough(),
          })
          .passthrough()
      )
      .length(1),
  })
  .passthrough();
const digest = (data: Uint8Array) =>
  `sha256:${createHash("sha256").update(data).digest("hex")}`;

/** Anonymous-only trusted test pilot. Private registries fail closed. */
export class GhcrNodeBundleReader implements NodeBundleReaderPort {
  constructor(private readonly fetchFn: typeof fetch = fetch) {}
  async read(input: { repository: string; sourceSha: string }) {
    if (
      input.repository !== "ghcr.io/cogni-test-org/spawny-boi" ||
      !/^[0-9a-f]{40}$/.test(input.sourceSha)
    )
      throw new Error("preview_bundle_not_allowlisted");
    const repository = input.repository.slice("ghcr.io/".length);
    const tokenResponse = await this.fetchFn(
      `https://ghcr.io/token?service=ghcr.io&scope=${encodeURIComponent(`repository:${repository}:pull`)}`,
      { redirect: "error", signal: AbortSignal.timeout(15_000) }
    );
    if (!tokenResponse.ok)
      throw new Error("preview_bundle_registry_auth_unavailable");
    const { token } = z
      .object({ token: z.string().min(1) })
      .parse(await tokenResponse.json());
    const get = async (path: string, maxBytes: number) => {
      let response = await this.fetchFn(
        `https://ghcr.io/v2/${repository}/${path}`,
        {
          headers: {
            authorization: `Bearer ${token}`,
            accept:
              "application/vnd.oci.image.manifest.v1+json, application/vnd.oci.artifact.manifest.v1+json",
          },
          redirect: path.startsWith("blobs/") ? "manual" : "error",
          signal: AbortSignal.timeout(15_000),
        }
      );
      if (
        path.startsWith("blobs/") &&
        [302, 307, 308].includes(response.status)
      ) {
        const target = new URL(response.headers.get("location") ?? "");
        if (
          target.protocol !== "https:" ||
          target.hostname !== "pkg-containers.githubusercontent.com" ||
          target.port ||
          target.username ||
          target.password
        )
          throw new Error("preview_bundle_blob_redirect_refused");
        // GitHub blob storage uses signed URLs. Never forward the registry bearer or log URL.
        response = await this.fetchFn(target, {
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        });
      }
      if (!response.ok)
        throw new Error("preview_bundle_registry_read_unavailable");
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (declared > maxBytes) throw new Error("preview_bundle_too_large");
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (!response.body) throw new Error("preview_bundle_body_missing");
      const reader = response.body.getReader();
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > maxBytes) throw new Error("preview_bundle_too_large");
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel();
      }
      const bytes = Buffer.concat(chunks);
      const advertised = response.headers.get("docker-content-digest");
      if (advertised && advertised !== digest(bytes))
        throw new Error("preview_bundle_digest_mismatch");
      return bytes;
    };
    const manifestBytes = await get(
      `manifests/${buildNodeBundleTagRef(input).split(":").at(-1)}`,
      65_536
    );
    const manifest = manifestSchema.parse(
      JSON.parse(manifestBytes.toString("utf8"))
    );
    const { digestRef } = verifyNodeBundleManifest({
      repository: input.repository,
      digest: digest(manifestBytes),
      manifest,
    });
    const layer = manifest.layers[0];
    if (!layer) throw new Error("preview_bundle_layer_missing");
    const payload = await get(`blobs/${layer.digest}`, 1_048_576);
    if (payload.byteLength !== layer.size || digest(payload) !== layer.digest)
      throw new Error("preview_bundle_payload_digest_mismatch");
    return {
      bundleRef: digestRef,
      payload: JSON.parse(payload.toString("utf8")) as unknown,
    };
  }
}
