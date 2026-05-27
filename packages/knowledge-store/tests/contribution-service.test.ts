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
  lastCreate: Parameters<KnowledgeContributionPort["create"]>[0] | null = null;
  lastAppend: Parameters<KnowledgeContributionPort["appendCommit"]>[0] | null =
    null;
  lastClose: Parameters<KnowledgeContributionPort["close"]>[0] | null = null;

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
});
