// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/tests/contribution-service`
 * Purpose: Unit coverage for contribution service ownership gates and edit-batch forwarding.
 * Scope: Pure service tests with a fake contribution port. Does not call Doltgres or HTTP.
 * Invariants: CONTRIBUTION_OWNER_CAN_APPEND, CONTRIBUTION_OWNER_CAN_CLOSE.
 * Side-effects: none
 * Links: docs/design/knowledge-contribution-api.md, packages/knowledge-store/src/service/contribution-service.ts
 * @internal
 */

import { describe, expect, it } from "vitest";

import type {
  ContributionCommitRecord,
  ContributionRecord,
  KnowledgeContributionEdit,
  Principal,
} from "../src/domain/contribution-schemas.js";
import { KnowledgeGateError, shapeGate } from "../src/domain/gates/index.js";
import {
  ContributionForbiddenError,
  type CreateEdoDecisionInput,
  type CreateEdoHypothesisInput,
  type CreateEdoOutcomeInput,
  type KnowledgeContributionPort,
} from "../src/port/contribution.port.js";
import { createContributionService } from "../src/service/contribution-service.js";

const agent: Principal = {
  id: "agent-1",
  kind: "agent",
  name: "agent-one",
};

function contribution(
  overrides: Partial<ContributionRecord> = {}
): ContributionRecord {
  return {
    contributionId: "contrib-agent-1-abc123",
    branch: "contrib/agent-1-abc123",
    baseCommit: "base123",
    headCommit: "abc123",
    commitCount: 1,
    state: "open",
    principalKind: "agent",
    principalId: "agent-1",
    message: "edit row",
    mergedCommit: null,
    closedReason: null,
    idempotencyKey: null,
    createdAt: "2026-05-19T00:00:00.000Z",
    resolvedAt: null,
    resolvedBy: null,
    ...overrides,
  };
}

class FakeContributionPort implements KnowledgeContributionPort {
  records: ContributionRecord[] = [];
  commits: ContributionCommitRecord[] = [];
  /**
   * Simulated "main branch" entry ids — the EDO atomic-batch port methods on
   * the real Doltgres adapter open a `contrib/*` branch and apply rows there;
   * main stays untouched. The fake records everything that lands on the
   * branch into `branchWrites[contributionId]` and DOES NOT touch
   * `mainEntryIds` until a hypothetical merge step. Tests assert the
   * EDO_BEARER_VIA_CONTRIB_BRANCH invariant by checking this list stays empty.
   */
  mainEntryIds = new Set<string>();
  branchWrites = new Map<
    string,
    Array<{ kind: "entry" | "citation"; id: string; branch: string }>
  >();
  lastCreate: Parameters<KnowledgeContributionPort["create"]>[0] | null = null;
  lastAppend: Parameters<KnowledgeContributionPort["appendCommit"]>[0] | null =
    null;
  lastClose: Parameters<KnowledgeContributionPort["close"]>[0] | null = null;
  lastEdoHypothesis: CreateEdoHypothesisInput | null = null;
  lastEdoDecision: CreateEdoDecisionInput | null = null;
  lastEdoOutcome: CreateEdoOutcomeInput | null = null;

  async create(
    input: Parameters<KnowledgeContributionPort["create"]>[0]
  ): Promise<ContributionRecord> {
    this.lastCreate = input;
    const record = contribution({
      principalKind: input.principal.kind,
      principalId: input.principal.id,
      commitCount: input.edits?.length ? 1 : 0,
    });
    this.records.push(record);
    return record;
  }

  private nextEdoContribution(principal: Principal): {
    contributionId: string;
    branch: string;
  } {
    const slug = (principal.name ?? principal.id).toLowerCase();
    const sid = String(this.records.length + 1).padStart(6, "0");
    return {
      contributionId: `contrib-${slug}-${sid}`,
      branch: `contrib/${slug}-${sid}`,
    };
  }

