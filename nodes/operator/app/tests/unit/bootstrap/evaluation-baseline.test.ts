// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/evaluation-baseline`
 * Purpose: Exercise released tools at the real operator composition and HTTP read boundaries.
 * Scope: Real catalogs, runtime, runner, facade and released schemas; I/O ports are fakes.
 * Invariants: HOST_POLICY_PRESERVED; AUTHZ_BEFORE_EXEC; READ_PARITY; NO_UNATTRIBUTED_NEW_WRITER.
 * Side-effects: none
 * Links: src/bootstrap/ai/evaluation-baseline.ts, hub adopt-node-package-release
 * @internal
 */
import { createRequire } from "node:module";
import { createToolAllowlistPolicy, createToolRunner } from "@cogni/ai-core";
import {
  CORE_TOOL_BUNDLE,
  TOOL_CATALOG,
  VCS_TOOL_BUNDLE,
} from "@cogni/ai-tools";
import {
  createEdoDecideImplementation,
  createWorkItemUpdateImplementation,
  edoDecideContract,
  workItemUpdateContract,
} from "@cogni/shared-ai-tools";
import {
  ARTIFACT_REFS_PAGE,
  createItemRefPorts,
  HISTORY_REFS_PAGE,
  toWorkItemDto,
  type WorkItem,
  type WorkItemArtifactStore,
  type WorkItemId,
} from "@cogni/work-items";

const { AIMessage, ToolMessage } = createRequire(
  new URL(
    "../../../../../../packages/langgraph-graphs/package.json",
    import.meta.url
  )
)("@langchain/core/messages");

import { describe, expect, it, vi } from "vitest";
import { getWorkItem } from "@/app/_facades/work/items.server";
import { OPERATOR_CORE_TOOL_BUNDLE } from "@/bootstrap/ai/evaluation-baseline";
import {
  createToolBindings,
  type ToolBindingDeps,
} from "@/bootstrap/ai/tool-bindings";
import { createBoundToolSource } from "@/bootstrap/ai/tool-source.factory";
import { createCitationLinksPort } from "@/bootstrap/capabilities/citation-links";
import { createWorkItemCapability } from "@/bootstrap/capabilities/work-item";
import { OPERATING_REVIEW_TOOL_IDS } from "../../../../../../packages/langgraph-graphs/src/graphs/operator/tools";
import {
  cycleScores,
  cycleTelemetry,
} from "../../../../../../packages/langgraph-graphs/src/graphs/work-prioritizer/graph";
import { WORK_PRIORITIZER_TOOL_IDS } from "../../../../../../packages/langgraph-graphs/src/graphs/work-prioritizer/tools";

const host = vi.hoisted(() => ({ container: {} as Record<string, unknown> }));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => host.container,
}));
const updateId = "core__work_item_update";
const transitionId = "core__work_item_transition";
const readId = "core__work_item_read";
const edoId = "core__edo_decide";
const row: WorkItem = {
  id: "task.5282" as WorkItemId,
  type: "task",
  title: "Prioritize",
  status: "needs_implement",
  node: "operator",
  assignees: [],
  externalRefs: [],
  actor: "either",
  labels: [],
  specRefs: [],
  revision: 4,
  deployVerified: false,
  createdAt: "2026-11-20T00:00:00Z",
  updatedAt: "2026-11-20T00:00:00Z",
  rank: 3,
};

function compose(
  workItemCapability = createWorkItemCapability({
    workItemQuery: {
      get: vi.fn(),
      list: vi.fn().mockResolvedValue({ items: [row] }),
      listRelations: vi.fn(),
    },
  })
) {
  const decide = vi.fn();
  // Unused ports are inert; any accidental execution would fail these boundary tests.
  const deps = {
    knowledgeCapability: {},
    edoCapability: { decide },
    metricsCapability: {},
    webSearchCapability: {},
    repoCapability: {},
    scheduleCapability: {},
    vcsCapability: {},
    workItemCapability,
  } as unknown as ToolBindingDeps;
  const bindings = createToolBindings(deps);
  const bundle = [...OPERATOR_CORE_TOOL_BUNDLE, ...VCS_TOOL_BUNDLE];
  return {
    bindings,
    bundle,
    decide,
    source: createBoundToolSource(bundle, bindings),
  };
}

const ctx = {
  runId: "run-real-context",
  toolCallId: "call",
  actorId: "agent:principal-P",
  subjectId: "subject-S",
  tenantId: "operator",
};

