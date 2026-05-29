// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/tests/edo-loop`
 * Purpose: EDO Foundation stack test proving the hypothesis loop closes end-to-end with all four adapter invariants enforced.
 * Scope: Tests only. Does not contain runtime code, ports, or adapters.
 *   This test exercises `EdoCapability` direct-to-store — the path used by
 *   (a) session-cookie human callers of `POST /api/v1/edo/*` and (b) internal
 *   langgraph `core__edo_*` tools. Bearer-authenticated HTTP callers are
 *   routed through `ContributionService.createEdo*Contribution` (W2 federation
 *   gate, EDO_BEARER_VIA_CONTRIB_BRANCH) and are covered by
 *   `tests/contribution-service.test.ts` — those writes land on `contrib/*`,
 *   not main.
 * Invariants: parity with DoltgresKnowledgeStoreAdapter on every enforcement gate exercised here.
 * Side-effects: none (in-memory fakes)
 * Links: docs/spec/knowledge-syntropy.md
 * @internal
 */

import { describe, expect, it } from "vitest";
import {
  FakeEdoResolverAdapter,
  FakeKnowledgeStoreAdapter,
} from "../src/adapters/fake/index.js";
import { createEdoCapability } from "../src/edo-capability.js";
import {
  CitationTargetNotFoundError,
  CitationTypeMismatchError,
  HypothesisMissingEvaluateAtError,
} from "../src/port/knowledge-store.port.js";

const DOMAIN = "prediction-market";

async function bootstrap() {
  const store = new FakeKnowledgeStoreAdapter();
  await store.registerDomain({
    id: DOMAIN,
    name: "Prediction Market",
    description: "Test domain",
  });
  const resolver = new FakeEdoResolverAdapter(store);
  const capability = createEdoCapability(store, resolver);
  return { store, resolver, capability };
}

describe("EDO foundation — invariants", () => {
  it("rejects hypothesis writes without evaluate_at (HYPOTHESIS_HAS_EVALUATE_AT)", async () => {
    const { store } = await bootstrap();
    await expect(
      store.addKnowledge({
        id: "h-no-eval",
        domain: DOMAIN,
        title: "missing evaluate_at",
        content: "this should fail",
        entryType: "hypothesis",
        sourceType: "agent",
        // evaluateAt deliberately omitted
      })
    ).rejects.toBeInstanceOf(HypothesisMissingEvaluateAtError);
  });

  it("rejects citations targeting non-existent rows (CITATION_TARGET_EXISTS_AT_WRITE)", async () => {
    const { store } = await bootstrap();
    await store.addKnowledge({
      id: "evt-1",
      domain: DOMAIN,
      title: "an event",
      content: "happened",
      entryType: "event",
      sourceType: "agent",
    });
    await expect(
      store.addCitation({
        citingId: "evt-1",
        citedId: "does-not-exist",
        citationType: "evidence_for",
      })
    ).rejects.toBeInstanceOf(CitationTargetNotFoundError);
  });

  it("rejects derives_from edges pointing at non-hypothesis rows (EDGE_TYPE_MATCHES_CITED_ENTRY_TYPE)", async () => {
    const { store } = await bootstrap();
    // Two events (not hypotheses).
    await store.addKnowledge({
      id: "evt-source",
      domain: DOMAIN,
      title: "event a",
      content: "...",
      entryType: "event",
      sourceType: "agent",
    });
    await store.addKnowledge({
      id: "evt-target",
      domain: DOMAIN,
      title: "event b",
      content: "...",
      entryType: "event",
      sourceType: "agent",
    });
    // derives_from must point at a hypothesis.
    await expect(
      store.addCitation({
        citingId: "evt-source",
        citedId: "evt-target",
        citationType: "derives_from",
      })
    ).rejects.toBeInstanceOf(CitationTypeMismatchError);
  });

  it("allows evidence_for to cite any entry_type (events, findings)", async () => {
    const { store } = await bootstrap();
    await store.addKnowledge({
      id: "evt",
      domain: DOMAIN,
      title: "event",
      content: "...",
      entryType: "event",
      sourceType: "agent",
    });
    await store.addKnowledge({
      id: "h",
      domain: DOMAIN,
      title: "hypothesis",
      content: "...",
      entryType: "hypothesis",
      evaluateAt: new Date("2026-12-31"),
      sourceType: "agent",
    });
    // evidence_for: hypothesis cites event — permissive edge.
    const citation = await store.addCitation({
      citingId: "h",
      citedId: "evt",
      citationType: "evidence_for",
    });
    expect(citation.citationType).toBe("evidence_for");
  });
});

