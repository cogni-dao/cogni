// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-core/tests/tool-runner.authz`
 * Purpose: Verify createToolRunner enforces AuthorizationPort decisions before tool execution.
 * Scope: Package-local unit test with deterministic fake AuthorizationPort and static tool source. Does not call network services.
 * Invariants:
 *   - AUTHZ_CHECK_BEFORE_TOOL_EXEC
 *   - AUTHZ_FAILS_CLOSED_BEFORE_EXEC
 *   - AUTHZ_RESULT_ONLY_STABLE_ID
 * Side-effects: none
 * Links: docs/spec/rbac.md, docs/spec/tool-use.md
 * @internal
 */

import {
  type AuthorizationPort,
  FakeAuthorizationAdapter,
} from "@cogni/authorization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type AiEvent,
  type BoundToolRuntime,
  createStaticToolSource,
  createToolAllowlistPolicy,
  createToolRunner,
  type ToolAuthzDecisionRecord,
  type ToolRunnerConfig,
} from "../src/index";

const toolName = "core__clock";
const authzParams = {
  actorId: "user:alice",
  action: "tool.execute",
  resource: `tool:${toolName}`,
  context: {
    tenantId: "tenant:one",
    runId: "run-1",
  },
} as const;

function makeTool(exec = vi.fn(async () => ({ now: "2026-06-07T00:00:00Z" }))) {
  return {
    id: toolName,
    effect: "read_only",
    requiresConnection: false,
    capabilities: [],
    spec: {
      name: toolName,
      description: "clock",
      effect: "read_only",
      inputSchema: { type: "object" },
      redaction: { mode: "top_level_only", allowlist: ["now"] },
    },
    validateInput(input: unknown): unknown {
      return input;
    },
    exec,
    validateOutput(output: unknown): unknown {
      return output;
    },
    redact(output: unknown): unknown {
      return output;
    },
  } satisfies BoundToolRuntime;
}

