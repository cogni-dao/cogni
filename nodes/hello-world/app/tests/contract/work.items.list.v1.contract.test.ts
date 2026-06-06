// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/work.items.list.v1.contract`
 * Purpose: Validates Zod schemas for work items list contract — DTO shape, input filters, output envelope.
 * Scope: Pure Zod schema validation. Does not test HTTP transport or filesystem.
 * Invariants: WorkItemDtoSchema required fields; input filter constraints; output envelope shape.
 * Side-effects: none
 * Links: src/contracts/work.items.list.v1.contract.ts
 * @internal
 */

import {
  WorkItemDtoSchema,
  workItemsListOperation,
} from "@cogni/node-contracts";
import { describe, expect, it } from "vitest";

const VALID_DTO = {
  id: "task.0001",
  type: "task",
  title: "Test item",
  status: "needs_implement",
  assignees: [],
  externalRefs: [],
  labels: ["test"],
  specRefs: [],
  revision: 0,
  deployVerified: false,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-02",
};

describe("WorkItemDtoSchema", () => {
  it("accepts a valid minimal DTO", () => {
    expect(WorkItemDtoSchema.safeParse(VALID_DTO).success).toBe(true);
  });

  it("accepts a DTO with all optional fields", () => {
    const full = {
      ...VALID_DTO,
      priority: 0,
      rank: 5,
      estimate: 3,
      summary: "A summary",
      outcome: "An outcome",
      projectId: "proj.test",
      parentId: "task.0000",
      branch: "feat/test",
      pr: "https://github.com/org/repo/pull/1",
      reviewer: "derek",
      blockedBy: "task.0002",
      claimedByRun: "run-123",
      claimedAt: "2026-01-01T00:00:00Z",
      lastCommand: "/implement",
    };
    expect(WorkItemDtoSchema.safeParse(full).success).toBe(true);
  });

  it("rejects missing required field: id", () => {
    const { id: _, ...noId } = VALID_DTO;
    expect(WorkItemDtoSchema.safeParse(noId).success).toBe(false);
  });

  it("rejects missing required field: revision", () => {
    const { revision: _, ...noRevision } = VALID_DTO;
    expect(WorkItemDtoSchema.safeParse(noRevision).success).toBe(false);
  });

  it("rejects missing required field: deployVerified", () => {
    const { deployVerified: _, ...noDV } = VALID_DTO;
    expect(WorkItemDtoSchema.safeParse(noDV).success).toBe(false);
  });

  it("accepts user assignee", () => {
    const dto = {
      ...VALID_DTO,
      assignees: [{ kind: "user", userId: "u1" }],
    };
    expect(WorkItemDtoSchema.safeParse(dto).success).toBe(true);
  });

  it("accepts agent assignee", () => {
    const dto = {
      ...VALID_DTO,
      assignees: [{ kind: "agent", agentId: "a1" }],
    };
    expect(WorkItemDtoSchema.safeParse(dto).success).toBe(true);
  });

  it("rejects invalid assignee kind", () => {
    const dto = {
      ...VALID_DTO,
      assignees: [{ kind: "org", orgId: "o1" }],
    };
    expect(WorkItemDtoSchema.safeParse(dto).success).toBe(false);
  });

  it("accepts valid external ref", () => {
    const dto = {
      ...VALID_DTO,
      externalRefs: [
        {
          system: "github",
          kind: "pr",
          externalId: "123",
          url: "https://github.com/org/repo/pull/123",
          title: "PR title",
        },
      ],
    };
    expect(WorkItemDtoSchema.safeParse(dto).success).toBe(true);
  });

  it("rejects non-number priority", () => {
    const dto = { ...VALID_DTO, priority: "high" };
    expect(WorkItemDtoSchema.safeParse(dto).success).toBe(false);
  });
});

describe("workItemsListOperation.input", () => {
  const parseInput = (v: unknown) => workItemsListOperation.input.safeParse(v);

  it("accepts empty object (no filters)", () => {
    expect(parseInput({}).success).toBe(true);
  });

  it("accepts types filter", () => {
    expect(parseInput({ types: ["task", "bug"] }).success).toBe(true);
  });

  it("accepts statuses filter", () => {
    expect(parseInput({ statuses: ["needs_implement", "done"] }).success).toBe(
      true
    );
  });

  it("accepts text search", () => {
    expect(parseInput({ text: "search term" }).success).toBe(true);
  });

  it("accepts projectId filter", () => {
    expect(parseInput({ projectId: "proj.test" }).success).toBe(true);
  });

  it("accepts valid limit", () => {
    expect(parseInput({ limit: 50 }).success).toBe(true);
  });

  it("rejects limit over 500", () => {
    expect(parseInput({ limit: 501 }).success).toBe(false);
  });

  it("rejects limit of 0", () => {
    expect(parseInput({ limit: 0 }).success).toBe(false);
  });

  it("rejects negative limit", () => {
    expect(parseInput({ limit: -1 }).success).toBe(false);
  });

  it("rejects non-integer limit", () => {
    expect(parseInput({ limit: 1.5 }).success).toBe(false);
  });
});

describe("workItemsListOperation.output", () => {
  const parseOutput = (v: unknown) =>
    workItemsListOperation.output.safeParse(v);

  it("accepts valid output with items", () => {
    expect(parseOutput({ items: [VALID_DTO] }).success).toBe(true);
  });

  it("accepts empty items array", () => {
    expect(parseOutput({ items: [] }).success).toBe(true);
  });

  it("accepts output with nextCursor", () => {
    expect(parseOutput({ items: [], nextCursor: "cursor-abc" }).success).toBe(
      true
    );
  });

  it("rejects missing items", () => {
    expect(parseOutput({}).success).toBe(false);
  });
});
