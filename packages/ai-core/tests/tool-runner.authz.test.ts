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

import { FakeAuthorizationAdapter } from "@cogni/authorization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type AiEvent,
  type BoundToolRuntime,
  createStaticToolSource,
  createToolAllowlistPolicy,
  createToolRunner,
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
