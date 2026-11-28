// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import {
  type Citation,
  createEdoCapability,
  type Knowledge,
  type KnowledgeStorePort,
} from "@cogni/knowledge-store";
import { DoltgresEdoResolverAdapter } from "@cogni/knowledge-store/adapters/doltgres";
import { createRunAttribution } from "@cogni/work-items";
import { type AgentGrantsStore, guardTools } from "@cogni-dao/agent-grants";
import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";
import { createOperatorEdoTools } from "@/bootstrap/edo-confidence";

/** Fake ports only: the released factory, resolver, attribution and guard all execute. */
function port<T extends object>(methods: Partial<T>): T {
  return new Proxy(methods, {
    get(target, name) {
      if (!(name in target))
        throw new Error(`Unexpected port method: ${String(name)}`);
      return Reflect.get(target, name);
    },
  }) as T;
}

function fixture() {
  const rows = new Map<string, Knowledge>();
  const edges: Citation[] = [];
  const commits: string[] = [];
  const store: KnowledgeStorePort = port<KnowledgeStorePort>({
    getKnowledge: async (id) => rows.get(id) ?? null,
    withWrite: async (input, run) => {
      const result = await run(store);
      commits.push(input.message);
      return result;
    },
    addKnowledge: async (entry) => {
      rows.set(entry.id, entry);
      return entry;
    },
    updateKnowledge: async (id, update) => {
      const entry = rows.get(id);
      if (!entry) throw new Error("missing fixture row");
      const updated = { ...entry, ...update };
      rows.set(id, updated);
      return updated;
    },
    addCitation: async (edge) => {
      const citation = { ...edge, id: `edge-${edges.length}` };
      edges.push(citation);
      return citation;
    },
    listCitationsByCitingId: async (id) =>
      edges.filter((e) => e.citingId === id),
    listCitationsByCitedId: async (id) => edges.filter((e) => e.citedId === id),
  });
  // These three resolver operations use only the store port; any SQL access fails.
  const sql = port<Sql>({});
  const identity: {
    principalId?: string;
    subjectUserId: string;
    runId: string;
    runKind: "system_scheduled";
  } = {
    principalId: "node-ai",
    subjectUserId: "requester",
    runId: "run-edo",
    runKind: "system_scheduled",
  };
  const tools = createOperatorEdoTools(
    createEdoCapability(store, new DoltgresEdoResolverAdapter({ sql, store })),
    createRunAttribution({ scope: () => identity })
  );
  return { tools, rows, edges, commits, identity };
}

const clean = "# 日本語 café 🧭\r\n\t- Markdown\n";
const dirty = `\u0000\u0001${clean}\u0008\u000b\u000c\u001b\u001f\u007f`;
const text = {
  actor: "payload-attacker",
  attribution: { actor: "payload-attacker" },
  domain: "strategy",
  title: dirty,
  content: dirty,
  sourceType: "external" as const,
};
const hypothesis = {
  ...text,
  id: "hypothesis-parity",
  evaluateAt: new Date("2027-01-01"),
};

describe("operator EDO composition over released 0.27", () => {
  it("sanitizes all three writes before released mapping; preserves source confidence, citations and host commit attribution", async () => {
    const f = fixture();
    const h = await f.tools.hypothesize({ ...hypothesis, confidencePct: 99 });
    const d = await f.tools.decide({
      ...text,
      id: "decision-parity",
      derivesFromHypothesisId: h.id,
      confidencePct: 99,
    });
    const o = await f.tools.recordOutcome({
      ...text,
      id: "outcome-parity",
      hypothesisId: h.id,
      edge: "validates",
    });
    for (const entry of [h, d, o.outcome]) {
      expect(entry).toMatchObject({
        title: clean,
        content: clean,
        confidencePct: 50,
        sourceType: "external",
      });
    }
    expect(f.edges.map((edge) => edge.citationType)).toEqual([
      "derives_from",
      "validates",
    ]);
    expect(o).toMatchObject({ resolvedConfidence: 60, alreadyResolved: false });
    for (const message of f.commits) {
      expect(message).toContain(
        "by actor:node-ai\nRequested-by: requester\nRun: run-edo system_scheduled"
      );
    }
    const replay = await f.tools.recordOutcome({
      ...text,
      title: clean,
      content: clean,
      id: o.outcome.id,
      hypothesisId: h.id,
      edge: "validates",
    });
    expect(replay.alreadyResolved).toBe(true);
    await expect(
      f.tools.recordOutcome({
        ...text,
        content: "changed",
        id: o.outcome.id,
        hypothesisId: h.id,
        edge: "validates",
      })
    ).rejects.toThrow("different content");
  });

  it("reads host attribution per call and refuses missing principals or forged commit lines before any write", async () => {
    const f = fixture();
    delete f.identity.principalId;
    for (const call of [
      () => f.tools.hypothesize(hypothesis),
      () =>
        f.tools.decide({
          ...text,
          id: "decision",
          derivesFromHypothesisId: hypothesis.id,
        }),
      () =>
        f.tools.recordOutcome({
          ...text,
          id: "outcome",
          hypothesisId: hypothesis.id,
          edge: "validates",
        }),
    ])
      await expect(call()).rejects.toThrow();
    expect(f.rows.size).toBe(0);
    expect(f.commits).toEqual([]);
    f.identity.principalId = "node-ai\nforged";
    await expect(f.tools.hypothesize(hypothesis)).rejects.toThrow();
    expect(f.rows.size).toBe(0);
    f.identity.principalId = "node-ai";
    await expect(
      f.tools.hypothesize({ ...hypothesis, id: "forged\nby actor:other" })
    ).rejects.toThrow();
    expect(f.rows.size).toBe(0);
  });

  it("keeps the real principal guard before the composed writer, including revocation", async () => {
    const f = fixture();
    let allowed = false;
    const grants = port<AgentGrantsStore>({ hasLiveRole: async () => allowed });
    const guarded = guardTools(
      {
        write: {
          id: "write",
          effect: "write",
          exec: async () => f.tools.hypothesize(hypothesis),
        },
      },
      { write: { scope: "knowledge:write", kind: "node", subject: "member" } },
      f.identity,
      {
        withStore: async (run) => run(grants),
        adminCheck: async () => "denied",
      }
    );
    const write = guarded.write;
    if (!write) throw new Error("Guard must retain the declared tool");
    await expect(write.exec()).rejects.toThrow();
    expect(f.rows.size).toBe(0);
    allowed = true;
    await write.exec();
    allowed = false;
    const count = f.commits.length;
    await expect(write.exec()).rejects.toThrow();
    expect(f.commits).toHaveLength(count);
  });
});
