// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Pure complete-bundle validation and environment selection for the existing release seal. */
import {
  type DeploymentEnvName,
  nodeWorkloadSpecSchema,
  resolveNodeArtifactBundle,
  resolveNodeArtifactBundleForEnvironment,
} from "@cogni/repo-spec";
import type { NodeWorkloadSpec, ReleaseRow } from "@/ports";

export function selectReleaseBundle(
  release: ReleaseRow,
  publication: { readonly digestRef: string; readonly bundle: unknown }
): NodeWorkloadSpec {
  const w = release.spec;
  const plan = w.artifactPlan;
  if (
    !plan ||
    !publication.digestRef.startsWith(`${plan.imageRepository}@sha256:`)
  )
    throw new Error("bundle repository mismatch");
  const complete = resolveNodeArtifactBundle(
    { node_id: release.nodeId, deployment: { services: plan.services } },
    publication.bundle,
    { repository: plan.repository, sourceSha: release.sourceSha }
  );
  const selected = resolveNodeArtifactBundleForEnvironment(
    complete,
    release.env as DeploymentEnvName
  );
  const mainName = w.serviceName ?? w.name;
  const main = selected.services.find((s) => s.service.name === mainName);
  if (!main) throw new Error("public entry missing from bundle");
  const names = new Set([mainName, ...(w.companions ?? []).map((c) => c.name)]);
  if (
    selected.services.length !== names.size ||
    selected.services.some((s) => !names.has(s.service.name))
  )
    throw new Error("selected service coverage mismatch");
  // Match the existing CI naming contract: an artifact used publicly uses the base
  // repository; other node-built artifacts use the declared artifact suffix.
  // Explicit Score digest declarations are upstream images, not node-built output.
  for (const service of selected.services) {
    const container =
      service.service.name === mainName
        ? w
        : w.companions?.find((c) => c.name === service.service.name);
    if (!container?.imagePending) continue;
    const isPublicArtifact = complete.services.some(
      (s) =>
        s.artifact === service.artifact && s.service.visibility === "public"
    );
    const repository = isPublicArtifact
      ? plan.imageRepository
      : `${plan.imageRepository}-${service.artifact}`;
    if (service.image.split("@")[0] !== repository)
      throw new Error("node-built artifact repository mismatch");
  }
  const { imagePending: _pending, ...rest } = w;
  const image = w.imagePending ? main.image : w.image;
  const companions = w.companions?.map((c) => {
    const resolved = selected.services.find((s) => s.service.name === c.name);
    if (!resolved) throw new Error("companion missing from bundle");
    const { imagePending: _pending, ...rest } = c;
    return { ...rest, image: c.imagePending ? resolved.image : c.image };
  });
  const selectedImages = Object.fromEntries([
    [mainName, image],
    ...(companions ?? []).map((c) => [c.name, c.image]),
  ]);
  return nodeWorkloadSpecSchema.parse({
    ...rest,
    image,
    ...(companions ? { companions } : {}),
    artifactPlan: {
      ...plan,
      bundleDigest: publication.digestRef,
      selectedImages,
    },
  });
}
