// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tests/node-code`
 * Purpose: Prove source identity cannot be selected by the model and private reads fail closed.
 * Scope: Real ToolRunner and contract adapters with fake source IO/authorization; no model or GitHub calls.
 * Invariants: Collaborator identity is insufficient; developer authority is checked on the owning node.
 * Side-effects: none
 * Links: https://cognidao.org/work/items/subtask.5027
 * @internal
 */
import { createToolRunner } from "@cogni/ai-core";
import type {
  AuthorizationPort,
  AuthzCheckParams,
} from "@cogni/authorization-core";
import { describe, expect, it, vi } from "vitest";
import { toBoundToolRuntime } from "../src/runtime-adapter";
import {
  NodeCodeListInputSchema,
  nodeCodeListContract,
} from "../src/tools/node-code-list";
import {
  createNodeCodeReadImplementation,
  NODE_CODE_READ_NAME,
  nodeCodeReadContract,
} from "../src/tools/node-code-read";

const result = {
  nodeId: "own-node",
  origin: "https://node.example",
  repo: "org/node",
  commitSha: "a".repeat(40),
  path: "packages/tool.ts",
  citation: "https://github.com/org/node/blob/sha/packages/tool.ts",
  complete: true,
  exists: true,
  content: "hello\n",
  sha256: "b".repeat(64),
  lineStart: 1,
  lineEnd: 1,
  totalLines: 1,
  fileComplete: true,
};

describe("immutable node code authority", () => {
  function runner(check?: AuthorizationPort["check"], nodeId = "own-node") {
    const read = vi.fn(async () => result);
    const runtime = toBoundToolRuntime({
      contract: nodeCodeReadContract,
      implementation: createNodeCodeReadImplementation({
        nodeCodeCapability: { read, list: vi.fn() },
      }),
    });
    const source = {
      getBoundTool: (name: string) =>
        name === NODE_CODE_READ_NAME ? runtime : undefined,
      listToolSpecs: () => [runtime.spec],
      hasToolId: (name: string) => name === NODE_CODE_READ_NAME,
    };
    const port: AuthorizationPort | undefined = check
      ? {
          check,
          writeRelation: vi.fn(),
          deleteRelation: vi.fn(),
          listRelations: vi.fn(),
        }
      : undefined;
    return {
      read,
      run: createToolRunner(source, () => {}, {
        actorId: "user:developer",
        tenantId: "tenant",
        nodeId,
        ...(port ? { authz: port } : {}),
        policy: { allowedTools: [NODE_CODE_READ_NAME], decide: () => "allow" },
      }),
    };
  }

  it("denies before IO when no authorization adapter exists, despite authenticated actor/node", async () => {
    const { run, read } = runner();
    expect(
      await run.exec(NODE_CODE_READ_NAME, { path: "packages/tool.ts" })
    ).toMatchObject({ ok: false, errorCode: "authz_unavailable" });
    expect(read).not.toHaveBeenCalled();
    expect(nodeCodeListContract.requires).toBe("node.flight");
  });

  it("checks actual node.flight authorization on owning node and rejects denial before bytes", async () => {
    const checks: AuthzCheckParams[] = [];
    const { run, read } = runner(async (params) => {
      checks.push(params);
      return { decision: "deny", code: "authz_denied", checks: [] };
    });
    expect(
      await run.exec(NODE_CODE_READ_NAME, { path: "packages/tool.ts" })
    ).toMatchObject({ ok: false, errorCode: "authz_denied" });
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      action: "node.flight",
      resource: "node:own-node",
      context: { nodeId: "own-node" },
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("requires the real authority result and rejects model-selected identity/ref arguments", async () => {
    const { run, read } = runner(async () => ({
      decision: "allow",
      code: "authz_allowed",
      checks: [],
    }));
    const call = await run.exec(NODE_CODE_READ_NAME, {
      path: "packages/tool.ts",
    });
    expect(call).toMatchObject({ ok: true, value: result });
    expect(read).toHaveBeenCalledExactlyOnceWith({ path: "packages/tool.ts" });
    for (const key of [
      "repo",
      "nodeId",
      "origin",
      "ref",
      "commitSha",
      "token",
    ]) {
      const rejected = await run.exec(NODE_CODE_READ_NAME, {
        path: "packages/tool.ts",
        [key]: "forged",
      });
      expect(rejected.ok).toBe(false);
      expect(
        NodeCodeListInputSchema.safeParse({ path: ".", [key]: "forged" })
          .success
      ).toBe(false);
    }
    expect(read).toHaveBeenCalledTimes(1);
  });
});