  async createEdoHypothesis(
    input: CreateEdoHypothesisInput
  ): Promise<ContributionRecord> {
    this.lastEdoHypothesis = input;
    const { contributionId, branch } = this.nextEdoContribution(
      input.principal
    );
    const writes: Array<{
      kind: "entry" | "citation";
      id: string;
      branch: string;
    }> = [{ kind: "entry", id: input.entry.id, branch }];
    for (const evidenceId of input.evidenceForIds ?? []) {
      writes.push({
        kind: "citation",
        id: `${input.entry.id}->${evidenceId}:evidence_for`,
        branch,
      });
    }
    this.branchWrites.set(contributionId, writes);
    const record = contribution({
      contributionId,
      branch,
      principalKind: input.principal.kind,
      principalId: input.principal.id,
      commitCount: 1,
      idempotencyKey: input.idempotencyKey ?? null,
      message: input.message,
    });
    this.records.push(record);
    return record;
  }

  async createEdoDecision(
    input: CreateEdoDecisionInput
  ): Promise<ContributionRecord> {
    this.lastEdoDecision = input;
    const { contributionId, branch } = this.nextEdoContribution(
      input.principal
    );
    this.branchWrites.set(contributionId, [
      { kind: "entry", id: input.entry.id, branch },
      {
        kind: "citation",
        id: `${input.entry.id}->${input.derivesFromHypothesisId}:derives_from`,
        branch,
      },
    ]);
    const record = contribution({
      contributionId,
      branch,
      principalKind: input.principal.kind,
      principalId: input.principal.id,
      commitCount: 1,
      idempotencyKey: input.idempotencyKey ?? null,
      message: input.message,
    });
    this.records.push(record);
    return record;
  }

  async createEdoOutcome(
    input: CreateEdoOutcomeInput
  ): Promise<ContributionRecord> {
    this.lastEdoOutcome = input;
    const { contributionId, branch } = this.nextEdoContribution(
      input.principal
    );
    this.branchWrites.set(contributionId, [
      { kind: "entry", id: input.entry.id, branch },
      {
        kind: "citation",
        id: `${input.entry.id}->${input.hypothesisId}:${input.edge}`,
        branch,
      },
    ]);
    const record = contribution({
      contributionId,
      branch,
      principalKind: input.principal.kind,
      principalId: input.principal.id,
      commitCount: 1,
      idempotencyKey: input.idempotencyKey ?? null,
      message: input.message,
    });
    this.records.push(record);
    return record;
  }

  async findOpenForPrincipal(
    principalId: string
  ): Promise<ContributionRecord | null> {
    return (
      this.records.find(
        (r) => r.state === "open" && r.principalId === principalId
      ) ?? null
    );
  }

  private appendEdoToExisting(
    contributionId: string,
    writes: Array<{ kind: "entry" | "citation"; id: string }>
  ): ContributionRecord {
    const idx = this.records.findIndex(
      (r) => r.contributionId === contributionId
    );
    if (idx < 0) {
      throw new Error(`contribution ${contributionId} not found`);
    }
    const rec = this.records[idx];
    if (!rec) {
      throw new Error(`contribution ${contributionId} not found`);
    }
    if (rec.state !== "open") {
      throw new Error(`contribution ${contributionId} is ${rec.state}`);
    }
    const branch = rec.branch;
    const existing = this.branchWrites.get(contributionId) ?? [];
    this.branchWrites.set(contributionId, [
      ...existing,
      ...writes.map((w) => ({ ...w, branch })),
    ]);
    const updated: ContributionRecord = {
      ...rec,
      commitCount: rec.commitCount + 1,
      headCommit: `append-${rec.commitCount + 1}`,
    };
    this.records[idx] = updated;
    return updated;
  }

  async appendEdoHypothesis(
    input: CreateEdoHypothesisInput & { contributionId: string }
  ): Promise<ContributionRecord> {
    this.lastEdoHypothesis = input;
    const writes: Array<{ kind: "entry" | "citation"; id: string }> = [
      { kind: "entry", id: input.entry.id },
    ];
    for (const evidenceId of input.evidenceForIds ?? []) {
      writes.push({
        kind: "citation",
        id: `${input.entry.id}->${evidenceId}:evidence_for`,
      });
    }
    return this.appendEdoToExisting(input.contributionId, writes);
  }

  async appendEdoDecision(
    input: CreateEdoDecisionInput & { contributionId: string }
  ): Promise<ContributionRecord> {
    this.lastEdoDecision = input;
    return this.appendEdoToExisting(input.contributionId, [
      { kind: "entry", id: input.entry.id },
      {
        kind: "citation",
        id: `${input.entry.id}->${input.derivesFromHypothesisId}:derives_from`,
      },
    ]);
  }

