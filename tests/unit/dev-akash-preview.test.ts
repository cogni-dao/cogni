// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/dev-akash-preview`
 * Purpose: Verify bounded DEV preview lifecycle and durable cleanup metadata.
 * Scope: Tests injected provider and clock fakes; does not create paid allocations.
 * Invariants: One create attempt; uncertain submissions retain custody until positive closure.
 * Side-effects: none
 * Links: nodes/operator/app/scripts/dev-akash-preview.lifecycle.ts
 * @internal
 */

import type { ProvisionOutput } from "@cogni/ai-tools";
import { describe, expect, it, vi } from "vitest";
import {
  closeDevPreview,
  DevPreviewConfigSchema,
  type DevPreviewDeps,
  type DevPreviewProvider,
  type DevPreviewRecord,
  newDevPreviewRecord,
  runDevPreview,
  safeFailure,
} from "../../nodes/operator/app/scripts/dev-akash-preview.lifecycle";

const config = DevPreviewConfigSchema.parse({
  requestId: "first-smoke",
  sourceSha: "a".repeat(40),
  deadlineSeconds: 30,
  pricing: { pricingDenom: "uakt", pricingAmount: 100 },
  spec: {
    name: "dev-smoke",
    services: [
      {
        name: "app",
        image: `ghcr.io/cogni-test-org/fixture@sha256:${"b".repeat(64)}`,
        cpuUnits: 0.5,
        memoryMi: 512,
        storageMi: 1024,
        env: { SECRET_TOKEN: "must-never-be-persisted" },
      },
    ],
  },
});
const output: ProvisionOutput = {
  provider: "akash",
  leaseId: "42",
  state: "active",
  endpoints: ["fixture.ingress.example.org"],
};

function fixture() {
  let clock = Date.parse("2026-10-20T00:00:00Z");
  const snapshots: DevPreviewRecord[] = [];
  const provider: DevPreviewProvider = {
    allocationCursor: vi.fn(async () => "41"),
    provisionWithAllocation: vi.fn(async (_input, allocated) => {
      await allocated(output);
      return output;
    }),
    findAllocationSince: vi.fn(async () => ({
      outcome: "adopted" as const,
      output,
    })),
    release: vi.fn(async () => {}),
    status: vi.fn(async () => ({ ...output, state: "closed" as const })),
  };
  const deps: DevPreviewDeps = {
    provider,
    save: async (record) => {
      snapshots.push(structuredClone(record));
    },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    releaseRequested: async () => false,
    emit: vi.fn(),
  };
  return {
    deps,
    provider,
    snapshots,
    record: newDevPreviewRecord(config, "dev-wallet", clock),
  };
}