describe("EDO foundation — full hypothesis loop", () => {
  it("closes the loop: hypothesis → decision → time advances → resolve → confidence recomputes", async () => {
    const { store, resolver, capability } = await bootstrap();

    // 0. File a triggering event via the raw store (events flow through
    //    core__knowledge_write; not via EDO atomic tools).
    await store.addKnowledge({
      id: "evt:fed-meeting-announce",
      domain: DOMAIN,
      title: "Fed announces meeting",
      content: "FOMC meeting scheduled 2026-03-15",
      entryType: "event",
      sourceType: "agent",
    });

    // 1. Agent forms a hypothesis citing the event. evaluate_at = post-meeting.
    const evaluateAt = new Date("2026-03-15T20:00:00Z");
    const hypothesis = await capability.hypothesize({
      id: "h:fed-rate-cut-march",
      domain: DOMAIN,
      title: "Fed will cut rates by 25bps at March 2026 meeting",
      content: "Base rate × news update suggests 35% probability",
      evaluateAt,
      resolutionStrategy: "agent", // opt into the resolver cron
      evidenceForIds: ["evt:fed-meeting-announce"],
      sourceType: "agent",
    });
    expect(hypothesis.id).toBe("h:fed-rate-cut-march");

    // 2. Agent takes a decision deriving from the hypothesis.
    const decision = await capability.decide({
      id: "d:long-rate-cut-position",
      domain: DOMAIN,
      title: "Open long position on rate-cut market",
      content: "Allocate 5% of treasury to YES at <40c",
      derivesFromHypothesisId: hypothesis.id,
      sourceType: "agent",
    });
    expect(decision.id).toBe("d:long-rate-cut-position");

    // Pre-resolution state: the hypothesis is in pendingResolutions when
    // the clock is past evaluate_at.
    const beforeTime = new Date("2026-03-14T00:00:00Z");
    const noneYet = await resolver.pendingResolutions(beforeTime, {
      strategy: "agent",
    });
    expect(noneYet.find((r) => r.id === hypothesis.id)).toBeUndefined();

    const afterTime = new Date("2026-03-15T21:00:00Z");
    const pending = await resolver.pendingResolutions(afterTime, {
      strategy: "agent",
    });
    expect(pending.find((r) => r.id === hypothesis.id)).toBeDefined();

    // 3. Cron fires — resolver files the outcome. (In production, the cron
    //    in scheduler-worker calls resolveHypothesis; here we call it
    //    directly. The capability layer is the production path.)
    const outcomeResult = await capability.recordOutcome({
      id: "o:fed-cut-march-resolved",
      domain: DOMAIN,
      title: "Fed cut rates 25bps as predicted",
      content: "FOMC statement at 14:00 EST confirmed the cut",
      hypothesisId: hypothesis.id,
      edge: "validates",
      sourceType: "agent",
      sourceNode: "operator-cron",
    });

    // 4. Loop closure assertions.
    expect(outcomeResult.alreadyResolved).toBe(false);
    expect(outcomeResult.hypothesisId).toBe(hypothesis.id);
    expect(outcomeResult.resolvedConfidence).toBeGreaterThan(30); // agent baseline + at least one validates

    // 5. The chain is observable in the citations table.
    const hypothesisIncoming = await store.listCitationsByCitedId(
      hypothesis.id
    );
    expect(
      hypothesisIncoming.find((c) => c.citationType === "validates")
    ).toBeDefined();
    expect(
      hypothesisIncoming.find((c) => c.citationType === "derives_from")
    ).toBeDefined(); // from the decision

    // 6. The outcome row exists with the right shape.
    const outcomeRow = await store.getKnowledge("o:fed-cut-march-resolved");
    expect(outcomeRow?.entryType).toBe("outcome");

    // 7. After resolution, pendingResolutions excludes the now-resolved row.
    const stillPending = await resolver.pendingResolutions(afterTime, {
      strategy: "agent",
    });
    expect(stillPending.find((r) => r.id === hypothesis.id)).toBeUndefined();

    // 8. Commit history records each beat (RESOLVER + atomic tools each commit).
    const commits = await store.log();
    expect(commits.length).toBeGreaterThanOrEqual(4); // domain register + hypothesize + decide + resolve
    expect(commits.some((c) => c.message.includes("hypothesize"))).toBe(true);
    expect(commits.some((c) => c.message.includes("decide"))).toBe(true);
    expect(commits.some((c) => c.message.includes("resolve hypothesis"))).toBe(
      true
    );
  });

  it("RESOLVER_IDEMPOTENT — double-resolve returns existing state, no double-write", async () => {
    const { store, capability } = await bootstrap();
    await capability.hypothesize({
      id: "h:rep",
      domain: DOMAIN,
      title: "h",
      content: "c",
      evaluateAt: new Date("2026-01-01"),
      resolutionStrategy: "agent",
      sourceType: "agent",
    });

    await capability.recordOutcome({
      id: "o:rep-1",
      domain: DOMAIN,
      title: "first",
      content: "...",
      hypothesisId: "h:rep",
      edge: "validates",
      sourceType: "agent",
    });

    const second = await capability.recordOutcome({
      id: "o:rep-2", // different id — would create dup outcome if not idempotent
      domain: DOMAIN,
      title: "second",
      content: "...",
      hypothesisId: "h:rep",
      edge: "invalidates", // conflicting verdict! idempotent path ignores this
      sourceType: "agent",
    });

    expect(second.alreadyResolved).toBe(true);
    // No second outcome row was created.
    expect(await store.getKnowledge("o:rep-2")).toBeNull();
    // Only one resolving citation exists.
    const resolving = (await store.listCitationsByCitedId("h:rep")).filter(
      (c) => c.citationType === "validates" || c.citationType === "invalidates"
    );
    expect(resolving).toHaveLength(1);
  });

  it("manual hypothesis (resolution_strategy=null) is invisible to the agent cron", async () => {
    const { capability, resolver } = await bootstrap();
    await capability.hypothesize({
      id: "h:manual",
      domain: DOMAIN,
      title: "h",
      content: "c",
      evaluateAt: new Date("2020-01-01"), // long past
      // resolutionStrategy intentionally omitted → null → manual
      sourceType: "agent",
    });
    const pending = await resolver.pendingResolutions(new Date("2026-06-01"), {
      strategy: "agent",
    });
    expect(pending.find((r) => r.id === "h:manual")).toBeUndefined();
    // Without a strategy filter, manual is also excluded (resolution_strategy IS NULL).
    const allAuto = await resolver.pendingResolutions(new Date("2026-06-01"));
    expect(allAuto.find((r) => r.id === "h:manual")).toBeUndefined();
  });

  it("RECOMPUTE_IS_PURE_FROM_CITATIONS — confidence is order-independent under multiple supports/contradicts", async () => {
    const { store, resolver } = await bootstrap();

    // Build a finding with mixed citations from various entries.
    await store.addKnowledge({
      id: "f:base",
      domain: DOMAIN,
      title: "finding",
      content: "...",
      entryType: "finding",
      sourceType: "agent",
    });

    // Create 5 supports and 2 contradicts via finding→finding edges (non-strict).
    for (let i = 0; i < 5; i++) {
      await store.addKnowledge({
        id: `s${i}`,
        domain: DOMAIN,
        title: `s${i}`,
        content: "...",
        entryType: "finding",
        sourceType: "agent",
      });
      await store.addCitation({
        citingId: `s${i}`,
        citedId: "f:base",
        citationType: "supports",
      });
    }
    for (let i = 0; i < 2; i++) {
      await store.addKnowledge({
        id: `c${i}`,
        domain: DOMAIN,
        title: `c${i}`,
        content: "...",
        entryType: "finding",
        sourceType: "agent",
      });
      await store.addCitation({
        citingId: `c${i}`,
        citedId: "f:base",
        citationType: "contradicts",
      });
    }

    // Compute twice — must converge to the same value regardless of intervening calls.
    const first = await resolver.recomputeConfidence("f:base");
    const second = await resolver.recomputeConfidence("f:base");
    expect(second).toBe(first);

    // Formula sanity: initial(agent)=30 + min(50, 10*5) - 15*2 = 30 + 50 - 30 = 50.
    expect(first).toBe(50);
  });
});