describe("createToolRunner authz gate", () => {
  let events: AiEvent[];

  beforeEach(() => {
    events = [];
  });

  it("executes the tool after authz allow", async () => {
    const authz = new FakeAuthorizationAdapter();
    authz.allow(authzParams);
    const tool = makeTool();
    const runner = createToolRunner(
      createStaticToolSource([tool]),
      (event) => events.push(event),
      {
        policy: createToolAllowlistPolicy([toolName]),
        ctx: { runId: "run-1" },
        authz,
        actorId: "user:alice",
        tenantId: "tenant:one",
      }
    );

    const result = await runner.exec(toolName, {});

    expect(result).toEqual({
      ok: true,
      value: { now: "2026-06-07T00:00:00Z" },
    });
    expect(tool.exec).toHaveBeenCalledOnce();
    expect(events.map((event) => event.type)).toEqual([
      "tool_call_start",
      "tool_call_result",
    ]);
  });

  it("returns authz_denied before validation and execution", async () => {
    const authz = new FakeAuthorizationAdapter();
    authz.deny(authzParams);
    const exec = vi.fn(async () => ({ now: "never" }));
    const runner = createToolRunner(
      createStaticToolSource([makeTool(exec)]),
      (event) => events.push(event),
      {
        policy: createToolAllowlistPolicy([toolName]),
        ctx: { runId: "run-1" },
        authz,
        actorId: "user:alice",
        tenantId: "tenant:one",
      }
    );

    const result = await runner.exec(toolName, {});

    expect(result).toMatchObject({ ok: false, errorCode: "authz_denied" });
    expect(exec).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "tool_call_result",
      isError: true,
    });
  });

  it("emits authz denial as result-only with stable model tool call id", async () => {
    const authz = new FakeAuthorizationAdapter();
    authz.deny(authzParams);
    const exec = vi.fn(async () => ({ now: "never" }));
    const runner = createToolRunner(
      createStaticToolSource([makeTool(exec)]),
      (event) => events.push(event),
      {
        policy: createToolAllowlistPolicy([toolName]),
        ctx: { runId: "run-1" },
        authz,
        actorId: "user:alice",
        tenantId: "tenant:one",
      }
    );

    const result = await runner.exec(
      toolName,
      {},
      { modelToolCallId: "call_1" }
    );

    expect(result).toMatchObject({ ok: false, errorCode: "authz_denied" });
    expect(exec).not.toHaveBeenCalled();
    expect(events).toEqual([
      {
        type: "tool_call_result",
        toolCallId: "call_1",
        result: { error: "Tool execution is not authorized" },
        isError: true,
      },
    ]);
  });

  it("returns authz_unavailable before execution", async () => {
    const authz = new FakeAuthorizationAdapter();
    authz.unavailable(authzParams);
    const exec = vi.fn(async () => ({ now: "never" }));
    const runner = createToolRunner(
      createStaticToolSource([makeTool(exec)]),
      (event) => events.push(event),
      {
        policy: createToolAllowlistPolicy([toolName]),
        ctx: { runId: "run-1" },
        authz,
        actorId: "user:alice",
        tenantId: "tenant:one",
      }
    );

    const result = await runner.exec(toolName, {});

    expect(result).toMatchObject({
      ok: false,
      errorCode: "authz_unavailable",
    });
    expect(exec).not.toHaveBeenCalled();
  });

  it("fails closed when authz is configured without identity", async () => {
    const authz = new FakeAuthorizationAdapter();
    const exec = vi.fn(async () => ({ now: "never" }));
    const runner = createToolRunner(
      createStaticToolSource([makeTool(exec)]),
      (event) => events.push(event),
      {
        policy: createToolAllowlistPolicy([toolName]),
        ctx: { runId: "run-1" },
        authz,
      }
    );

    const result = await runner.exec(toolName, {});

    expect(result).toMatchObject({
      ok: false,
      errorCode: "authz_unavailable",
    });
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("createToolRunner node policy (authz v0)", () => {
  const NODE_A = "node-a";
  const NODE_B = "node-b";
  let events: AiEvent[];
  let decisions: ToolAuthzDecisionRecord[];

  beforeEach(() => {
    events = [];
    decisions = [];
  });

  function declaredTool(
    requires: BoundToolRuntime["requires"],
    exec = vi.fn(async () => ({ now: "2026-10-20T00:00:00Z" }))
  ): BoundToolRuntime & { exec: typeof exec } {
    return { ...makeTool(exec), requires };
  }

  function runnerFor(
    tool: BoundToolRuntime,
    authz: AuthorizationPort,
    overrides: Partial<ToolRunnerConfig> = {}
  ) {
    return createToolRunner(
      createStaticToolSource([tool]),
      (event) => events.push(event),
      {
        policy: createToolAllowlistPolicy([toolName]),
        ctx: { runId: "run-1" },
        authz,
        actorId: "user:system",
        tenantId: "tenant:one",
        nodeId: NODE_A,
        grantId: "grant-1",
        graphId: "langgraph:work-prioritizer",
        onAuthzDecision: (record) => decisions.push(record),
        ...overrides,
      }
    );
  }

  it("node.collaborate: allowed with actor + node, without any OpenFGA call", async () => {
    const authz = new FakeAuthorizationAdapter();
    const check = vi.spyOn(authz, "check");
    const tool = declaredTool("node.collaborate");

    const result = await runnerFor(tool, authz).exec(toolName, {});

    expect(result.ok).toBe(true);
    expect(tool.exec).toHaveBeenCalledOnce();
    expect(check).not.toHaveBeenCalled();
    expect(decisions).toEqual([
      expect.objectContaining({
        decision: "allow",
        policy: "v0_collaborate",
        actorId: "user:system",
        nodeId: NODE_A,
        graphId: "langgraph:work-prioritizer",
        grantId: "grant-1",
      }),
    ]);
    // nodeId/grantId reach the tool's invocation context.
    expect(tool.exec).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ nodeId: NODE_A, grantId: "grant-1" }),
      {}
    );
  });

  it("node.collaborate: missing actor → authz_unavailable", async () => {
    const tool = declaredTool("node.collaborate");
    const result = await runnerFor(tool, new FakeAuthorizationAdapter(), {
      actorId: undefined,
    }).exec(toolName, {});
    expect(result).toMatchObject({ ok: false, errorCode: "authz_unavailable" });
    expect(tool.exec).not.toHaveBeenCalled();
    expect(decisions[0]).toMatchObject({
      decision: "unavailable",
      reason: "missing_actor",
    });
  });

  it("node.collaborate: missing node → authz_unavailable", async () => {
    const tool = declaredTool("node.collaborate");
    const result = await runnerFor(tool, new FakeAuthorizationAdapter(), {
      nodeId: undefined,
    }).exec(toolName, {});
    expect(result).toMatchObject({ ok: false, errorCode: "authz_unavailable" });
    expect(tool.exec).not.toHaveBeenCalled();
    expect(decisions[0]).toMatchObject({ reason: "missing_node" });
  });

  it("cross-graph: a collaborate tool outside the graph's allowlist is policy_denied", async () => {
    const tool = declaredTool("node.collaborate");
    const result = await runnerFor(tool, new FakeAuthorizationAdapter(), {
      policy: createToolAllowlistPolicy(["core__some_other_tool"]),
    }).exec(toolName, {});
    expect(result).toMatchObject({ ok: false, errorCode: "policy_denied" });
    expect(tool.exec).not.toHaveBeenCalled();
    expect(decisions).toEqual([]);
  });

  it("cross-node: a role on node B never authorizes a node-action tool on node A", async () => {
    const authz = new FakeAuthorizationAdapter();
    await authz.writeRelation({
      user: "user:system",
      relation: "can_flight",
      object: `node:${NODE_B}`,
    });
    const tool = declaredTool("node.flight");
    const check = vi.spyOn(authz, "check");

    const result = await runnerFor(tool, authz).exec(toolName, {});

    expect(result).toMatchObject({ ok: false, errorCode: "authz_denied" });
    expect(tool.exec).not.toHaveBeenCalled();
    expect(check).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "node.flight",
        resource: `node:${NODE_A}`,
        context: expect.objectContaining({
          nodeId: NODE_A,
          grantId: "grant-1",
        }),
      })
    );
    expect(decisions[0]).toMatchObject({
      decision: "deny",
      policy: "openfga_node",
    });
  });

  it("node action: grant role → allowed, revoke → denied", async () => {
    const authz = new FakeAuthorizationAdapter();
    const role = {
      user: "user:system",
      relation: "can_flight",
      object: `node:${NODE_A}`,
    };
    const tool = declaredTool("node.flight");
    const runner = runnerFor(tool, authz);

    await authz.writeRelation(role);
    expect((await runner.exec(toolName, {})).ok).toBe(true);

    await authz.deleteRelation(role);
    expect(await runner.exec(toolName, {})).toMatchObject({
      ok: false,
      errorCode: "authz_denied",
    });
    expect(tool.exec).toHaveBeenCalledOnce();
  });

  it("node action: missing node → authz_unavailable without a check", async () => {
    const authz = new FakeAuthorizationAdapter();
    const check = vi.spyOn(authz, "check");
    const result = await runnerFor(declaredTool("node.flight"), authz, {
      nodeId: undefined,
    }).exec(toolName, {});
    expect(result).toMatchObject({ ok: false, errorCode: "authz_unavailable" });
    expect(check).not.toHaveBeenCalled();
  });

  it("node action: an OpenFGA throw → authz_unavailable", async () => {
    const authz = new FakeAuthorizationAdapter();
    vi.spyOn(authz, "check").mockRejectedValue(new Error("ECONNREFUSED"));
    const tool = declaredTool("node.flight");
    const result = await runnerFor(tool, authz).exec(toolName, {});
    expect(result).toMatchObject({ ok: false, errorCode: "authz_unavailable" });
    expect(tool.exec).not.toHaveBeenCalled();
    expect(decisions[0]).toMatchObject({
      decision: "unavailable",
      reason: "check_threw",
    });
  });

  it("undeclared tool: legacy tool.execute on tool:<id>, unchanged params", async () => {
    const authz = new FakeAuthorizationAdapter();
    const check = vi.spyOn(authz, "check");
    const tool = makeTool();

    const result = await runnerFor(tool, authz).exec(
      toolName,
      {},
      {
        modelToolCallId: "call_9",
      }
    );

    // Default-deny (no tool tuple) exactly as before, with node/grant context
    // NOT added to the legacy check.
    expect(result).toMatchObject({ ok: false, errorCode: "authz_denied" });
    expect(check).toHaveBeenCalledWith({
      actorId: "user:system",
      action: "tool.execute",
      resource: `tool:${toolName}`,
      context: {
        tenantId: "tenant:one",
        runId: "run-1",
        toolCallId: "call_9",
        graphId: "langgraph:work-prioritizer",
      },
    });
    expect(events).toEqual([
      {
        type: "tool_call_result",
        toolCallId: "call_9",
        result: { error: "Tool execution is not authorized" },
        isError: true,
      },
    ]);
    expect(decisions[0]).toMatchObject({ policy: "legacy_tool" });
  });

  it("no adapter + declared privileged action → fails closed (authz_unavailable)", async () => {
    const tool = declaredTool("node.flight");
    const runner = createToolRunner(
      createStaticToolSource([tool]),
      (event) => events.push(event),
      {
        policy: createToolAllowlistPolicy([toolName]),
        ctx: { runId: "r" },
        actorId: "user:system",
        tenantId: "tenant:one",
        nodeId: NODE_A,
        onAuthzDecision: (record) => decisions.push(record),
      }
    );
    expect(await runner.exec(toolName, {})).toMatchObject({
      ok: false,
      errorCode: "authz_unavailable",
    });
    expect(tool.exec).not.toHaveBeenCalled();
    expect(decisions[0]).toMatchObject({
      policy: "openfga_node",
      reason: "no_authz_adapter",
    });
  });

  it("no adapter + undeclared tool → legacy compatibility path, ungated as before", async () => {
    const tool = makeTool();
    const runner = createToolRunner(
      createStaticToolSource([tool]),
      (event) => events.push(event),
      {
        policy: createToolAllowlistPolicy([toolName]),
        ctx: { runId: "r" },
        onAuthzDecision: (record) => decisions.push(record),
      }
    );
    expect((await runner.exec(toolName, {})).ok).toBe(true);
    expect(decisions).toEqual([]);
  });
});

