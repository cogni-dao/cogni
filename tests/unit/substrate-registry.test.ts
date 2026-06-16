// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/substrate-registry`
 * Purpose: Enforce the substrate-completeness SEAM in CI: reconcile pairs assertLive.
 *   Every registered dependency pairs a reconcile with a live assertion, and every
 *   assertion still a stub fails CLOSED — making "you cannot ship a reconcile without
 *   its matching live assertion" a CI gate rather than a convention, across two
 *   developers (reconcile = me, assertLive = dev2).
 * Scope: Drives the typed registry's structure + invariants. Does NOT exercise any
 *   VM/cluster reconcile or real live probe.
 * Invariants:
 *   - the registry validates (unique names, valid scope + reconcile mechanism)
 *   - leaf vs env-singleton classification is correct for the known dependencies
 *   - every stubbed assertLive throws SubstrateAssertLiveNotImplementedError
 * Side-effects: none
 * Links: scripts/lib/substrate-registry.ts, knowledge: substrate-completeness-scorecard
 */

import { describe, expect, it } from "vitest";
import {
  envSingletonDependencies,
  getDependency,
  leafDependencies,
  SUBSTRATE_DEPENDENCIES,
  SubstrateAssertLiveNotImplementedError,
  stubbedAssertions,
  validateRegistry,
} from "../../scripts/lib/substrate-registry";

describe("substrate-registry", () => {
  it("validates without throwing", () => {
    expect(() => validateRegistry()).not.toThrow();
  });

  it("has unique dependency names", () => {
    const names = SUBSTRATE_DEPENDENCIES.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("classifies the known dependencies into the two scopes", () => {
    const leaves = leafDependencies().map((d) => d.name);
    const singletons = envSingletonDependencies().map((d) => d.name);

    expect(leaves).toEqual(expect.arrayContaining(["node-db", "knowledge-db"]));
    expect(singletons).toEqual(
      expect.arrayContaining([
        "edge-route",
        "scheduler-worker-routing",
        "observability-scrape",
      ])
    );
    // every dependency is in exactly one scope
    expect(leaves.length + singletons.length).toBe(
      SUBSTRATE_DEPENDENCIES.length
    );
  });

  it("declares a reconcile owner + note for every dependency", () => {
    for (const d of SUBSTRATE_DEPENDENCIES) {
      expect(d.reconcile.owner, d.name).toBeTruthy();
      expect(d.reconcile.note, d.name).toBeTruthy();
    }
  });

  it("THE SEAM: every dependency declares an assertLive", () => {
    for (const d of SUBSTRATE_DEPENDENCIES) {
      expect(typeof d.assertLive, d.name).toBe("function");
    }
  });

  it("THE SEAM: stubbed assertLive fns fail CLOSED (never silently pass)", async () => {
    // The invariant is "a stub fails closed", not "a stub exists" — so this stays
    // green as dev2 (Move 2) lands real probes and the stub set shrinks to empty.
    const stubs = stubbedAssertions();
    for (const d of stubs) {
      await expect(
        d.assertLive({ env: "candidate-a", node: "throwaway" })
      ).rejects.toBeInstanceOf(SubstrateAssertLiveNotImplementedError);
    }
  });

  it("knowledge-db is registered as the bug.5033 crashloop fix", () => {
    const dep = getDependency("knowledge-db");
    expect(dep?.bug).toContain("bug.5033");
    expect(dep?.reconcile.note).toMatch(/COGNI_NODE_DBS/);
  });

  it("scheduler-worker-routing is declarative (Reloader) and records the delivery gap", () => {
    const dep = getDependency("scheduler-worker-routing");
    expect(dep?.reconcile.mechanism).toBe("declarative");
    expect(dep?.reconcile.owner).toMatch(/reloader/i);
    expect(dep?.reconcile.note).toMatch(/deploy\/<env>-scheduler-worker/);
  });
});
