// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/graph-executor.identity`
 * Purpose: Exercise canonical launch admission against durable run facts and catalog identity.
 * Scope: Real launcher, ALS and principal resolver; fake ledger/store I/O only.
 * Invariants: Missing/mismatched ledger facts never invoke an executor; requester never becomes actor.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/activity-attribution, story.0085
 * @internal
 */
import { readFileSync } from "node:fs";
import { CORE_TOOL_BUNDLE } from "@cogni/ai-tools";
import { COGNI_SYSTEM_PRINCIPAL_USER_ID } from "@cogni/node-shared";
import { LANGGRAPH_CATALOG } from "@cogni/operator-graphs";
import { GRAPH_RUN_KINDS, type GraphRun } from "@cogni/scheduler-core";
import { runAttribution } from "@cogni/work-items";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getExecutionScope } from "@/adapters/server/ai/execution-scope";
import { runGraphWithScope } from "@/bootstrap/graph-executor.factory";
import type { GraphExecutorPort, GraphRunRequest, LlmService } from "@/ports";

const host = vi.hoisted(() => ({
  getRun: vi.fn(),
  principal: vi.fn(),
  log: { error: vi.fn() },
}));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    graphRunRepository: { getRunByRunId: host.getRun },
    log: host.log,
  }),
  resolveServiceDb: () => ({ $client: {} }),
}));
vi.mock("@/adapters/server", () => ({}));
vi.mock("@cogni-dao/agent-grants", async (original) => ({
  ...(await original<typeof import("@cogni-dao/agent-grants")>()),
  createPostgresAgentGrantsStore: () => ({
    findInternalPrincipal: host.principal,
  }),
}));

const req: GraphRunRequest = {
  runId: "durable-run",
  graphId: "langgraph:cogni",
  modelRef: { providerKey: "platform", modelId: "fixture" },
  messages: [],
};
const log = { warn: vi.fn() };
const ledger = (patch: Partial<GraphRun> = {}) => ({
  runId: req.runId,
  graphId: req.graphId,
  runKind: "system_scheduled",
  ...patch,
});
function launch(requester?: string, graphId = req.graphId) {
  const mutate = vi.fn();
  const execute = vi.fn(() => {
    const scope = getExecutionScope();
    // This is the released builder used by both migrated writer bindings.
    mutate(runAttribution(scope, log));
    return {
      stream: (async function* () {
        yield { type: "done" as const };
      })(),
      final: Promise.resolve({
        ok: true as const,
        runId: req.runId,
        requestId: req.runId,
      }),
    };
  });
  const executor: GraphExecutorPort = { runGraph: execute };
  const result = runGraphWithScope({
    executor,
    // Payload hints must never replace the ledger kind.
    req: { ...req, graphId, ...{ runKind: "user_immediate" } },
    ...(requester
      ? { ctx: { actorUserId: requester, requestId: "request" } }
      : {}),
    billing: { billingAccountId: "payer", virtualKeyId: "key" },
    llmService: {} as LlmService,
    usageSource: "litellm",
    nodeId: "operator",
  });
  return { execute, mutate, result };
}

describe("durable run identity admission (story.0085)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    host.getRun.mockResolvedValue(ledger());
    host.principal.mockImplementation(async (slug) => ({
      userId: `seeded-${slug}`,
    }));
  });

  it.each([
    ["missing ledger", null],
    ["different graph", ledger({ graphId: "langgraph:brain" })],
    ["different run", ledger({ runId: "other" })],
    ["missing kind", ledger({ runKind: null })],
    ["invalid kind", { ...ledger(), runKind: "caller_invented" }],
  ])("%s refuses before mutation and completes its stream", async (_name, record) => {
    host.getRun.mockResolvedValue(record);
    const { execute, mutate, result } = launch("human");
    expect(await result.final).toMatchObject({ ok: false, error: "internal" });
    const events = [];
    for await (const event of result.stream) events.push(event);
    expect(events).toEqual([
      { type: "error", error: "internal" },
      { type: "done" },
    ]);
    expect(execute).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
    expect(host.principal).not.toHaveBeenCalled();
  });

  it.each(
    GRAPH_RUN_KINDS
  )("uses actual %s ledger attribution and a separate requester", async (kind) => {
    host.getRun.mockResolvedValue(ledger({ runKind: kind }));
    const { mutate, result } = launch("human");
    expect(await result.final).toMatchObject({ ok: true });
    expect(mutate).toHaveBeenCalledWith({
      actor: "seeded-node-ai",
      requestedBy: "human",
      run: { id: req.runId, kind },
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    COGNI_SYSTEM_PRINCIPAL_USER_ID,
  ])("subjectless/system-owned launches omit requester: %s", async (requester) => {
    const { mutate, result } = launch(requester);
    expect(await result.final).toMatchObject({ ok: true });
    expect(mutate).toHaveBeenCalledWith({
      actor: "seeded-node-ai",
      run: { id: req.runId, kind: "system_scheduled" },
    });
  });

  it("a missing seed never substitutes the requester for the actor", async () => {
    host.principal.mockResolvedValue(null);
    const { mutate, result } = launch("human");
    expect(await result.final).toMatchObject({ ok: false });
    expect(mutate).not.toHaveBeenCalled();
  });

  it("binds Operating Review to its own seeded identity", async () => {
    host.getRun.mockResolvedValue(
      ledger({ graphId: "langgraph:operating-review" })
    );
    const { mutate, result } = launch("human", "langgraph:operating-review");
    expect(await result.final).toMatchObject({ ok: true });
    expect(host.principal).toHaveBeenCalledWith("operating-review");
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: "seeded-operating-review",
        requestedBy: "human",
      })
    );
  });

  it("every catalog writer has a node-owned seed and grants stay separate", () => {
    const sql = readFileSync(
      new URL(
        "../../../src/adapters/server/db/migrations/0072_operator_internal_principals.sql",
        import.meta.url
      ),
      "utf8"
    );
    const slugs = [
      ...(
        sql.match(/FOREACH principal_slug IN ARRAY ARRAY\[([^\]]+)\]/)?.[1] ??
        ""
      ).matchAll(/'([^']+)'/g),
    ].map((m) => m[1]);
    const mutatingIds = new Set(
      CORE_TOOL_BUNDLE.filter(
        (tool) => tool.contract.effect !== "read_only"
      ).map((tool) => tool.contract.name)
    );
    const writers = Object.entries(LANGGRAPH_CATALOG).filter(([, entry]) =>
      entry.toolIds.some((id) => mutatingIds.has(id))
    );
    expect(writers.map(([id]) => id).sort()).toEqual([
      "autoresearch-registry-swarm",
      "autoresearch-single-lane",
      "autoresearch-syntropy-loop",
      "brain",
      "cogni",
      "operating-review",
      "work-prioritizer",
    ]);
    for (const [, entry] of writers) expect(slugs).toContain(entry.principal);
    expect(sql).toMatch(/INSERT INTO "users"/);
    expect(sql).toMatch(/INSERT INTO "agent_principals"/);
    expect(sql).not.toMatch(/INSERT INTO "agent_roles"|\bGRANT\b|ON CONFLICT/i);
  });
});