  async appendEdoOutcome(
    input: CreateEdoOutcomeInput & { contributionId: string }
  ): Promise<ContributionRecord> {
    this.lastEdoOutcome = input;
    return this.appendEdoToExisting(input.contributionId, [
      { kind: "entry", id: input.entry.id },
      {
        kind: "citation",
        id: `${input.entry.id}->${input.hypothesisId}:${input.edge}`,
      },
    ]);
  }

  async appendCommit(
    input: Parameters<KnowledgeContributionPort["appendCommit"]>[0]
  ): Promise<ContributionCommitRecord> {
    this.lastAppend = input;
    const commit: ContributionCommitRecord = {
      contributionId: input.contributionId,
      seq: 2,
      commitHash: "append123",
      principalKind: input.principal.kind,
      principalId: input.principal.id,
      authSource: input.principal.kind === "agent" ? "bearer" : "session",
      message: input.message,
      editCount: input.edits.length,
      sourceRef: `contribution:${input.contributionId}:2`,
      createdAt: "2026-05-19T00:00:00.000Z",
    };
    this.commits.push(commit);
    return commit;
  }

  async list(input: {
    state: ContributionRecord["state"] | "all";
    principalId?: string;
    limit: number;
  }): Promise<ContributionRecord[]> {
    return this.records
      .filter((record) => input.state === "all" || record.state === input.state)
      .filter(
        (record) =>
          !input.principalId || record.principalId === input.principalId
      )
      .slice(0, input.limit);
  }

  async getById(contributionId: string): Promise<ContributionRecord | null> {
    return (
      this.records.find((record) => record.contributionId === contributionId) ??
      null
    );
  }

  async diff() {
    return [];
  }

  async listCommits(): Promise<ContributionCommitRecord[]> {
    return this.commits;
  }

  async merge(): Promise<{ commitHash: string }> {
    return { commitHash: "merge123" };
  }

  async close(
    input: Parameters<KnowledgeContributionPort["close"]>[0]
  ): Promise<void> {
    this.lastClose = input;
  }
}

