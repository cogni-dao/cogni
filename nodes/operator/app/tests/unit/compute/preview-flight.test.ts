// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/compute/preview-flight`
 * Purpose: Verify the opt-in preview flight orchestrates existing lifecycle seams safely.
 * Scope: In-memory port behavior; does not prove PostgreSQL atomicity or create paid leases.
 * Invariants: Cancel fences publication; cleanup and durable expiry precede admission release.
 * Side-effects: none
 * Links: features/compute/preview-flight.ts, component/db/akash-preview-admission.int.test.ts
 * @internal
 */
import { describe, expect, it, vi } from "vitest";
import {
  createPreviewFlight,
  parsePreviewReadyGenerations,
} from "@/bootstrap/capabilities/preview-flight";
import {
  PreviewFlight,
  previewDeploymentId,
} from "@/features/compute/preview-flight";
import type {
  AkashPreviewAdmission,
  AkashPreviewAdmissionInput,
  AkashPreviewAdmissionPort,
} from "@/ports/akash-preview-admission.port";
import { AkashPreviewAdmissionError } from "@/ports/akash-preview-admission.port";
import type { AkashTxAllocationRecord } from "@/ports/akash-tx.port";

import type { ServerEnv } from "@/shared/env/server-env";

const NODE = "55616668-2668-4be8-a020-11d24fd61561",
  SHA = "b".repeat(40),
  GEN = "2616bc5c-5c0f-4cbf-ae01-82c376897448";
