// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/compute/akash-sdl` (test)
 * Purpose: Pin ZERO_DOWNTIME_ROLLING (bug.5188 axis-2) — the single-source-of-truth replica
 *   policy. The service that owns public ingress renders `count: INGRESS_REPLICAS` so an
 *   in-place Akash update rolls one replica at a time (the origin never drops → no HTTP 530
 *   window like the toks5 promote proof produced at count=1); mesh/sidecar services stay at 1.
 *   `count` is decided in EXACTLY ONE place (`replicaCountFor`) and set nowhere else.
 * Scope: Pure unit — no network, no provider.
 * Links: akash-sdl.ts, bug.5188, akash-native-rollout-h (north-star)
 * @public
 */

import type { ProvisionServiceSpec, ProvisionSpec } from "@cogni/ai-tools";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildAkashSdl, INGRESS_REPLICAS, replicaCountFor } from "./akash-sdl";

const ingress: ProvisionServiceSpec = {
  name: "app",
  image: "ghcr.io/cogni-dao/toks5:sha-abc",
  cpuUnits: 1,
  memoryMi: 512,
  storageMi: 512,
  expose: [
    { port: 3000, as: 80, global: true, hosts: ["toks5-test.cognidao.org"] },
  ],
};
const mesh: ProvisionServiceSpec = {
  name: "sidecar",
  image: "ghcr.io/cogni-dao/side:sha-def",
  cpuUnits: 1,
  memoryMi: 256,
  storageMi: 256,
  expose: [{ port: 4000, as: 4000, global: false }],
};

type RenderedSdl = {
  deployment: Record<string, { dcloud: { count: number } }>;
};

describe("akash-sdl ZERO_DOWNTIME_ROLLING replica policy (bug.5188 axis-2)", () => {
  it("INGRESS_REPLICAS is >= 2 so an in-place update can roll one replica at a time", () => {
    expect(INGRESS_REPLICAS).toBeGreaterThanOrEqual(2);
  });

  it("replicaCountFor: public-ingress -> INGRESS_REPLICAS, mesh/internal -> 1", () => {
    expect(replicaCountFor(ingress)).toBe(INGRESS_REPLICAS);
    expect(replicaCountFor(mesh)).toBe(1);
    // Internal-only (no expose at all) is not an ingress → stays single-replica.
    expect(replicaCountFor({ ...ingress, expose: undefined })).toBe(1);
  });

  it("buildAkashSdl renders count per the policy — the ONLY place count is set", () => {
    const spec: ProvisionSpec = { name: "toks5", services: [ingress, mesh] };
    const sdl = parse(
      buildAkashSdl(spec, { pricingDenom: "uakt", pricingAmount: 1000 })
    ) as RenderedSdl;
    expect(sdl.deployment.app.dcloud.count).toBe(INGRESS_REPLICAS);
    expect(sdl.deployment.sidecar.dcloud.count).toBe(1);
  });
});