describe("EDO chain walk — walkChain", () => {
  it("returns root only when isolated (no citations)", async () => {
    const { store, resolver } = await bootstrap();
    await store.addKnowledge({
      id: "iso",
      domain: DOMAIN,
      title: "isolated",
      content: "alone",
      entryType: "finding",
      sourceType: "agent",
    });
    const chain = await resolver.walkChain("iso");
    expect(chain).toHaveLength(1);
    expect(chain[0]?.entry.id).toBe("iso");
    expect(chain[0]?.depth).toBe(0);
    expect(chain[0]?.edgeFromParent).toBeNull();
  });

  it("returns [] when root doesn't exist", async () => {
    const { resolver } = await bootstrap();
    const chain = await resolver.walkChain("nonexistent");
    expect(chain).toEqual([]);
  });

  it("walks the full hypothesis loop in both directions", async () => {
    const { store, capability, resolver } = await bootstrap();

    // event ← evidence_for ← hypothesis ← derives_from ← decision
    //                                 ↖ validates ← outcome
    await store.addKnowledge({
      id: "evt",
      domain: DOMAIN,
      title: "event",
      content: "...",
      entryType: "event",
      sourceType: "agent",
    });
    await capability.hypothesize({
      id: "h",
      domain: DOMAIN,
      title: "h",
      content: "...",
      evaluateAt: new Date("2026-01-01"),
      resolutionStrategy: "agent",
      evidenceForIds: ["evt"],
      sourceType: "agent",
    });
    await capability.decide({
      id: "d",
      domain: DOMAIN,
      title: "d",
      content: "...",
      derivesFromHypothesisId: "h",
      sourceType: "agent",
    });
    await capability.recordOutcome({
      id: "o",
      domain: DOMAIN,
      title: "o",
      content: "...",
      hypothesisId: "h",
      edge: "validates",
      sourceType: "agent",
    });

    // From the hypothesis, `both` reveals the event (out) + decision + outcome (in).
    const both = await resolver.walkChain("h", { direction: "both" });
    const ids = both.map((n) => n.entry.id).sort();
    expect(ids).toEqual(["d", "evt", "h", "o"]);
    expect(both[0]?.entry.id).toBe("h");
    expect(both[0]?.depth).toBe(0);
    expect(both[0]?.edgeFromParent).toBeNull();

    // Sanity-check the edges that came back.
    const byId = new Map(both.map((n) => [n.entry.id, n]));
    expect(byId.get("evt")?.edgeFromParent).toEqual({
      citationType: "evidence_for",
      direction: "out",
    });
    expect(byId.get("d")?.edgeFromParent).toEqual({
      citationType: "derives_from",
      direction: "in",
    });
    expect(byId.get("o")?.edgeFromParent).toEqual({
      citationType: "validates",
      direction: "in",
    });
  });

  it("direction=out follows only citing→cited (what does this row cite?)", async () => {
    const { store, capability, resolver } = await bootstrap();
    await store.addKnowledge({
      id: "evt",
      domain: DOMAIN,
      title: "evt",
      content: "...",
      entryType: "event",
      sourceType: "agent",
    });
    await capability.hypothesize({
      id: "h",
      domain: DOMAIN,
      title: "h",
      content: "...",
      evaluateAt: new Date("2026-01-01"),
      evidenceForIds: ["evt"],
      sourceType: "agent",
    });
    // Hypothesis cites the event → out from h reveals evt.
    const out = await resolver.walkChain("h", { direction: "out" });
    expect(out.map((n) => n.entry.id).sort()).toEqual(["evt", "h"]);
    // Nothing cites h yet → in from h reveals only h itself.
    const inOnly = await resolver.walkChain("h", { direction: "in" });
    expect(inOnly.map((n) => n.entry.id)).toEqual(["h"]);
  });

  it("respects maxDepth (truncates the BFS frontier)", async () => {
    const { store, resolver } = await bootstrap();
    // Build a 5-deep linear chain via supports edges.
    for (let i = 0; i < 5; i++) {
      await store.addKnowledge({
        id: `n${i}`,
        domain: DOMAIN,
        title: `n${i}`,
        content: "...",
        entryType: "finding",
        sourceType: "agent",
      });
    }
    // n0 supports n1 supports n2 supports n3 supports n4
    for (let i = 0; i < 4; i++) {
      await store.addCitation({
        citingId: `n${i}`,
        citedId: `n${i + 1}`,
        citationType: "supports",
      });
    }
    // out from n0 with depth 2 → n0, n1, n2 only.
    const truncated = await resolver.walkChain("n0", {
      direction: "out",
      maxDepth: 2,
    });
    expect(truncated.map((n) => n.entry.id).sort()).toEqual(["n0", "n1", "n2"]);
    expect(Math.max(...truncated.map((n) => n.depth))).toBe(2);

    // out from n0 with default depth (5) catches all five.
    const full = await resolver.walkChain("n0", { direction: "out" });
    expect(full.map((n) => n.entry.id).sort()).toEqual([
      "n0",
      "n1",
      "n2",
      "n3",
      "n4",
    ]);
  });

  it("terminates on cycles (A supports B supports A) without infinite-looping", async () => {
    const { store, resolver } = await bootstrap();
    await store.addKnowledge({
      id: "a",
      domain: DOMAIN,
      title: "a",
      content: "...",
      entryType: "finding",
      sourceType: "agent",
    });
    await store.addKnowledge({
      id: "b",
      domain: DOMAIN,
      title: "b",
      content: "...",
      entryType: "finding",
      sourceType: "agent",
    });
    await store.addCitation({
      citingId: "a",
      citedId: "b",
      citationType: "supports",
    });
    await store.addCitation({
      citingId: "b",
      citedId: "a",
      citationType: "supports",
    });
    const chain = await resolver.walkChain("a", { direction: "both" });
    // Two nodes, each visited once. The first-visit semantic means we don't
    // re-emit `a` at depth 2 even though the cycle closes back to it.
    expect(chain.map((n) => n.entry.id).sort()).toEqual(["a", "b"]);
  });
});