const image = `ghcr.io/cogni-test-org/spawny-boi@sha256:${"c".repeat(64)}`;
const bundleRef = `ghcr.io/cogni-test-org/spawny-boi@sha256:${"d".repeat(64)}`;
const repoSpecText = `node_id: ${NODE}\ngovernance: {}\ndeployment:\n  services:\n    - name: app\n      artifact: { name: app }\n      port: 3200\n      visibility: public\n      runtime_profile: cogni-node-app-v1\n      resources: { cpu_units: 2, memory_mi: 2048, storage_mi: 4096 }\n`;
const payload = {
  schema_version: 1,
  node_id: NODE,
  source: { repository: "cogni-test-org/spawny-boi", sha: SHA },
  artifacts: [{ name: "app", image }],
  services: [{ name: "app", artifact: "app" }],
};
const request = {
  nodeId: NODE,
  slug: "spawny-boi",
  sourceSha: SHA,
  requestKey: "dev-build-one",
  ttlSeconds: 60,
};
const NOW = new Date("2026-10-20T12:00:00Z");
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function build() {
  const rows = new Map<string, AkashPreviewAdmission>();
  let receipts: AkashTxAllocationRecord[] = [];
  let now = NOW;
  let cleanup = true;
  const used = new Set<string>();
  let lock = Promise.resolve();
  const exclusive = async <T>(action: () => Promise<T>) => {
    const previous = lock;
    let unlock!: () => void;
    lock = new Promise((r) => {
      unlock = r;
    });
    await previous;
    try {
      return await action();
    } finally {
      unlock();
    }
  };
  const active = (id: string) => {
    const row = rows.get(id);
    if (!row) throw new AkashPreviewAdmissionError("missing");
    if (row.revokedAt || row.closureObservedAt || row.expiresAt <= now)
      throw new AkashPreviewAdmissionError("terminal");
    return row;
  };
  const save = async (input: AkashPreviewAdmissionInput, cancel = false) => {
    const existing = rows.get(input.deploymentId);
    if (existing) {
      if (
        (!cancel && existing.payloadHash !== input.payloadHash) ||
        existing.sourceSha !== input.sourceSha
      )
        throw new AkashPreviewAdmissionError("conflict");
      if (cancel) {
        const row = { ...existing, revokedAt: now };
        rows.set(row.deploymentId, row);
        return row;
      }
      return existing;
    }
    const row: AkashPreviewAdmission = {
      ...input,
      stateSlot: 0,
      ...(cancel ? { revokedAt: now, closureObservedAt: now } : {}),
    };
    rows.set(row.deploymentId, row);
    return row;
  };
  const admission: AkashPreviewAdmissionPort = {
    admit: (input) => exclusive(() => save(input)),
    cancel: (input) => exclusive(() => save(input, true)),
    read: async (id) => rows.get(id) ?? null,
    listDue: async () =>
      [...rows.values()].filter(
        (r) => !r.closureObservedAt && (r.revokedAt || r.expiresAt <= now)
      ),
    revoke: (id) =>
      exclusive(async () => {
        const row = rows.get(id);
        if (!row) throw new AkashPreviewAdmissionError("missing");
        const revoked = { ...row, revokedAt: now };
        rows.set(id, revoked);
        return revoked;
      }),
    withUnallocatedStateReservation: (id, slot, action) =>
      exclusive(async () => {
        const row = active(id);
        if (row.stateSlot !== slot) throw new Error("slot mismatch");
        const result = await action();
        if (used.has(result.resetGeneration))
          throw new AkashPreviewAdmissionError("conflict");
        used.add(result.resetGeneration);
        rows.set(id, { ...row, resetGeneration: result.resetGeneration });
        return result;
      }),
    withActiveState: (input, action) =>
      exclusive(async () => {
        active(input.deploymentId);
        return action();
      }),
    bindResolvedSpec: async () => {},
    assertActive: async (input) => {
      active(input.deploymentId);
    },
    beforeProviderTransaction: async () => {},
    finishDispatch: async () => {},
    receipts: async () => receipts,
    finishRetirement: async (input) => {
      const row = rows.get(input.deploymentId);
      if (!row) throw new Error("missing");
      const closed = { ...row, closureObservedAt: now };
      rows.set(row.deploymentId, closed);
      return closed;
    },
  };
  const git = {
    publish: vi.fn(
      async (_input: {
        deploymentId: string;
        files: readonly { path: string; content: string }[];
      }) => {}
    ),
    remove: vi.fn(async (_id: string) => {}),
    absent: vi.fn(async () => true),
  };
  const registerExpiry = vi.fn(async () => {}),
    prepare = vi.fn(async () => ({ resetGeneration: GEN }));
  const service = new PreviewFlight({
    admission,
    sources: {
      read: async () => ({
        repoSpecText,
        catalogText: "name: spawny-boi\n",
        sourceRepo: "https://github.com/cogni-test-org/spawny-boi",
        imageRepository: "ghcr.io/cogni-test-org/spawny-boi",
      }),
    },
    bundles: { read: async () => ({ bundleRef, payload }) },
    git,
    state: { prepare },
    cleanup: { absent: async () => cleanup },
    registerExpiry,
    serving: async () => false,
    dnsZoneId: "f".repeat(32),
    substrateHost: "test.cogni-testing.org",
    now: () => now,
  });
  return {
    service,
    rows,
    git,
    registerExpiry,
    prepare,
    setCleanup: (value: boolean) => {
      cleanup = value;
    },
    setNow: (value: Date) => {
      now = value;
    },
    setReceipts: (value: AkashTxAllocationRecord[]) => {
      receipts = value;
    },
  };
}
describe("trusted TEST preview flight", () => {
  it("publishes existing typed XR and reusable pair resources with stable identity", async () => {
    const ctx = build();
    const first = await ctx.service.request(request),
      second = await ctx.service.request(request);
    expect(second).toEqual(first);
    expect(first.deploymentId).toBe(
      previewDeploymentId(NODE, request.requestKey)
    );
    expect(ctx.prepare).toHaveBeenCalledTimes(1);
    const files = ctx.git.publish.mock.calls[0]?.[0].files ?? [];
    expect(
      files.find((f) => f.path.endsWith("xcomputeworkload.yaml"))?.content
    ).toContain(`previewDeploymentId: ${first.deploymentId}`);
    expect(
      files.some((f) =>
        f.path.includes("state-0/compute-migration-external-secret")
      )
    ).toBe(true);
    expect(files.map((f) => f.content).join("\n")).toContain("app: 1");
    expect(ctx.registerExpiry).toHaveBeenCalledBefore(ctx.git.publish);
  });
  it("cancels before admission and never publishes a later start of that request", async () => {
    const ctx = build();
    expect(await ctx.service.cancelRequest(request)).toMatchObject({
      state: "closed",
    });
    expect(await ctx.service.request(request)).toMatchObject({
      state: "closed",
    });
    expect(ctx.git.publish).not.toHaveBeenCalled();
    await expect(
      ctx.service.request({ ...request, sourceSha: "e".repeat(40) })
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      ctx.service.request({ ...request, ttlSeconds: 120 })
    ).rejects.toMatchObject({ reason: "conflict" });
  });
  it("requires durable expiry registration before any desired-state publication", async () => {
    const ctx = build();
    ctx.registerExpiry.mockRejectedValueOnce(new Error("temporal unavailable"));
    await expect(ctx.service.request(request)).rejects.toThrow(
      "temporal unavailable"
    );
    expect(ctx.rows.size).toBe(0);
    expect(ctx.git.publish).not.toHaveBeenCalled();
  });
  it("holds capacity through per-admission cleanup and keeps shared pool projections", async () => {
    const ctx = build();
    const result = await ctx.service.request(request);
    ctx.setCleanup(false);
    expect(
      await ctx.service.release({
        nodeId: NODE,
        deploymentId: result.deploymentId,
      })
    ).toMatchObject({ state: "retiring" });
    expect(
      ctx.rows.get(result.deploymentId)?.closureObservedAt
    ).toBeUndefined();
    expect(ctx.git.remove).toHaveBeenCalledWith(result.deploymentId);
    ctx.setCleanup(true);
    await ctx.service.sweep();
    expect(
      await ctx.service.status({
        nodeId: NODE,
        deploymentId: result.deploymentId,
      })
    ).toMatchObject({ state: "closed" });
  });
  it("holds a submitted no-handle unknown after all Git/Kubernetes resources disappear", async () => {
    const ctx = build();
    const result = await ctx.service.request(request);
    ctx.setReceipts([
      {
        receiptId: "r",
        cogniKey: "base",
        identity: { nodeId: NODE, compositeUid: "xr", compositeGeneration: 1 },
        environment: "candidate-a",
        workload: "spawny-boi",
        state: "preparing",
        previewDeploymentId: result.deploymentId,
        previewSubmittedAt: NOW,
      },
    ]);
    await ctx.service.release({
      nodeId: NODE,
      deploymentId: result.deploymentId,
    });
    expect(
      ctx.rows.get(result.deploymentId)?.closureObservedAt
    ).toBeUndefined();
  });
  it("expiry survives a service pass and retires only the expired admission", async () => {
    const ctx = build();
    const result = await ctx.service.request(request);
    ctx.setNow(new Date(NOW.getTime() + 61_000));
    await ctx.service.sweep();
    expect(
      await ctx.service.status({
        nodeId: NODE,
        deploymentId: result.deploymentId,
      })
    ).toMatchObject({ state: "closed" });
    expect(ctx.git.remove).toHaveBeenCalledWith(result.deploymentId);
  });
  it("serializes publication before cancellation and cannot republish its tombstone", async () => {
    const ctx = build(),
      entered = deferred(),
      release = deferred();
    const events: string[] = [];
    ctx.git.publish.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      events.push("published");
    });
    ctx.git.remove.mockImplementation(async () => {
      events.push("removed");
    });
    const starting = ctx.service.request(request);
    await entered.promise;
    const canceling = ctx.service.cancelRequest(request);
    release.resolve();
    await Promise.all([starting, canceling]);
    expect(events).toEqual(["published", "removed"]);
    await ctx.service.request(request);
    expect(ctx.git.publish).toHaveBeenCalledTimes(1);
  });
  it("durably cancels a concurrent absent short-TTL start using its original request", async () => {
    const ctx = build();
    const outcomes = await Promise.allSettled([
      ctx.service.request(request),
      ctx.service.cancelRequest(request),
    ]);
    expect(outcomes[1]?.status).toBe("fulfilled");
    expect(
      ctx.rows.get(previewDeploymentId(NODE, request.requestKey))?.revokedAt
    ).toBeDefined();
    expect(await ctx.service.request(request)).toMatchObject({
      state: "closed",
    });
  });
  it("default-TTL cancellation racing a short-TTL start keeps terminal intent", async () => {
    const ctx = build();
    const { ttlSeconds: _ttl, ...defaultCancel } = request;
    const outcomes = await Promise.allSettled([
      ctx.service.request(request),
      ctx.service.cancelRequest(defaultCancel),
    ]);
    expect(outcomes[1]?.status).toBe("fulfilled");
    expect(
      ctx.rows.get(previewDeploymentId(NODE, request.requestKey))?.revokedAt
    ).toBeDefined();
  });
  it("does not let another node inspect or retire an admission", async () => {
    const ctx = build();
    const result = await ctx.service.request(request);
    await expect(
      ctx.service.release({
        nodeId: "other",
        deploymentId: result.deploymentId,
      })
    ).rejects.toMatchObject({ code: "not_found" });
    expect(ctx.git.remove).not.toHaveBeenCalled();
  });
  it("keeps admission disabled by default and refuses missing preparation metadata", () => {
    expect(() => createPreviewFlight({} as ServerEnv)).toThrow(
      "build previews are not enabled"
    );
    expect(() =>
      createPreviewFlight({
        PREVIEW_FLIGHTS_ENABLED: "true",
        NODE_SUBMODULE_PARENT_OWNER: "cogni-test-org",
        NODE_SUBMODULE_PARENT_REPO: "test-parent",
        AKASH_ACTUATOR_ACCOUNT_ID: `akash1${"a".repeat(38)}`,
        PREVIEW_DNS_ZONE_ID: "f".repeat(32),
        PREVIEW_SUBSTRATE_HOST: "test.cogni-testing.org",
      } as ServerEnv)
    ).toThrow("preparation metadata is missing");
  });
  it("refuses absent/duplicate prepared generation metadata", () => {
    expect(() => parsePreviewReadyGenerations(undefined)).toThrow();
    expect(() =>
      parsePreviewReadyGenerations(JSON.stringify({ 0: GEN, 1: GEN }))
    ).toThrow();
  });
});
