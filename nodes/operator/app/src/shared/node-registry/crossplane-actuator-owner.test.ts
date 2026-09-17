// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { describe, expect, it } from "vitest";
import {
  CROSSPLANE_ACTUATOR_WALLET_ENVS,
  CROSSPLANE_ACTUATOR_WRITERS,
  canBirthOnCrossplane,
  writerFor,
} from "./crossplane-control-plane";

const PROD_WRITER = "production/akash-tx-actuator";
const TEST_WRITER = "candidate-a/akash-tx-actuator";

describe("actuator serving is keyed on (env, owner) — bug.5202", () => {
  it("NS3: a real cogni-dao node bills production in EVERY environment", () => {
    // "Every real node deployment — every node, in every environment — bills the PRODUCTION
    // Console account." Environment is a property of the deployment, not of who pays.
    for (const env of ["candidate-a", "preview", "production"]) {
      expect(writerFor(env, "cogni-dao")?.id, env).toBe(PROD_WRITER);
      expect(canBirthOnCrossplane(env, "cogni-dao"), env).toBe(true);
    }
  });

  it("NS4: the test account pays ONLY for cogni-test-org, and only on candidate-a", () => {
    expect(writerFor("candidate-a", "cogni-test-org")?.id).toBe(TEST_WRITER);
    // It never pays for a real node, and it does not reach any other lane.
    expect(writerFor("preview", "cogni-test-org")).toBeUndefined();
    expect(writerFor("production", "cogni-test-org")).toBeUndefined();
  });

  it("resolves candidate-a to DIFFERENT accounts by owner — the collision that forced the fix", () => {
    // Keyed on the env alone this pair is ambiguous and `writerFor` returned undefined, which
    // is why a real node's test lane could not be expressed at all without either breaking
    // candidate-a or billing the platform test account for a real node.
    const real = writerFor("candidate-a", "cogni-dao");
    const platform = writerFor("candidate-a", "cogni-test-org");
    expect(real?.id).not.toBe(platform?.id);
    expect(real?.cluster).toBe("production");
    expect(platform?.cluster).toBe("candidate-a");
  });

  it("is case-insensitive on the owner, and denies an unknown owner", () => {
    expect(writerFor("production", "Cogni-DAO")?.id).toBe(PROD_WRITER);
    expect(writerFor("production", "some-other-org")).toBeUndefined();
    expect(canBirthOnCrossplane("production", "")).toBe(false);
  });

  it("keeps account → writer injective while writer → envs stays one-to-many", () => {
    // The bug.5187 property. Widening `serves`/`owners` must never put two writers on one
    // account, because the single-writer index is per-DATABASE and cannot see across them.
    const clusters = CROSSPLANE_ACTUATOR_WRITERS.map((w) => w.cluster);
    expect(new Set(clusters).size).toBe(clusters.length);
    expect(
      CROSSPLANE_ACTUATOR_WRITERS.find((w) => w.id === PROD_WRITER)?.serves
        .length
    ).toBeGreaterThan(1);
  });

  it("does NOT claim preview or candidate-a host a writer — WALLET_ENVS tracks `cluster`", () => {
    // Widening `serves` is a PAYMENT fact. It must not imply a Console key lives there.
    expect([...CROSSPLANE_ACTUATOR_WALLET_ENVS].sort()).toEqual([
      "candidate-a",
      "production",
    ]);
    expect(CROSSPLANE_ACTUATOR_WALLET_ENVS).not.toContain("preview");
  });
});
