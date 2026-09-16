// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@shared/node-registry/akash-lane-host.test`
 * Purpose: Pin the `lane → hosting cluster` map (story.5016 seam 3). The predicate is the PAIR
 *   (akash placement AND crossplane authority) on a non-production env; every other combination
 *   must resolve to the cell's own environment so the k3s and legacy-authority lanes are provably
 *   untouched.
 * Scope: Pure function table. No IO.
 * Links: src/shared/node-registry/akash-lane-host.ts, tests/ci-invariants/akash-lane-host.spec.ts
 * @public
 */

import { describe, expect, it } from "vitest";

import {
  AKASH_LANE_HOST_ENV,
  appsetsDirForLane,
  HOSTED_LANE_APPSETS_DIR,
  isHostedAkashLane,
  type LaneComputeApi,
  type LanePlacementProvider,
  resolveLaneHostEnv,
} from "./akash-lane-host";

const ENVS = ["candidate-a", "preview", "production"] as const;
const PROVIDERS: LanePlacementProvider[] = ["k3s", "akash"];
const AUTHORITIES: LaneComputeApi[] = ["legacy", "crossplane"];

describe("akash lane host", () => {
  /**
   * The whole truth table in one assertion. The ONLY cells that move are non-production
   * akash+crossplane; 10 of the 12 combinations must be identity. Enumerating rather than
   * spot-checking is deliberate — a widened predicate would silently rehome a k3s lane, and a
   * narrowed one would leave a paid pre-prod lane reconciled by a cluster with no writer.
   */
  it("hosts exactly the non-production akash+crossplane cells", () => {
    const hosted: string[] = [];
    for (const environment of ENVS) {
      for (const deploymentProvider of PROVIDERS) {
        for (const computeApi of AUTHORITIES) {
          const cell = { environment, deploymentProvider, computeApi };
          if (isHostedAkashLane(cell)) {
            hosted.push(`${environment}/${deploymentProvider}/${computeApi}`);
          } else {
            expect(resolveLaneHostEnv(cell)).toBe(environment);
            expect(appsetsDirForLane(cell)).toBe(environment);
          }
        }
      }
    }
    expect(hosted.sort()).toEqual([
      "candidate-a/akash/crossplane",
      "preview/akash/crossplane",
    ]);
  });

  /**
   * A hosted lane resolves to the ONE production host and to the separate appsets directory —
   * never to `appsets/production/`, which the production app-of-apps owns and whose header
   * documents that it can never fan a foreign env's AppSets onto the cluster.
   */
  it("routes a hosted lane to the production cluster via its own appsets directory", () => {
    for (const environment of ["candidate-a", "preview"] as const) {
      const cell = {
        environment,
        deploymentProvider: "akash" as const,
        computeApi: "crossplane" as const,
      };
      expect(resolveLaneHostEnv(cell)).toBe(AKASH_LANE_HOST_ENV);
      expect(appsetsDirForLane(cell)).toBe(HOSTED_LANE_APPSETS_DIR);
      expect(appsetsDirForLane(cell)).not.toBe(AKASH_LANE_HOST_ENV);
    }
  });

  /**
   * Production is never rehomed: it already IS the writer's cluster, so seam 3 must be a no-op for
   * it. This is what keeps `appsets/production/` byte-identical to before.
   */
  it("never rehomes a production cell", () => {
    for (const deploymentProvider of PROVIDERS) {
      for (const computeApi of AUTHORITIES) {
        expect(
          resolveLaneHostEnv({
            environment: AKASH_LANE_HOST_ENV,
            deploymentProvider,
            computeApi,
          })
        ).toBe(AKASH_LANE_HOST_ENV);
      }
    }
  });
});
