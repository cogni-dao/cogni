// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/facades/goal-loop-step`
 * Purpose: Prove a goal-loop step publishes its atom and citation as one logical unit.
 * Scope: Actual fake knowledge port and pure facade. Does not connect to a database, Temporal, or container.
 * Invariants: Successful retry is a no-op; citation rejection publishes no partial atom.
 * Side-effects: none
 * Links: app/_facades/goal-loop/service.server.ts
 * @internal
 */
import { createEdoCapability } from "@cogni/knowledge-store";
import {
  FakeEdoResolverAdapter,
  FakeKnowledgeStoreAdapter,
} from "@cogni/knowledge-store/adapters/fake";
import { describe, expect, it } from "vitest";
import { runGoalStep } from "@/app/_facades/goal-loop/service.server";

const INPUT = {
  hypothesisId: "goal",
  domain: "meta",
  idempotencyKey: "goal/0",
  iteration: 0,
  stepGraphId: "langgraph:research",
};
async function setup() {
  const store = new FakeKnowledgeStoreAdapter();
  await store.registerDomain({ id: "meta", name: "Meta" });
  const edo = createEdoCapability(store, new FakeEdoResolverAdapter(store));
  return { store, edo, now: () => new Date("2026-10-19T23:00:00Z") };
}
describe("runGoalStep logical unit", () => {
  it("publishes one atom and edge and reuses them after a lost response", async () => {
    const deps = await setup();
    await deps.edo.hypothesize({
      id: "goal",
      domain: "meta",
      title: "Goal",
      content: "Testable goal",
      evaluateAt: new Date("2026-10-20T00:00:00Z"),
      sourceType: "derived",
    });
    const commits = deps.store.commitLog.length;
    const first = await runGoalStep(deps, INPUT);
    expect(await runGoalStep(deps, INPUT)).toEqual(first);
    expect(deps.store.commitLog).toHaveLength(commits + 1);
    expect(
      (await deps.store.getKnowledge(INPUT.idempotencyKey))?.sourceRef
    ).toBe("goal-loop:goal");
    expect(
      await deps.store.listCitationsByCitingId(INPUT.idempotencyKey)
    ).toMatchObject([{ citedId: "goal", citationType: "evidence_for" }]);
  });
  it("citation rejection leaves neither an atom nor a new commit", async () => {
    const deps = await setup();
    const commits = deps.store.commitLog.length;
    await expect(runGoalStep(deps, INPUT)).rejects.toThrow("citation target");
    expect(await deps.store.getKnowledge(INPUT.idempotencyKey)).toBeNull();
    expect(
      await deps.store.listCitationsByCitingId(INPUT.idempotencyKey)
    ).toEqual([]);
    expect(deps.store.commitLog).toHaveLength(commits);
  });
});