/**
 * NODE_POLICY_INDEPENDENT_OF_ADAPTER: node.collaborate behaves identically with and
 * without an OpenFGA adapter — the v0 policy is not optional, the adapter is.
 */
describe.each([
  ["with adapter", () => new FakeAuthorizationAdapter() as AuthorizationPort],
  ["without adapter", () => undefined],
] as const)("node.collaborate %s", (_label, makeAuthz) => {
  function run(overrides: Partial<ToolRunnerConfig>) {
    const exec = vi.fn(async () => ({ now: "x" }));
    const tool = { ...makeTool(exec), requires: "node.collaborate" as const };
    const decisions: ToolAuthzDecisionRecord[] = [];
    const authz = makeAuthz();
    const runner = createToolRunner(createStaticToolSource([tool]), () => {}, {
      policy: createToolAllowlistPolicy([toolName]),
      ctx: { runId: "run-1" },
      ...(authz ? { authz } : {}),
      actorId: "user:system",
      tenantId: "tenant:one",
      nodeId: "node-a",
      onAuthzDecision: (record) => decisions.push(record),
      ...overrides,
    });
    return { runner, exec, decisions };
  }

  it("valid authenticated context → allowed", async () => {
    const { runner, exec, decisions } = run({});
    expect((await runner.exec(toolName, {})).ok).toBe(true);
    expect(exec).toHaveBeenCalledOnce();
    expect(decisions[0]).toMatchObject({
      decision: "allow",
      policy: "v0_collaborate",
    });
  });

  it("missing actor → authz_unavailable", async () => {
    const { runner, exec } = run({ actorId: undefined });
    expect(await runner.exec(toolName, {})).toMatchObject({
      ok: false,
      errorCode: "authz_unavailable",
    });
    expect(exec).not.toHaveBeenCalled();
  });

  it("missing node → authz_unavailable", async () => {
    const { runner, exec } = run({ nodeId: undefined });
    expect(await runner.exec(toolName, {})).toMatchObject({
      ok: false,
      errorCode: "authz_unavailable",
    });
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("declared exact-account execution", () => {
  const node = "11111111-1111-4111-8111-111111111111";
  const account = "22222222-2222-4222-8222-222222222222";
  const actor = `agent:${node}/33333333-3333-4333-8333-333333333333`;
  const setup = (
    config: Partial<ToolRunnerConfig> = {},
    missingAuthority = false
  ) => {
    const tool = { ...makeTool(), requires: "tool.execute" as const };
    const check = vi.fn(async () => ({
      decision: "allow" as const,
      code: "authz_allowed" as const,
      checks: [],
    }));
    const configured = {
      policy: createToolAllowlistPolicy([toolName]),
      actorId: actor,
      tenantId: account,
      nodeId: node,
      authz: { check },
      ...config,
    };
    const { authz: _authority, ...withoutAuthority } = configured;
    const runner = createToolRunner(
      createStaticToolSource([tool]),
      () => {},
      missingAuthority ? withoutAuthority : configured
    );
    return { tool, check, runner };
  };

  it("requires authority even when legacy callers omit the adapter", async () => {
    const { tool, runner } = setup({}, true);
    expect(await runner.exec(toolName, {})).toMatchObject({
      ok: false,
      errorCode: "authz_unavailable",
    });
    expect(tool.exec).not.toHaveBeenCalled();
  });

  it("checks the exact node/account/tool at higher consistency before executing", async () => {
    const { tool, check, runner } = setup();
    expect(await runner.exec(toolName, {})).toMatchObject({ ok: true });
    expect(check).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: actor,
        action: "tool.execute",
        resource: `tool:${node}/${account}/${toolName}`,
        context: expect.objectContaining({ nodeId: node, tenantId: account }),
      }),
      { consistency: "higher_consistency" }
    );
    expect(tool.exec).toHaveBeenCalledOnce();
  });

  it.each([
    { subjectId: `user:${node}/44444444-4444-4444-8444-444444444444` },
    { actorId: "agent:55555555-5555-4555-8555-555555555555/local" },
  ])("refuses unsupported delegation and foreign principals before any side effect", async (config) => {
    const { tool, check, runner } = setup(config);
    expect(await runner.exec(toolName, {})).toMatchObject({
      ok: false,
      errorCode: "authz_denied",
    });
    expect(check).not.toHaveBeenCalled();
    expect(tool.exec).not.toHaveBeenCalled();
  });

  it("does not execute after a deny or authority outage", async () => {
    for (const code of ["authz_denied", "authz_unavailable"] as const) {
      const check = vi.fn(async () => ({
        decision: "deny" as const,
        code,
        checks: [],
      }));
      const { tool, runner } = setup({ authz: { check } });
      expect(await runner.exec(toolName, {})).toMatchObject({
        ok: false,
        errorCode: code,
      });
      expect(tool.exec).not.toHaveBeenCalled();
    }
  });
});
