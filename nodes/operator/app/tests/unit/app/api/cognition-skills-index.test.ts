// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/cognition-skills-index`
 * Purpose: Regression coverage for the complete cognition actionable index.
 * Scope: Pure loader plus in-memory knowledge adapter; no route, network, or database.
 * Invariants: ACTIONABLE_INDEX_IS_UNBOUNDED_BY_DOMAIN_PAGE.
 * Side-effects: none
 * Links: src/app/api/v1/cognition/_skills-index.ts, bug.5350
 * @internal
 */

import { FakeKnowledgeStoreAdapter } from "@cogni/knowledge-store/adapters/fake";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COGNITION_SKILL_ENTRY_TYPES,
  loadCognitionSkillsIndex,
} from "@/app/api/v1/cognition/_skills-index";

afterEach(() => vi.useRealTimers());

describe("loadCognitionSkillsIndex", () => {
  it("indexes every actionable type even beyond each domain browse limit", async () => {
    vi.useFakeTimers();
    const store = new FakeKnowledgeStoreAdapter();
    await store.registerDomain({ id: "operator", name: "Operator" });
    await store.registerDomain({ id: "nodes", name: "Nodes" });

    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    await store.addKnowledge({
      id: "old-skill",
      domain: "operator",
      title: "Old skill",
      content: "Still actionable.",
      entryType: "skill",
      sourceType: "agent",
    });
    await store.addKnowledge({
      id: "old-playbook",
      domain: "operator",
      title: "Old playbook",
      content: "Still actionable.",
      entryType: "playbook",
      sourceType: "agent",
    });
    await store.addKnowledge({
      id: "old-guide",
      domain: "nodes",
      title: "Old guide",
      content: "Still actionable.",
      entryType: "guide",
      sourceType: "agent",
    });

    vi.setSystemTime(new Date("2026-02-01T00:00:00.000Z"));
    for (const domain of ["operator", "nodes"] as const) {
      for (let index = 0; index < 55; index += 1) {
        await store.addKnowledge({
          id: `${domain}-newer-finding-${index}`,
          domain,
          title: `Newer finding ${index}`,
          content: "Not an actionable cognition entry.",
          entryType: "finding",
          sourceType: "agent",
        });
      }
      const browsePage = await store.listKnowledge(domain, { limit: 50 });
      expect(browsePage.some((row) => row.id.startsWith("old-"))).toBe(false);
    }

    const result = await loadCognitionSkillsIndex(store);

    expect(COGNITION_SKILL_ENTRY_TYPES).toEqual(["skill", "guide", "playbook"]);
    expect(result).toEqual([
      {
        id: "old-guide",
        domain: "nodes",
        title: "Old guide",
        entryType: "guide",
      },
      {
        id: "old-playbook",
        domain: "operator",
        title: "Old playbook",
        entryType: "playbook",
      },
      {
        id: "old-skill",
        domain: "operator",
        title: "Old skill",
        entryType: "skill",
      },
    ]);
  });
});
