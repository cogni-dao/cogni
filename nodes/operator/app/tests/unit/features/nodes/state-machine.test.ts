// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/nodes/state-machine`
 * Purpose: Unit tests for the node-registry state machine.
 * Scope: Every (status, event) pair; happy path; failure escape; invalid transitions.
 * Side-effects: none
 * Links: src/features/nodes/state-machine.ts
 * @public
 */

import { describe, expect, it } from "vitest";
import {
  NODE_PROGRESS_STEPS,
  type NodeEvent,
  progressIndexForStatus,
  transition,
  wizardUrlForStatus,
} from "@/features/nodes/state-machine";
import { NODE_STATUSES, type NodeStatus } from "@/shared/db/nodes";

describe("transition — happy path", () => {
  it("walks dao_pending → dao_formed → published → wallet_ready → payments_ready → active", () => {
    let s: NodeStatus = "dao_pending";
    for (const ev of [
      "dao_verified",
      "spec_published",
      "wallet_provisioned",
      "payments_configured",
      "activation_published",
    ] as const) {
      const r = transition(s, { type: ev });
      expect(r.ok).toBe(true);
      if (r.ok) s = r.nextStatus;
    }
    expect(s).toBe("active");
  });
});

describe("transition — failure escape", () => {
  it.each([
    "dao_pending",
    "dao_formed",
    "published",
    "wallet_ready",
    "payments_ready",
  ] as const)("%s can transition to failed via fail event", (s) => {
    const r = transition(s, { type: "fail", reason: "test" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.nextStatus).toBe("failed");
  });
});

describe("transition — invalid transitions", () => {
  it("rejects skipping the dao_verified step", () => {
    const r = transition("dao_pending", { type: "spec_published" });
    expect(r.ok).toBe(false);
  });

  it("rejects events from terminal states (active)", () => {
    for (const ev of ["dao_verified", "spec_published", "fail"] as const) {
      const r = transition("active", { type: ev, reason: "x" } as NodeEvent);
      expect(r.ok).toBe(false);
    }
  });

  it("rejects events from terminal states (failed)", () => {
    const r = transition("failed", { type: "dao_verified" });
    expect(r.ok).toBe(false);
  });

  it("returns a stable reason string on invalid transitions", () => {
    const r = transition("payments_ready", { type: "spec_published" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/Invalid transition/);
  });
});

describe("transition — totality", () => {
  it("returns a defined result for every (status, event) pair", () => {
    const events: NodeEvent[] = [
      { type: "dao_verified" },
      { type: "spec_published" },
      { type: "wallet_provisioned" },
      { type: "payments_configured" },
      { type: "activation_published" },
      { type: "fail", reason: "test" },
    ];
    for (const s of NODE_STATUSES) {
      for (const e of events) {
        const r = transition(s, e);
        expect(typeof r.ok).toBe("boolean");
      }
    }
  });
});

describe("progress display", () => {
  it("shows published as the handoff step", () => {
    expect(NODE_PROGRESS_STEPS.map((step) => step.label)).toEqual([
      "Register",
      "DAO",
      "Repo",
      "Handoff",
      "Payments",
    ]);
    expect(
      NODE_PROGRESS_STEPS[progressIndexForStatus("published")]?.label
    ).toBe("Handoff");
  });
});

describe("wizardUrlForStatus", () => {
  it("routes each status to the canonical wizard page", () => {
    const id = "abc-123";
    expect(wizardUrlForStatus(id, "dao_pending")).toBe(`/nodes/${id}`);
    expect(wizardUrlForStatus(id, "dao_formed")).toBe(`/nodes/${id}`);
    expect(wizardUrlForStatus(id, "published")).toBe(`/nodes/${id}`);
    expect(wizardUrlForStatus(id, "wallet_ready")).toBe(`/nodes/${id}`);
    expect(wizardUrlForStatus(id, "payments_ready")).toBe(`/nodes/${id}`);
    expect(wizardUrlForStatus(id, "active")).toBe(`/nodes/${id}`);
    expect(wizardUrlForStatus(id, "failed")).toBe(`/nodes/${id}`);
  });
});