describe("operator released tool composition", () => {
  it("composes update exactly once, preserves operator policy, and fails startup for missing or duplicate bindings", () => {
    const { source, bundle, bindings } = compose();
    expect(source.getToolIds().filter((id) => id === updateId)).toHaveLength(1);
    expect(source.hasToolId(transitionId)).toBe(false);
    expect(TOOL_CATALOG).not.toHaveProperty(transitionId);
    expect(source.hasToolId("core__work_item_artifact_record")).toBe(false);
    for (const original of CORE_TOOL_BUNDLE) {
      expect(source.getBoundTool(original.contract.name)?.requires).toBe(
        original.contract.requires
      );
    }
    expect(source.getBoundTool(updateId)?.requires).toBe("node.collaborate");
    expect(source.getBoundTool(readId)?.requires).toBe("node.collaborate");
    for (const ids of [OPERATING_REVIEW_TOOL_IDS, WORK_PRIORITIZER_TOOL_IDS]) {
      expect(ids).toContain(updateId);
      for (const id of ids) expect(source.hasToolId(id)).toBe(true);
      expect(ids).not.toContain(transitionId);
    }
    expect(VCS_TOOL_BUNDLE.length).toBeGreaterThan(0);
    const missing = { ...bindings };
    delete missing[updateId];
    expect(() => createBoundToolSource(bundle, missing)).toThrow(
      "TOOL_BINDING_REQUIRED"
    );
    const update = bundle.find((t) => t.contract.name === updateId);
    if (!update) throw new Error("Missing update");
    expect(() => createBoundToolSource([...bundle, update], bindings)).toThrow(
      "TOOL_BINDING_DUPLICATE"
    );
  });

  it("enforces the collaborator policy before an update reaches the host store", async () => {
    const patch = vi.fn();
    const capability = { query: vi.fn(), patch };
    const { source } = compose(capability);
    const runner = createToolRunner(source, () => {}, {
      policy: createToolAllowlistPolicy([updateId]),
      ctx: { runId: "no-authority" },
      nodeId: "operator",
    });
    const result = await runner.exec(updateId, {
      id: row.id,
      expectedRevision: 4,
      reason: "Prioritize",
      set: { rank: 2 },
    });
    expect(result).toMatchObject({ ok: false, errorCode: "authz_unavailable" });
    expect(patch).not.toHaveBeenCalled();
  });

  it("matches released EDO reduced output/confidence while refusing the unqualified host writer even with invocation IDs", async () => {
    const input = edoDecideContract.inputSchema.parse({
      id: "decision-train",
      domain: "strategy",
      title: "Adopt",
      content: "Grounded decision",
      sourceType: "agent",
      derivesFromHypothesisId: "goal-a",
      confidencePct: 83,
    });
    const decide = vi.fn().mockResolvedValue({
      id: input.id,
      domain: input.domain,
      title: input.title,
      confidencePct: 83,
      sourceType: "agent",
      content: "not in reduced output",
    });
    // Released mechanism conformance only; this fake is not a new runtime writer or attribution proof.
    const released = createEdoDecideImplementation({
      edoCapability: { decide } as unknown as Parameters<
        typeof createEdoDecideImplementation
      >[0]["edoCapability"],
    });
    const result = edoDecideContract.outputSchema.parse(
      await released.execute(input)
    );
    expect(decide).toHaveBeenCalledWith(
      expect.objectContaining({
        confidencePct: 83,
        derivesFromHypothesisId: "goal-a",
      })
    );
    expect(result.entry).toEqual({
      id: input.id,
      domain: "strategy",
      title: "Adopt",
      confidencePct: 83,
      sourceType: "agent",
    });
    expect(result).toMatchObject({
      committed: true,
      derivesFromHypothesisId: "goal-a",
    });
    const { source, decide: hostDecide } = compose();
    const runtime = source.getBoundTool(edoId);
    if (!runtime) throw new Error("Missing EDO");
    expect(runtime.validateOutput(result)).toEqual(result);
    await expect(
      runtime.exec(runtime.validateInput(input), ctx, {})
    ).rejects.toThrow("requires verified run attribution");
    expect(hostDecide).not.toHaveBeenCalled();
  });

  it("reads artifact/history/link options through the same real facade composition and preserves unavailable markers", async () => {
    const artifact = {
      id: "artifact-review",
      seq: 1,
      itemId: row.id,
      itemRevision: 4,
      kind: "implementation_review",
      subject: `work:${row.id}`,
      verdict: "pass",
      author: "actor-P",
      createdAt: "2026-11-20T00:00:00Z",
      body: "Review body",
    };
    const artifactStore = {
      refs: vi.fn().mockResolvedValue([artifact]),
      get: vi.fn().mockResolvedValue(artifact),
      latest: vi.fn().mockResolvedValue([]),
    } as unknown as WorkItemArtifactStore;
    const historyPage = vi
      .fn()
      .mockResolvedValue({ entries: [], nextCursor: null });
    const store = {
      get: vi.fn().mockResolvedValue(row),
      list: vi.fn().mockResolvedValue({ items: [row] }),
      historyPage,
    };
    const knowledge = {
      listCitationLinks: vi
        .fn()
        .mockResolvedValue({ links: [], nextCursor: null }),
    };
    host.container = {
      doltgresWorkItems: store,
      workItemArtifacts: { artifacts: artifactStore },
      knowledgeStorePort: knowledge,
      log: { warn: vi.fn() },
    };
    const capability = createWorkItemCapability({
      workItemQuery: { ...store, listRelations: vi.fn() },
      backlogReader: store,
      links: createCitationLinksPort(() => knowledge as never),
      refs: createItemRefPorts({ artifacts: artifactStore, history: store }),
      artifacts: { latest: (id) => artifactStore.latest(id) },
    });
    const { source } = compose(capability);
    const runtime = source.getBoundTool(readId);
    if (!runtime) throw new Error("Missing read");
    const options = {
      includeLinks: true,
      includeArtifacts: true,
      includeHistory: true,
      artifactId: artifact.id,
    };
    const output = runtime.validateOutput(
      await runtime.exec(
        runtime.validateInput({ id: row.id, ...options }),
        ctx,
        {}
      )
    ) as { item: unknown };
    const http = await getWorkItem(row.id, options);
    expect(output.item).toEqual({ ...http, sourceUrlUnavailable: true });
    expect(output.item).toMatchObject({
      artifactRefs: { refs: [expect.objectContaining({ id: artifact.id })] },
      historyRefs: { refs: [], nextCursor: null },
      links: { items: [], nextCursor: null },
      artifact,
    });
    expect(artifactStore.get).toHaveBeenCalledWith(row.id, artifact.id);
    expect(artifactStore.refs).toHaveBeenCalledWith(row.id, {
      limit: ARTIFACT_REFS_PAGE + 1,
    });
    expect(historyPage).toHaveBeenCalledWith(row.id, {
      cursor: undefined,
      limit: HISTORY_REFS_PAGE,
    });
    vi.mocked(artifactStore.refs).mockRejectedValue(new Error("unavailable"));
    historyPage.mockRejectedValue(new Error("unavailable"));
    knowledge.listCitationLinks.mockRejectedValue(new Error("unavailable"));
    const degraded = runtime.validateOutput(
      await runtime.exec(
        runtime.validateInput({ id: row.id, ...options }),
        ctx,
        {}
      )
    ) as { item: unknown };
    expect(degraded.item).toEqual({
      ...(await getWorkItem(row.id, options)),
      sourceUrlUnavailable: true,
    });
    expect(degraded.item).toMatchObject({
      artifactRefs: { unavailable: true },
      historyRefs: { unavailable: true },
      links: { unavailable: true },
    });
  });

  it("graph telemetry parses the released canonical update and set payload, counting refusals as no change", async () => {
    const patch = vi
      .fn()
      .mockResolvedValue({ ...toWorkItemDto(row), rank: 1, revision: 5 });
    const impl = createWorkItemUpdateImplementation({
      workItemCapability: { query: vi.fn(), patch },
    });
    const args = workItemUpdateContract.inputSchema.parse({
      id: row.id,
      expectedRevision: 4,
      reason: "Prioritize",
      set: { rank: 1 },
    });
    const result = await impl.execute(args);
    const messages = [
      new ToolMessage({
        name: "core__work_item_query",
        tool_call_id: "query",
        content: JSON.stringify({ items: [toWorkItemDto(row)] }),
      }),
      new AIMessage({
        content: "",
        tool_calls: [{ id: "patch", name: updateId, args }],
      }),
      new ToolMessage({
        name: updateId,
        tool_call_id: "patch",
        content: JSON.stringify(result),
      }),
      new ToolMessage({
        name: updateId,
        tool_call_id: "refused",
        content: JSON.stringify({
          success: false,
          code: "revision_conflict",
          id: row.id,
          currentRevision: 5,
        }),
      }),
      new ToolMessage({
        name: updateId,
        tool_call_id: "legacy",
        content: JSON.stringify({
          success: true,
          action: "patch",
          id: "task.legacy",
        }),
      }),
    ];
    expect(cycleScores(messages)).toMatchObject({
      identicalPatches: 0,
      unknownBaselinePatches: 0,
      scores: { novel_change: 1 },
    });
    expect(cycleTelemetry(messages)).toMatchObject({
      changeCount: 1,
      changedItemIds: [row.id],
      toolErrorCount: 1,
    });
  });
});
