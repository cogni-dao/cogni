// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/compute/preview-cleanup-observer`
 * Purpose: Verify the precise absence evidence required before a disposable pair can be reused.
 * Scope: Mocked Kubernetes read API only; does not mutate a cluster or infer provider closure.
 * Invariants: Explicit known-XR 404; owned generation scope; malformed/truncated evidence denies reuse.
 * Side-effects: none
 * Links: adapters/server/compute/preview-cleanup-observer.adapter.ts
 * @internal
 */
import type {
  BatchV1Api,
  CoreV1Api,
  CustomObjectsApi,
} from "@kubernetes/client-node";
import { describe, expect, it, vi } from "vitest";
import { migrationJobName } from "@/adapters/server/compute/kubernetes-migration-job.adapter";
import { KubernetesPreviewCleanupObserver } from "@/adapters/server/compute/preview-cleanup-observer.adapter";

const input = {
  deploymentId: "55616668-2668-4be8-a020-11d24fd61561",
  nodeId: "2f8b7a10-4c6e-4a7b-9d31-1c2e3f4a5b60",
  bundleRef: `ghcr.io/cogni-test-org/spawny-boi@sha256:${"a".repeat(64)}`,
  resetGeneration: "2616bc5c-5c0f-4cbf-ae01-82c376897448",
};
function build() {
  const custom = {
    getNamespacedCustomObject: vi.fn(async () => {
      throw Object.assign(new Error("not found"), { statusCode: 404 });
    }),
    listNamespacedCustomObject: vi.fn(async () => ({
      body: { items: [], metadata: {} } as unknown,
    })),
  };
  const batch = {
      listNamespacedJob: vi.fn(async () => ({
        body: { items: [], metadata: {} } as unknown,
      })),
    },
    pods = {
      listNamespacedPod: vi.fn(async () => ({
        body: { items: [], metadata: {} } as unknown,
      })),
    };
  const reader = new KubernetesPreviewCleanupObserver(
    custom as unknown as CustomObjectsApi,
    batch as unknown as BatchV1Api,
    pods as unknown as CoreV1Api,
    () => "known-preview-xr"
  );
  return { reader, custom, batch, pods };
}
describe("preview cleanup evidence", () => {
  it("requires explicit404 of known XR even if its preview label is missing", async () => {
    const ctx = build();
    ctx.custom.getNamespacedCustomObject.mockImplementationOnce(
      async () =>
        ({ body: { metadata: { name: "known-preview-xr" } } }) as never
    );
    expect(await ctx.reader.absent(input)).toBe(false);
    expect(ctx.custom.getNamespacedCustomObject).toHaveBeenCalledWith(
      "compute.cogni.io",
      "v1alpha1",
      "cogni-candidate-a",
      "xcomputeworkloads",
      "known-preview-xr"
    );
  });
  it("accepts explicit404 plus empty owned requests and exact generation Job/Pods", async () => {
    const ctx = build();
    expect(await ctx.reader.absent(input)).toBe(true);
    expect(ctx.custom.listNamespacedCustomObject.mock.calls[0]?.at(-1)).toBe(
      "crossplane.io/composite=known-preview-xr"
    );
    const job = migrationJobName(
      "spawny-boi",
      `sha256:${"a".repeat(64)}`,
      input.resetGeneration
    );
    expect(ctx.batch.listNamespacedJob).toHaveBeenCalledWith(
      "cogni-candidate-a",
      undefined,
      undefined,
      undefined,
      `metadata.name=${job}`
    );
    expect(ctx.pods.listNamespacedPod).toHaveBeenCalledWith(
      "cogni-candidate-a",
      undefined,
      undefined,
      undefined,
      undefined,
      `job-name=${job}`
    );
  });
  it("does not accept unavailable or forbidden XR evidence", async () => {
    const ctx = build();
    ctx.custom.getNamespacedCustomObject.mockRejectedValueOnce({
      statusCode: 403,
    });
    expect(await ctx.reader.absent(input)).toBe(false);
  });
  it("does not accept missing items, owned resources, or truncated custom lists", async () => {
    for (const body of [
      {},
      { items: [{}] },
      { items: [], metadata: { continue: "next" } },
    ]) {
      const ctx = build();
      ctx.custom.listNamespacedCustomObject.mockResolvedValueOnce({ body });
      expect(await ctx.reader.absent(input)).toBe(false);
    }
  });
  it("does not accept malformed or truncated Job/Pod lists", async () => {
    for (const body of [
      {},
      { items: [{}] },
      { items: [], metadata: { _continue: "next" } },
    ]) {
      const ctx = build();
      ctx.batch.listNamespacedJob.mockResolvedValueOnce({ body });
      expect(await ctx.reader.absent(input)).toBe(false);
      const next = build();
      next.pods.listNamespacedPod.mockResolvedValueOnce({ body });
      expect(await next.reader.absent(input)).toBe(false);
    }
  });
});