describe("supervised DEV Akash preview", () => {
  it("persists identity, cursor and handle in order, then explicitly closes at deadline", async () => {
    const f = fixture();
    f.provider.allocationCursor = async () => {
      expect(f.snapshots.at(-1)).toMatchObject({
        phase: "reserved",
        sourceSha: config.sourceSha,
      });
      return "41";
    };
    f.provider.provisionWithAllocation = async (input, allocated) => {
      expect(f.snapshots.at(-1)).toMatchObject({
        cursor: "41",
        phase: "allocating",
      });
      expect(input.expectedSourceSha).toBe(config.sourceSha);
      await allocated(output);
      expect(f.snapshots.at(-1)?.externalName).toBe("42");
      return output;
    };
    await runDevPreview(config, f.record, f.deps);
    expect(f.provider.release).toHaveBeenCalledWith({ leaseId: "42" });
    expect(f.record.phase).toBe("closed");
    expect(Date.parse(f.record.closedAt ?? "")).toBe(
      Date.parse(f.record.deadlineAt)
    );
    expect(JSON.stringify(f.snapshots)).not.toContain(
      "must-never-be-persisted"
    );
    expect(JSON.stringify(f.snapshots)).not.toContain("SECRET_TOKEN");
  });

  it("releases immediately on explicit request while ready", async () => {
    const f = fixture();
    f.deps.releaseRequested = async () => f.record.phase === "ready";
    await runDevPreview(config, f.record, f.deps);
    expect(f.record.closedAt).toBe(f.record.startedAt);
    expect(f.provider.release).toHaveBeenCalledTimes(1);
  });

  it("does not confuse successful DELETE with observed closure", async () => {
    const f = fixture();
    f.record.externalName = "42";
    f.provider.status = vi
      .fn()
      .mockResolvedValueOnce(output)
      .mockRejectedValueOnce(new Error("temporary observation error"))
      .mockResolvedValue({ ...output, state: "closed" });
    await closeDevPreview(f.record, f.deps);
    expect(f.provider.release).toHaveBeenCalledTimes(3);
    expect(f.record.phase).toBe("closed");
  });

  it("preserves cleanup pending when provider keeps billing", async () => {
    const f = fixture();
    f.record.externalName = "42";
    f.provider.status = vi.fn(async () => output);
    await expect(closeDevPreview(f.record, f.deps)).rejects.toMatchObject({
      code: "CLOSURE_UNVERIFIED",
    });
    expect(f.record).toMatchObject({
      phase: "cleanup_pending",
      externalName: "42",
    });
    expect(f.record.closedAt).toBeUndefined();
  });

  it("adopts a unique lost-response allocation only to close it", async () => {
    const f = fixture();
    f.record.cursor = "41";
    f.record.allocationSubmittedAt = f.record.startedAt;
    await closeDevPreview(f.record, f.deps);
    expect(f.provider.findAllocationSince).toHaveBeenCalledWith("41");
    expect(f.provider.provisionWithAllocation).not.toHaveBeenCalled();
    expect(f.record).toMatchObject({ externalName: "42", phase: "closed" });
  });

  it.each([
    "settled",
    "ambiguous",
  ] as const)("keeps uncertain create blocked after %s observation", async (outcome) => {
    const f = fixture();
    f.record.cursor = "41";
    f.record.allocationSubmittedAt = f.record.startedAt;
    f.provider.findAllocationSince = vi.fn(async () =>
      outcome === "settled" ? { outcome } : { outcome, dseqs: ["42", "43"] }
    );
    await expect(closeDevPreview(f.record, f.deps)).rejects.toThrow();
    expect(f.record.phase).toBe("cleanup_pending");
    expect(f.provider.release).not.toHaveBeenCalled();
    expect(f.provider.provisionWithAllocation).not.toHaveBeenCalled();
  });

  it("never allocates an already-released request", async () => {
    const f = fixture();
    f.deps.releaseRequested = async () => true;
    await expect(runDevPreview(config, f.record, f.deps)).rejects.toMatchObject(
      { code: "REQUEST_EXPIRED_OR_RELEASED" }
    );
    expect(f.provider.provisionWithAllocation).not.toHaveBeenCalled();
    expect(f.record.phase).toBe("closed");
  });

  it("closes a durably recorded handle when boot proof throws", async () => {
    const f = fixture();
    f.provider.provisionWithAllocation = vi.fn(async (_input, allocated) => {
      await allocated(output);
      throw new Error("provider body contains a secret");
    });
    await expect(runDevPreview(config, f.record, f.deps)).rejects.toThrow();
    expect(f.record.phase).toBe("closed");
    expect(f.provider.release).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.snapshots)).not.toContain("provider body");
  });

  it("prepares the real auth origin once on the same allocation before emitting ready", async () => {
    const f = fixture();
    const prepare = vi.fn(async (observed: ProvisionOutput) => ({
      output: observed,
      origin: "http://fixture.ingress.example.org",
    }));
    f.deps.prepareAuthenticatedOrigin = prepare;
    f.deps.releaseRequested = async () => f.record.phase === "ready";
    await runDevPreview(
      { ...config, useIngressAuthOrigin: true },
      f.record,
      f.deps
    );
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(f.provider.provisionWithAllocation).toHaveBeenCalledTimes(1);
    expect(f.record.authOrigin).toBe("http://fixture.ingress.example.org");
    expect(f.snapshots.find((r) => r.phase === "ready")).toMatchObject({
      externalName: "42",
      authOrigin: "http://fixture.ingress.example.org",
    });
  });

  it("does not publish ready when origin preparation exhausts the hard lifetime", async () => {
    const f = fixture();
    f.deps.prepareAuthenticatedOrigin = async (observed) => {
      await f.deps.sleep(31000);
      return { output: observed, origin: "http://fixture.ingress.example.org" };
    };
    await expect(
      runDevPreview({ ...config, useIngressAuthOrigin: true }, f.record, f.deps)
    ).rejects.toMatchObject({ code: "REQUEST_EXPIRED_OR_RELEASED" });
    expect(f.snapshots.some((r) => r.phase === "ready")).toBe(false);
    expect(f.record.phase).toBe("closed");
    expect(f.provider.release).toHaveBeenCalledTimes(1);
  });

  it("rejects unbounded lifetimes, mutable images and retained volumes", () => {
    expect(
      DevPreviewConfigSchema.safeParse({ ...config, deadlineSeconds: 601 })
        .success
    ).toBe(false);
    const app = config.spec.services[0];
    expect(
      DevPreviewConfigSchema.safeParse({
        ...config,
        spec: {
          ...config.spec,
          services: [{ ...app, image: "ghcr.io/app:latest" }],
        },
      }).success
    ).toBe(false);
    expect(
      DevPreviewConfigSchema.safeParse({
        ...config,
        spec: {
          ...config.spec,
          services: [{ ...app, volumes: [{ name: "data" }] }],
        },
      }).success
    ).toBe(false);
    expect(safeFailure(new Error("secret"))).toBe("EXPERIMENT_FAILED");
  });
});
