// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO
/**
 * Module: `@scripts/ci/tests/work-item-context`
 * Purpose: Exercise the external guidance client's HTTP and cache boundaries.
 * Scope: Hermetic HTTP boundary tests. Does not mock a database or prove native model adherence.
 * Invariants: READ_NEVER_ADVANCES, NEVER_REPLAY_WRITES, SAME_ORIGIN_CREDENTIALS.
 * Side-effects: IO (loopback HTTP server and disposable temporary Git fixtures).
 * Links: scripts/agent/work-item-context.mjs, https://cognidao.org/work/items/task.5300
 * @internal
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { nodeOrigin, profileFor, run } from "../../agent/work-item-context.mjs";

async function fixture(t, kind = "node-run") {
  const cwd = await mkdtemp(join(tmpdir(), "cogni-workflow-"));
  execFileSync("git", ["init", "--quiet", cwd]);
  const state = {
    calls: [],
    guide: "Read current PR head, then inspect its CI.",
    guideFails: false,
    conflict: false,
    unknownWrite: false,
    owner: "native-a",
  };
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : undefined;
    state.calls.push({
      method: req.method,
      path: req.url,
      key: req.headers.authorization,
      body,
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    let data;
    if (req.url === "/.well-known/agent.json") {
      data = {
        buildSha: "fixture-source",
        endpoints: {},
        actions: {
          updateWorkItem: {
            method: "PATCH",
            endpoint: `${origin}/api/v1/work/items/{id}`,
            inputSchema: {
              properties:
                kind === "operator-session" ? { expectedRevision: {} } : {},
            },
          },
        },
      };
      if (kind === "node-run") {
        data.actions.claimWorkItem = {
          method: "POST",
          endpoint: `${origin}/api/v1/work/items/{id}/claims`,
          inputSchema: { required: ["id", "runId", "command"] },
        };
        data.actions.getWorkItemCoordination = {
          method: "GET",
          endpoint: `${origin}/api/v1/work/items/{id}/coordination`,
        };
      } else {
        data.endpoints = {
          workItemClaim: `${origin}/api/v1/work/items/{id}/claims`,
          workItemPr: `${origin}/api/v1/work/items/{id}/pr`,
          workItemCoordination: `${origin}/api/v1/work/items/{id}/coordination`,
        };
      }
    } else if (req.method !== "GET" && state.unknownWrite) {
      req.socket.destroy();
      return;
    } else if (req.url.endsWith("/claims")) {
      if (state.conflict && kind === "node-run") {
        res.statusCode = 409;
        data = { error: "lease conflict" };
      } else if (kind === "node-run")
        data = { id: "task.1000", claimedByRun: body.runId };
      else
        data = {
          claimed: !state.conflict,
          conflict: state.conflict,
          session: { coordinationId: "claim-a" },
        };
    } else if (req.url.endsWith("/coordination")) {
      data = {
        nextAction: "Inspect current evidence.",
        session:
          kind === "node-run"
            ? { status: "active", claimedByRun: state.owner }
            : {
                status: "active",
                coordinationId: "claim-a",
                deadlineAt: new Date(Date.now() + 60000).toISOString(),
                closedAt: null,
              },
      };
    } else if (req.url.startsWith("/api/v1/knowledge/")) {
      if (state.guideFails) {
        res.statusCode = 503;
        data = { error: "unavailable" };
      } else
        data = {
          id: req.url.split("/").at(-1),
          sourceRef: `guide:${state.guide}`,
          content: state.guide,
        };
    } else
      data = {
        id: "task.1000",
        revision: 4,
        status: "needs_merge",
        pr: "https://example.test/pr/1",
      };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(data));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(cwd, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const env = {
    COGNI_NODE_API_KEY: "node-secret",
    COGNI_NODE_URL: origin,
    CODEX_THREAD_ID: "native-a",
  };
  return { cwd, state, origin, env, call: (args) => run(args, env, cwd) };
}

test("reject unsafe origins and unknown/cross-origin discovery before writes", () => {
  for (const value of [
    "http://example.com",
    "https://u:p@example.com",
    "https://example.com/path",
  ])
    assert.throws(() => nodeOrigin(value));
  assert.throws(() =>
    profileFor(
      {
        actions: {
          updateWorkItem: {
            method: "PATCH",
            endpoint: "https://other.test/api/v1/work/items/{id}",
          },
        },
      },
      "https://node.test"
    )
  );
});

test("node claim returns guidance; refresh is read-only; editing guidance changes the receipt", async (t) => {
  const f = await fixture(t);
  const first = await f.call(["claim", "task.1000"]);
  assert.equal(first.result, "mutation_succeeded");
  assert.equal(first.context.ownership, "verified_current_claim");
  assert.equal(first.context.profile.cas, false);
  assert.equal(
    f.state.calls.find((x) => x.method === "POST").body.runId,
    "native-a"
  );
  f.state.guide =
    "Read current PR head, inspect CI, then inspect independent review.";
  const refreshed = await f.call(["next", "task.1000"]);
  assert.notEqual(
    first.context.guides[0].sha256,
    refreshed.context.guides[0].sha256
  );
  assert.equal(f.state.calls.filter((x) => x.method !== "GET").length, 1);
  const reads = f.state.calls.length;
  const resumed = await f.call(["session-start"]);
  assert.match(resumed.hookContext, /CACHED WORKFLOW CONTEXT/);
  assert.match(resumed.hookContext, /then inspect independent review/);
  assert.equal(
    f.state.calls.length,
    reads,
    "SessionStart must perform no network IO"
  );
  await assert.rejects(
    f.call([
      "update",
      "task.1000",
      "--body",
      '{"expectedRevision":4,"set":{"status":"needs_closeout"}}',
    ]),
    /does not expose PATCH CAS/
  );
  assert.equal(f.state.calls.filter((x) => x.method !== "GET").length, 1);
});

test("successful mutation plus failed guidance refresh never repeats the mutation", async (t) => {
  const f = await fixture(t);
  f.state.guideFails = true;
  const failed = await f.call(["claim", "task.1000"]);
  assert.equal(failed.result, "mutation_succeeded_guidance_unavailable");
  f.state.guideFails = false;
  assert.equal(
    (await f.call(["next", "task.1000"])).context.ownership,
    "verified_current_claim"
  );
  assert.equal(f.state.calls.filter((x) => x.method === "POST").length, 1);
});

test("node-native PR link uses advertised PATCH; absent CAS remains explicit", async (t) => {
  const f = await fixture(t);
  const result = await f.call([
    "link-pr",
    "task.1000",
    "--body",
    '{"pr":"https://example.test/pr/2","branch":"feature"}',
  ]);
  assert.equal(result.result, "mutation_succeeded");
  const write = f.state.calls.find((x) => x.method !== "GET");
  assert.equal(write.method, "PATCH");
  assert.deepEqual(write.body, {
    set: { pr: "https://example.test/pr/2", branch: "feature" },
  });
  assert.equal(result.context.profile.cas, false);
});

test("both HTTP 200 operator claim conflict and native 409 never bind", async (t) => {
  for (const kind of ["operator-session", "node-run"]) {
    const f = await fixture(t, kind);
    f.state.conflict = true;
    const result = await f.call(["claim", "task.1000"]);
    assert.equal(
      result.result,
      kind === "node-run" ? "mutation_failed" : "claim_not_acquired"
    );
    assert.match(
      (await f.call(["session-start"])).hookContext,
      /no verified work-item binding/
    );
  }
});

test("operator CAS is required and successful PATCH returns preserved result plus guidance", async (t) => {
  const f = await fixture(t, "operator-session");
  await assert.rejects(
    f.call([
      "update",
      "task.1000",
      "--body",
      '{"set":{"status":"needs_merge"}}',
    ]),
    /expectedRevision is required/
  );
  const result = await f.call([
    "update",
    "task.1000",
    "--body",
    '{"expectedRevision":4,"set":{"status":"needs_merge"}}',
  ]);
  assert.equal(result.result, "mutation_succeeded");
  assert.equal(result.mutation.data.revision, 4);
  assert.equal(result.context.profile.cas, true);
  assert.equal(f.state.calls.filter((x) => x.method !== "GET").length, 1);
});

test("unknown write outcome is returned without replay; local cache failure preserves a committed result", async (t) => {
  const f = await fixture(t);
  f.state.unknownWrite = true;
  assert.equal(
    (await f.call(["claim", "task.1000"])).result,
    "mutation_outcome_unknown"
  );
  assert.equal(f.state.calls.filter((x) => x.method !== "GET").length, 1);
  f.state.unknownWrite = false;
  await mkdir(join(f.cwd, ".cogni"));
  await writeFile(join(f.cwd, ".cogni", ".work-item-context"), "obstruction");
  const result = await f.call(["claim", "task.1000"]);
  assert.equal(result.result, "mutation_succeeded_guidance_unavailable");
  assert.equal(result.mutation.ok, true);
});

test("cross-hub reads use explicitly separate credentials and never forward the node key", async (t) => {
  const node = await fixture(t);
  const guide = await fixture(t);
  await writeFile(
    join(node.cwd, "guidance.env"),
    "COGNI_NODE_API_KEY=guide-secret\n"
  );
  await writeFile(
    join(node.cwd, "node.env"),
    `COGNI_NODE_API_KEY=explicit-node-secret\nCOGNI_NODE_URL=${node.origin}\n`
  );
  await assert.rejects(
    node.call(["next", "task.1000", "--guide-origin", guide.origin]),
    /explicit --guide-env-file/
  );
  const result = await node.call([
    "next",
    "task.1000",
    "--env-file",
    "node.env",
    "--guide-origin",
    guide.origin,
    "--guide-env-file",
    "guidance.env",
  ]);
  assert.equal(result.result, "context_refreshed");
  assert.equal(
    node.state.calls.find((x) => x.path.endsWith("task.1000")).key,
    "Bearer explicit-node-secret"
  );
  assert.equal(guide.state.calls.at(-1).key, "Bearer guide-secret");
  assert.ok(!guide.state.calls.some((x) => x.key === "Bearer node-secret"));
  assert.equal(result.context.guideOrigin, guide.origin);
  await writeFile(
    join(node.cwd, "guidance.env"),
    "COGNI_NODE_API_KEY=node-secret\nCOGNI_OPERATOR_NODE_API_KEY=existing-operator-reader\n"
  );
  await node.call([
    "next",
    "task.1000",
    "--guide-origin",
    guide.origin,
    "--guide-env-file",
    "guidance.env",
  ]);
  assert.equal(guide.state.calls.at(-1).key, "Bearer existing-operator-reader");
  await writeFile(
    join(node.cwd, "guidance.env"),
    "COGNI_NODE_API_KEY=node-secret\n"
  );
  await assert.rejects(
    node.call([
      "next",
      "task.1000",
      "--guide-origin",
      guide.origin,
      "--guide-env-file",
      "guidance.env",
    ]),
    /refusing to forward/
  );
});

test("explicit node credential file also isolates origin from the parent process", async (t) => {
  const node = await fixture(t);
  const parent = await fixture(t, "operator-session");
  await writeFile(
    join(node.cwd, "child.env"),
    `COGNI_NODE_API_KEY=child-key\nCOGNI_NODE_URL=${node.origin}\n`
  );
  const env = {
    ...node.env,
    COGNI_NODE_URL: parent.origin,
    COGNI_NODE_API_KEY: "parent-key",
  };
  const result = await run(
    ["next", "task.1000", "--env-file", "child.env"],
    env,
    node.cwd
  );
  assert.equal(result.context.nodeUrl, node.origin);
  assert.equal(
    node.state.calls.find((x) => x.path.endsWith("task.1000")).key,
    "Bearer child-key"
  );
  assert.equal(
    parent.state.calls.length,
    0,
    "the parent origin must not receive the child credential"
  );
  await writeFile(
    join(node.cwd, "child.env"),
    "COGNI_NODE_API_KEY=child-key\n"
  );
  await assert.rejects(
    run(["next", "task.1000", "--env-file", "child.env"], env, node.cwd),
    /COGNI_NODE_URL/
  );
  assert.equal(parent.state.calls.length, 0);
});

test("known-success claim with missing guidance resumes through read-only recovery without a repeated claim", async (t) => {
  const node = await fixture(t);
  const guide = await fixture(t);
  await writeFile(
    join(node.cwd, "child.env"),
    `COGNI_NODE_API_KEY=child-key\nCOGNI_NODE_URL=${node.origin}\n`
  );
  await writeFile(
    join(node.cwd, "reader.env"),
    "COGNI_OPERATOR_NODE_API_KEY=reader-key\n"
  );
  guide.state.guideFails = true;
  const result = await node.call([
    "claim",
    "task.1000",
    "--env-file",
    "child.env",
    "--guide-origin",
    guide.origin,
    "--guide-env-file",
    "reader.env",
  ]);
  assert.equal(result.result, "mutation_succeeded_guidance_unavailable");
  const calls = node.state.calls.length + guide.state.calls.length;
  const resumed = await node.call(["session-start"]);
  assert.match(resumed.hookContext, /known.success|known claim/i);
  assert.match(resumed.hookContext, /read.only next/i);
  assert.match(resumed.hookContext, /reader\.env/);
  assert.match(resumed.hookContext, /child\.env/);
  assert.ok(resumed.hookContext.includes(guide.origin));
  assert.doesNotMatch(resumed.hookContext, /then claim|--body/);
  assert.equal(
    calls,
    node.state.calls.length + guide.state.calls.length,
    "recovery presentation stays offline"
  );
  assert.equal(node.state.calls.filter((x) => x.method === "POST").length, 1);
});

test("stale claim, another native thread and read-only inspection do not create ownership", async (t) => {
  const f = await fixture(t);
  await f.call(["next", "task.1000"]);
  assert.match(
    (await f.call(["session-start"])).hookContext,
    /no verified work-item binding/
  );
  await f.call(["claim", "task.1000"]);
  const other = await run(
    ["session-start"],
    { ...f.env, CODEX_THREAD_ID: "native-b" },
    f.cwd
  );
  assert.match(other.hookContext, /no verified work-item binding/);
  f.state.owner = "native-b";
  assert.equal(
    (await f.call(["next", "task.1000"])).context.ownership,
    "unbound_or_stale_read_only"
  );
  const files = await readdir(join(f.cwd, ".cogni", ".work-item-context"));
  assert.equal(files.length, 1);
  const saved = JSON.parse(
    await readFile(
      join(f.cwd, ".cogni", ".work-item-context", files[0]),
      "utf8"
    )
  );
  assert.equal(
    saved.claimIdentity,
    "native-a",
    "refresh cannot rebind to someone else's lease"
  );
});