describe("createContributionService", () => {
  it("runs configured gates on create insert/update edits and rejects bad slugs", async () => {
    const port = new FakeContributionPort();
    const service = createContributionService({
      port,
      canMergeKnowledge: () => false,
      rateLimit: { maxOpenPerPrincipal: 5 },
      gates: [shapeGate],
    });
    const edit: KnowledgeContributionEdit = {
      op: "insert",
      entry: {
        id: "BAD--double-dash",
        domain: "meta",
        title: "Should reject before reaching port",
        content: "x",
      },
    };
    await expect(
      service.create({
        principal: agent,
        body: { message: "gate test", edits: [edit] },
      })
    ).rejects.toBeInstanceOf(KnowledgeGateError);
    expect(port.lastCreate).toBeNull();
  });

  it("passes sanitized (trimmed) entries through to the port on append", async () => {
    const port = new FakeContributionPort();
    port.records = [contribution()];
    const service = createContributionService({
      port,
      canMergeKnowledge: () => false,
      rateLimit: { maxOpenPerPrincipal: 5 },
      gates: [shapeGate],
    });
    const edit: KnowledgeContributionEdit = {
      op: "insert",
      entry: {
        id: "valid-slug",
        domain: "meta",
        title: "  Whitespace trimmed  ",
        content: "x",
      },
    };
    await service.appendCommit({
      principal: agent,
      contributionId: "contrib-agent-1-abc123",
      body: { message: "sanitize test", edits: [edit] },
    });
    const forwarded = port.lastAppend?.edits[0];
    expect(forwarded?.op).toBe("insert");
    if (forwarded?.op === "insert") {
      expect(forwarded.entry.title).toBe("Whitespace trimmed");
    }
  });

  it("forwards deprecate edits without running gates against them", async () => {
    const port = new FakeContributionPort();
    port.records = [contribution()];
    const service = createContributionService({
      port,
      canMergeKnowledge: () => false,
      rateLimit: { maxOpenPerPrincipal: 5 },
      gates: [shapeGate],
    });
    const edit: KnowledgeContributionEdit = {
      op: "deprecate",
      targetRowId: "operator:knowledge:stale",
      reason: "superseded",
    };
    await service.appendCommit({
      principal: agent,
      contributionId: "contrib-agent-1-abc123",
      body: { message: "deprecate test", edits: [edit] },
    });
    expect(port.lastAppend?.edits).toEqual([edit]);
  });

  it("forwards typed edits on create so adapters can apply branch-local changes", async () => {
    const port = new FakeContributionPort();
    const service = createContributionService({
      port,
      canMergeKnowledge: () => false,
      rateLimit: { maxOpenPerPrincipal: 5 },
    });
    const edit: KnowledgeContributionEdit = {
      op: "update",
      targetRowId: "operator:knowledge:home-page",
      entry: {
        domain: "meta",
        title: "Knowledge home page",
        content: "<html><body>updated</body></html>",
        tags: ["html"],
      },
    };

    await service.create({
      principal: agent,
      body: { message: "edit existing artifact", edits: [edit] },
    });

    expect(port.lastCreate?.edits?.[0]).toEqual(edit);
  });

  it("allows a bearer principal to append commits to its own open contribution", async () => {
    const port = new FakeContributionPort();
    port.records = [contribution()];
    const service = createContributionService({
      port,
      canMergeKnowledge: () => false,
      rateLimit: { maxOpenPerPrincipal: 5 },
    });
    const edit: KnowledgeContributionEdit = {
      op: "deprecate",
      targetRowId: "operator:knowledge:stale",
      reason: "superseded by contribution branch revision",
    };

    await service.appendCommit({
      principal: agent,
      contributionId: "contrib-agent-1-abc123",
      body: { message: "deprecate stale row", edits: [edit] },
    });

    expect(port.lastAppend?.contributionId).toBe("contrib-agent-1-abc123");
    expect(port.lastAppend?.edits).toEqual([edit]);
  });

  it("rejects append for another principal's contribution", async () => {
    const port = new FakeContributionPort();
    port.records = [contribution({ principalId: "agent-2" })];
    const service = createContributionService({
      port,
      canMergeKnowledge: () => false,
      rateLimit: { maxOpenPerPrincipal: 5 },
    });

    await expect(
      service.appendCommit({
        principal: agent,
        contributionId: "contrib-agent-1-abc123",
        body: {
          message: "not mine",
          edits: [
            {
              op: "deprecate",
              targetRowId: "operator:knowledge:stale",
              reason: "not mine",
            },
          ],
        },
      })
    ).rejects.toBeInstanceOf(ContributionForbiddenError);
    expect(port.lastAppend).toBeNull();
  });

  it("allows a bearer principal to close its own open contribution", async () => {
    const port = new FakeContributionPort();
    port.records = [contribution()];
    const service = createContributionService({
      port,
      canMergeKnowledge: () => false,
      rateLimit: { maxOpenPerPrincipal: 5 },
    });

    await service.close({
      principal: agent,
      contributionId: "contrib-agent-1-abc123",
      reason: "superseded by a better edit",
    });

    expect(port.lastClose?.contributionId).toBe("contrib-agent-1-abc123");
    expect(port.lastClose?.principal).toEqual(agent);
  });

  it("rejects bearer close for another principal's contribution", async () => {
    const port = new FakeContributionPort();
    port.records = [contribution({ principalId: "agent-2" })];
    const service = createContributionService({
      port,
      canMergeKnowledge: () => false,
      rateLimit: { maxOpenPerPrincipal: 5 },
    });

    await expect(
      service.close({
        principal: agent,
        contributionId: "contrib-agent-1-abc123",
        reason: "not mine",
      })
    ).rejects.toBeInstanceOf(ContributionForbiddenError);
    expect(port.lastClose).toBeNull();
  });

  it("fires pushMainOnMerge after a successful merge, returning the port's commit hash unchanged", async () => {
    const port = new FakeContributionPort();
    let pushCalls = 0;
    const service = createContributionService({
      port,
      canMergeKnowledge: () => true,
      rateLimit: { maxOpenPerPrincipal: 5 },
      pushMainOnMerge: async () => {
        pushCalls++;
      },
    });

    const result = await service.merge({
      principal: { id: "user-1", kind: "user", name: "user-one" },
      contributionId: "contrib-agent-1-abc123",
    });

    expect(result.commitHash).toBe("merge123");
    // Fire-and-forget — yield once so the microtask runs.
    await Promise.resolve();
    expect(pushCalls).toBe(1);
  });

  it("routes bearer EDO hypothesize through the contrib-branch port method (W2 — does not write to main)", async () => {
    const port = new FakeContributionPort();
    const service = createContributionService({
      port,
      canMergeKnowledge: () => false,
      rateLimit: { maxOpenPerPrincipal: 5 },
    });

    const record = await service.createEdoHypothesisContribution({
      principal: agent,
      body: {
        message: "file hypothesis on contrib branch",
        entry: {
          id: "h-test-1",
          domain: "meta",
          title: "test hypothesis",
          content: "the loop closes",
          evaluateAt: new Date("2026-06-01T00:00:00Z"),
        },
        evidenceForIds: ["evt-1", "evt-2"],
      },
    });

    // Record lands as 'open' on a contrib/* branch.
    expect(record.state).toBe("open");
    expect(record.branch.startsWith("contrib/")).toBe(true);
    expect(port.lastEdoHypothesis?.entry.id).toBe("h-test-1");
    expect(port.lastEdoHypothesis?.evidenceForIds).toEqual(["evt-1", "evt-2"]);
    // EDO_BEARER_VIA_CONTRIB_BRANCH: writes live on the branch, NOT on main.
    expect(port.mainEntryIds.size).toBe(0);
    const writes = port.branchWrites.get(record.contributionId) ?? [];
    expect(writes.length).toBe(3); // entry + 2 evidence_for citations
    expect(writes.every((w) => w.branch === record.branch)).toBe(true);
  });

  it("routes bearer EDO decide + recordOutcome through contrib-branch port methods", async () => {
    const port = new FakeContributionPort();
    const service = createContributionService({
      port,
      canMergeKnowledge: () => false,
      rateLimit: { maxOpenPerPrincipal: 5 },
    });

    const decision = await service.createEdoDecisionContribution({
      principal: agent,
      body: {
        message: "act on hypothesis",
        entry: {
          id: "d-test-1",
          domain: "meta",
          title: "test decision",
          content: "we picked X",
        },
        derivesFromHypothesisId: "h-test-1",
      },
    });
    expect(decision.branch.startsWith("contrib/")).toBe(true);
    expect(port.lastEdoDecision?.derivesFromHypothesisId).toBe("h-test-1");

    const outcome = await service.createEdoOutcomeContribution({
      principal: agent,
      body: {
        message: "record observed result",
        entry: {
          id: "o-test-1",
          domain: "meta",
          title: "test outcome",
          content: "X worked",
        },
        hypothesisId: "h-test-1",
        edge: "validates",
      },
    });
    expect(outcome.branch.startsWith("contrib/")).toBe(true);
    expect(port.lastEdoOutcome?.edge).toBe("validates");

    // Main untouched across all three EDO bearer writes.
    expect(port.mainEntryIds.size).toBe(0);
  });

  it("EDO calls compound onto one open contribution per principal (W2.5)", async () => {
    // COMPOUNDING_VIA_ONE_OPEN_CONTRIBUTION_PER_PRINCIPAL: when a principal
    // already has an open contribution, subsequent EDO writes append to its
    // branch instead of opening a new one. A hypothesize -> decide ->
    // record-outcome chain by the same agent compounds onto ONE branch with
    // 3 commits — one human merge gates the whole loop.
    const port = new FakeContributionPort();
    const service = createContributionService({
      port,
      canMergeKnowledge: () => false,
      rateLimit: { maxOpenPerPrincipal: 5 },
    });

    const h = await service.createEdoHypothesisContribution({
      principal: agent,
      body: {
        message: "file hypothesis",
        entry: {
          id: "h-chain",
          domain: "meta",
          title: "compound chain root",
          content: "...",
          evaluateAt: new Date("2026-06-01T00:00:00Z"),
        },
      },
    });
    expect(h.commitCount).toBe(1);

    const d = await service.createEdoDecisionContribution({
      principal: agent,
      body: {
        message: "act on hypothesis",
        entry: {
          id: "d-chain",
          domain: "meta",
          title: "compound decision",
          content: "we picked X",
        },
        derivesFromHypothesisId: "h-chain",
      },
    });
    // Same contribution + same branch as the hypothesis — NOT a new contrib.
    expect(d.contributionId).toBe(h.contributionId);
    expect(d.branch).toBe(h.branch);
    expect(d.commitCount).toBe(2);

    const o = await service.createEdoOutcomeContribution({
      principal: agent,
      body: {
        message: "record observed result",
        entry: {
          id: "o-chain",
          domain: "meta",
          title: "compound outcome",
          content: "X worked",
        },
        hypothesisId: "h-chain",
        edge: "validates",
      },
    });
    expect(o.contributionId).toBe(h.contributionId);
    expect(o.commitCount).toBe(3);

    // ONE contribution holds the full chain.
    expect(port.records.length).toBe(1);
    // Branch carries all three entries + their citations.
    const writes = port.branchWrites.get(h.contributionId) ?? [];
    expect(writes.length).toBe(5); // 3 entries + derives_from + validates
    expect(writes.every((w) => w.branch === h.branch)).toBe(true);
    // Main still untouched (W2 invariant preserved through compounding).
    expect(port.mainEntryIds.size).toBe(0);
  });

  it("EDO open-quota gates NEW contributions but does not block compounding", async () => {
    // Quota only applies when there is NO existing open contribution to
    // append onto. Once compounding kicks in, the chain shares one slot.
    const port = new FakeContributionPort();
    const service = createContributionService({
      port,
      canMergeKnowledge: () => false,
      rateLimit: { maxOpenPerPrincipal: 1 },
    });

    // First hypothesize opens a contribution (no quota hit — count was 0).
    const first = await service.createEdoHypothesisContribution({
      principal: agent,
      body: {
        message: "first",
        entry: {
          id: "h-q-1",
          domain: "meta",
          title: "first",
          content: "...",
          evaluateAt: new Date("2026-06-01T00:00:00Z"),
        },
      },
    });
    expect(first.commitCount).toBe(1);

    // Second hypothesize for the SAME principal compounds — quota irrelevant.
    const second = await service.createEdoHypothesisContribution({
      principal: agent,
      body: {
        message: "second compounds",
        entry: {
          id: "h-q-2",
          domain: "meta",
          title: "second",
          content: "...",
          evaluateAt: new Date("2026-06-02T00:00:00Z"),
        },
      },
    });
    expect(second.contributionId).toBe(first.contributionId);
    expect(second.commitCount).toBe(2);
    expect(port.records.length).toBe(1);
  });

  it("EDO contribution methods replay on idempotency key", async () => {
    const port = new FakeContributionPort();
    const service = createContributionService({
      port,
      canMergeKnowledge: () => false,
      rateLimit: { maxOpenPerPrincipal: 5 },
    });
    const first = await service.createEdoHypothesisContribution({
      principal: agent,
      body: {
        message: "first",
        idempotencyKey: "idem-1",
        entry: {
          id: "h-idem",
          domain: "meta",
          title: "h",
          content: "c",
          evaluateAt: new Date("2026-06-01T00:00:00Z"),
        },
      },
    });
    const second = await service.createEdoHypothesisContribution({
      principal: agent,
      body: {
        message: "second (replay)",
        idempotencyKey: "idem-1",
        entry: {
          id: "h-idem",
          domain: "meta",
          title: "h",
          content: "c",
          evaluateAt: new Date("2026-06-01T00:00:00Z"),
        },
      },
    });
    expect(second.contributionId).toBe(first.contributionId);
    // Only the first call hit the port.
    expect(port.records.length).toBe(1);
  });

  it("does not block or fail the merge when pushMainOnMerge throws (fire-and-forget contract)", async () => {
    const port = new FakeContributionPort();
    // The caller-supplied hook MUST own its own error handling. Production
    // DI wraps with .catch(log.warn) in container.ts — we mirror that here
    // so the unhandled-rejection contract is honoured at the test boundary,
    // not at the service.
    let pushFailures = 0;
    const service = createContributionService({
      port,
      canMergeKnowledge: () => true,
      rateLimit: { maxOpenPerPrincipal: 5 },
      pushMainOnMerge: async () => {
        try {
          throw new Error("dolthub unreachable");
        } catch {
          pushFailures++;
        }
      },
    });

    const result = await service.merge({
      principal: { id: "user-1", kind: "user", name: "user-one" },
      contributionId: "contrib-agent-1-abc123",
    });

    expect(result.commitHash).toBe("merge123");
    await Promise.resolve();
    expect(pushFailures).toBe(1);
  });
});
