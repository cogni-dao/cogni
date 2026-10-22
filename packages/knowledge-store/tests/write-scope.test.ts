// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/tests/write-scope`
 * Purpose: Prove logical unit isolation, closed handles, and successful-request replay identity.
 * Scope: Contract tests against the fake. Does not prove native Dolt behavior, which has a separate component gate.
 * Invariants: Failed units publish nothing; replay cannot change rows, edges, or counters.
 * Side-effects: none
 * Links: knowledge-store.port.ts, doltgres-admission.int.test.ts
 * @internal
 */
import { describe, expect, it } from "vitest";
import {
  FakeEdoResolverAdapter,
  FakeKnowledgeStoreAdapter,
} from "../src/adapters/fake/index.js";
import { createKnowledgeCapability } from "../src/capability.js";
import { KnowledgeWriteConflictError } from "../src/domain/write-replay.js";
import { createEdoCapability } from "../src/edo-capability.js";
import {
  KnowledgeWriteScopeRequiredError,
  type KnowledgeWriteSession,
} from "../src/port/knowledge-store.port.js";

const ENTRY = {
  id: "finding",
  domain: "meta",
  title: "Finding",
  content: "One durable fact",
  sourceType: "agent" as const,
};
async function setup() {
  const store = new FakeKnowledgeStoreAdapter();
  await store.registerDomain({ id: "meta", name: "Meta" });
  return store;
}
describe("required logical knowledge write scopes", () => {
  it("rejects raw mutation and commit without changing the store", async () => {
    const store = await setup();
    await expect(store.addKnowledge(ENTRY)).rejects.toBeInstanceOf(
      KnowledgeWriteScopeRequiredError
    );
    await expect(store.commit("forbidden")).rejects.toBeInstanceOf(
      KnowledgeWriteScopeRequiredError
    );
    expect(await store.getKnowledge(ENTRY.id)).toBeNull();
  });
  it("rolls back the entire logical unit when a citation is rejected", async () => {
    const store = await setup();
    const commits = store.commitLog.length;
    await expect(
      store.withWrite(
        { operationId: "write:failed", message: "must not commit" },
        async (write) => {
          await write.addKnowledge(ENTRY);
          await write.addCitation({
            citingId: ENTRY.id,
            citedId: "missing",
            citationType: "supports",
          });
        }
      )
    ).rejects.toThrow("citation target");
    expect(await store.getKnowledge(ENTRY.id)).toBeNull();
    expect(store.commitLog).toHaveLength(commits);
  });
  it("rejects escaped scoped handles after completion", async () => {
    const store = await setup();
    let escaped!: KnowledgeWriteSession;
    await store.withWrite(
      { operationId: "write:closed", message: "closed" },
      async (write) => {
        escaped = write;
      }
    );
    await expect(escaped.addKnowledge(ENTRY)).rejects.toBeInstanceOf(
      KnowledgeWriteScopeRequiredError
    );
    await expect(escaped.getKnowledge(ENTRY.id)).rejects.toBeInstanceOf(
      KnowledgeWriteScopeRequiredError
    );
  });
  it("same-ID same-payload request replay is a no-op; stale different payload conflicts", async () => {
    const store = await setup();
    const first = await store.withWrite(
      { operationId: "write:finding", message: "first" },
      (write) => write.upsertKnowledge(ENTRY)
    );
    const commits = store.commitLog.length;
    const retry = await store.withWrite(
      { operationId: "write:finding", message: "lost HTTP response retry" },
      (write) => write.upsertKnowledge(ENTRY)
    );
    expect(retry).toEqual(first);
    expect(store.commitLog).toHaveLength(commits);
    await expect(
      store.withWrite(
        { operationId: "write:finding", message: "stale changed request" },
        (write) => write.upsertKnowledge({ ...ENTRY, content: "Other content" })
      )
    ).rejects.toBeInstanceOf(KnowledgeWriteConflictError);
    expect((await store.getKnowledge(ENTRY.id))?.content).toBe(ENTRY.content);
  });
  it("EDO hypothesis response-loss replay preserves canonical identity and one commit", async () => {
    const store = await setup();
    const edo = createEdoCapability(store, new FakeEdoResolverAdapter(store));
    const input = {
      id: "hypothesis",
      domain: "meta",
      title: "Prediction",
      content: "Will be tested",
      evaluateAt: new Date("2026-10-20T00:00:00Z"),
      sourceType: "agent" as const,
    };
    const first = await edo.hypothesize(input);
    const commits = store.commitLog.length;
    expect(await edo.hypothesize(input)).toEqual(first);
    expect(store.commitLog).toHaveLength(commits);
    await expect(
      edo.hypothesize({ ...input, content: "Different prediction" })
    ).rejects.toBeInstanceOf(KnowledgeWriteConflictError);
  });
  it("concurrent resolver retries create exactly one outcome and resolving edge", async () => {
    const store = await setup();
    const resolver = new FakeEdoResolverAdapter(store);
    const edo = createEdoCapability(store, resolver);
    await edo.hypothesize({
      id: "hypothesis",
      domain: "meta",
      title: "Prediction",
      content: "Will be tested",
      evaluateAt: new Date("2026-10-20T00:00:00Z"),
      sourceType: "agent",
    });
    const input = {
      hypothesisId: "hypothesis",
      domain: "meta",
      outcomeId: "outcome",
      outcomeTitle: "Observed",
      outcomeContent: "Prediction held",
      edge: "validates" as const,
      sourceType: "agent" as const,
    };
    const results = await Promise.all([
      resolver.resolveHypothesis(input),
      resolver.resolveHypothesis(input),
    ]);
    const commits = store.commitLog.length;
    await expect(
      resolver.resolveHypothesis({ ...input, edge: "invalidates" })
    ).rejects.toBeInstanceOf(KnowledgeWriteConflictError);
    await expect(
      resolver.resolveHypothesis({
        ...input,
        outcomeContent: "Different observation",
      })
    ).rejects.toBeInstanceOf(KnowledgeWriteConflictError);
    expect(store.commitLog).toHaveLength(commits);
    expect(results.map((result) => result.alreadyResolved).sort()).toEqual([
      false,
      true,
    ]);
    expect(
      (await store.listCitationsByCitedId("hypothesis")).filter(
        (edge) => edge.citationType === "validates"
      )
    ).toHaveLength(1);
    expect(
      (await store.listKnowledge("meta")).filter(
        (entry) => entry.entryType === "outcome"
      )
    ).toHaveLength(1);
  });
  it("rejects changed hypothesis evidence or decision source on successful request replay", async () => {
    const store = await setup();
    const edo = createEdoCapability(store, new FakeEdoResolverAdapter(store));
    await store.withWrite(
      { operationId: "seed:evidence", message: "seed" },
      async (write) => {
        await write.addKnowledge(ENTRY);
        await write.addKnowledge({ ...ENTRY, id: "other-finding" });
      }
    );
    const hypothesis = {
      id: "hypothesis",
      domain: "meta",
      title: "Prediction",
      content: "Testable",
      evaluateAt: new Date("2026-10-20T00:00:00Z"),
      sourceType: "agent" as const,
      evidenceForIds: [ENTRY.id],
    };
    await edo.hypothesize(hypothesis);
    await edo.hypothesize({ ...hypothesis, id: "other-hypothesis" });
    const decision = {
      id: "decision",
      domain: "meta",
      title: "Act",
      content: "Because",
      sourceType: "agent" as const,
      derivesFromHypothesisId: hypothesis.id,
    };
    const first = await edo.decide(decision);
    const commits = store.commitLog.length;
    expect(await edo.decide(decision)).toEqual(first);
    await expect(
      edo.hypothesize({ ...hypothesis, evidenceForIds: ["other-finding"] })
    ).rejects.toBeInstanceOf(KnowledgeWriteConflictError);
    await expect(
      edo.decide({ ...decision, derivesFromHypothesisId: "other-hypothesis" })
    ).rejects.toBeInstanceOf(KnowledgeWriteConflictError);
    expect(store.commitLog).toHaveLength(commits);
  });
  it("preserves operator sanitization and stored confidence on canonical replay", async () => {
    const store = await setup();
    const input = {
      ...ENTRY,
      confidencePct: 99,
      content: "Fact\u0001\nwith newline",
      title: "Title\u0007",
    };
    const first = await store.withWrite(
      { operationId: "sanitize:replay", message: "sanitize" },
      (write) => write.addKnowledge(input)
    );
    const commits = store.commitLog.length;
    expect(first.content).toBe("Fact\nwith newline");
    expect(first.title).toBe("Title");
    expect(first.confidencePct).toBe(99);
    expect(
      await store.withWrite(
        { operationId: "sanitize:replay", message: "retry" },
        (write) => write.addKnowledge(input)
      )
    ).toEqual(first);
    expect(store.commitLog).toHaveLength(commits);
  });
  it("operator knowledge writes keep outgoing citations in one scope and reject mismatched replay", async () => {
    const store = await setup();
    await store.withWrite(
      { operationId: "seed:targets", message: "seed" },
      async (write) => {
        await write.addKnowledge({ ...ENTRY, id: "target" });
        await write.addKnowledge({ ...ENTRY, id: "other-target" });
      }
    );
    const capability = createKnowledgeCapability(store);
    const input = {
      ...ENTRY,
      id: "write-with-citation",
      confidencePct: 99,
      citations: [
        {
          citedId: "target",
          citationType: "supports" as const,
          context: "Evidence",
        },
      ],
    };
    const before = store.commitLog.length;
    const first = await capability.write(input);
    expect(first.confidencePct).toBe(30);
    expect(store.commitLog).toHaveLength(before + 1);
    expect(await store.listCitationsByCitingId(input.id)).toHaveLength(1);
    expect(await capability.write(input)).toEqual(first);
    await expect(
      capability.write({
        ...input,
        citations: [
          {
            citedId: "other-target",
            citationType: "supports",
            context: "Evidence",
          },
        ],
      })
    ).rejects.toBeInstanceOf(KnowledgeWriteConflictError);
    expect(store.commitLog).toHaveLength(before + 1);
  });
});
