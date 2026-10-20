// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/node-app-scaffold/node-artifact-bundle-oci.data`
 * Purpose: Share the trusted node CI artifact validation between CLI and hosted reader.
 * Scope: Pure OCI bundle configuration validation; does not fetch or publish artifacts.
 * Invariants: One named bundle payload layer; digest-pinned artifact references.
 * Side-effects: none
 * Links: features/compute/node-artifact-bundle-oci.ts
 * @internal
 */

import { z } from "zod";

export const NODE_BUNDLE_ARTIFACT_TYPE =
  "application/vnd.cogni.node-artifact-bundle.v1";
export const NODE_BUNDLE_PAYLOAD_MEDIA_TYPE =
  "application/vnd.cogni.node-artifact-bundle.v1+json";
export const NODE_BUNDLE_PAYLOAD_FILE = "node-artifact-bundle.json";

const sourceShaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const bundleRepositorySchema = z
  .string()
  .regex(/^ghcr\.io\/[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/);
const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const bundleManifestSchema = z
  .object({
    artifactType: z.literal(NODE_BUNDLE_ARTIFACT_TYPE),
    layers: z
      .array(
        z
          .object({
            mediaType: z.literal(NODE_BUNDLE_PAYLOAD_MEDIA_TYPE),
            annotations: z
              .object({
                "org.opencontainers.image.title": z.literal(
                  NODE_BUNDLE_PAYLOAD_FILE
                ),
              })
              .passthrough(),
          })
          .passthrough()
      )
      .length(1),
  })
  .passthrough();

export function buildNodeBundleTagRef(input: {
  readonly repository: string;
  readonly sourceSha: string;
}): string {
  const repository = bundleRepositorySchema.parse(input.repository);
  const sourceSha = sourceShaSchema.parse(input.sourceSha);
  return `${repository}:bundle-sha-${sourceSha}`;
}

export function verifyNodeBundleManifest(input: {
  readonly repository: string;
  readonly digest: string;
  readonly manifest: unknown;
}): { readonly digestRef: string } {
  const repository = bundleRepositorySchema.parse(input.repository);
  const digest = digestSchema.parse(input.digest);
  bundleManifestSchema.parse(input.manifest);
  return { digestRef: `${repository}@${digest}` };
}
