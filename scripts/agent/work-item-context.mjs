// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/agent/work-item-context`
 * Purpose: Return node-owned workflow guidance alongside existing work-item API results.
 * Scope: External-agent CLI and offline Codex SessionStart projection. Does not implement a stage engine or server policy.
 * Invariants: NODE_CREDENTIAL_ONLY, SAME_ORIGIN, READ_NEVER_ADVANCES, NEVER_REPLAY_WRITES.
 * Side-effects: IO (explicit HTTP mutations and disposable per-native-session context cache).
 * Links: https://cognidao.org/work/items/task.5300, .codex/config.toml
 * Usage: node scripts/agent/work-item-context.mjs claim|update|link-pr|next ITEM
 *   --node-url https://your-node.example --body '{...}' [--guide entry-id]
 *   session-start reads only this native session's local projection, never the network.
 * @public
 */

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CORE_GUIDE = "cicd-e2e-required-sequence";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const validId = (id) => /^(task|bug|story|spike|subtask)\.\d+$/.test(id);
const validGuide = (id) => /^[a-z0-9][a-z0-9-]{0,159}$/.test(id);

export function nodeOrigin(value) {
  const url = new URL(value);
  if (
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      )) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error(
      "node-url must be an HTTPS origin (HTTP loopback allowed for tests)"
    );
  return url.origin;
}

export function profileFor(discovery, origin) {
  const endpoints = discovery.endpoints ?? {};
  const actions = discovery.actions ?? {};
  const expected = (endpoint, path) => endpoint === `${origin}${path}`;
  const patch = actions.updateWorkItem;
  if (
    !expected(patch?.endpoint, "/api/v1/work/items/{id}") ||
    patch.method !== "PATCH"
  ) {
    throw new Error(
      "Unsupported discovery: no same-origin work-item PATCH contract"
    );
  }
  const runClaim = actions.claimWorkItem;
  if (
    expected(runClaim?.endpoint, "/api/v1/work/items/{id}/claims") &&
    runClaim.method === "POST" &&
    runClaim.inputSchema?.required?.includes("runId") &&
    expected(
      actions.getWorkItemCoordination?.endpoint,
      "/api/v1/work/items/{id}/coordination"
    )
  )
    return {
      kind: "node-run",
      cas: !!patch.inputSchema?.properties?.expectedRevision,
    };
  if (
    expected(endpoints.workItemClaim, "/api/v1/work/items/{id}/claims") &&
    expected(endpoints.workItemPr, "/api/v1/work/items/{id}/pr") &&
    expected(
      endpoints.workItemCoordination,
      "/api/v1/work/items/{id}/coordination"
    ) &&
    patch.inputSchema?.properties?.expectedRevision
  )
    return { kind: "operator-session", cas: true };
  throw new Error(
    "Unsupported work-item claim/coordination contracts; no mutation attempted"
  );
}

export function parseEnv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(
      /^(?:export\s+)?(COGNI_NODE_API_KEY|COGNI_OPERATOR_NODE_API_KEY|COGNI_NODE_URL)\s*=\s*(.*?)\s*$/
    );
    if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return values;
}

function optionsFrom(argv) {
  const [operation, ...rest] = argv;
  const options = { operation };
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith("--") && !options.itemId) options.itemId = rest[i];
    else if (
      [
        "--node-url",
        "--env-file",
        "--guide",
        "--guide-origin",
        "--guide-env-file",
        "--body",
        "--session-id",
      ].includes(rest[i]) &&
      rest[i + 1]
    ) {
      options[rest[i].slice(2)] = rest[++i];
    } else throw new Error(`Unknown or incomplete argument: ${rest[i]}`);
  }
  return options;
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    // A broken disposable projection must not invent ownership or prevent an
    // explicit item refresh. Authority comes from the remote claim readback.
    return undefined;
  }
}

async function saveJson(path, value) {
  await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, path);
}

async function request(origin, path, key, method = "GET", body) {
  const reqId = `workflow_${randomUUID()}`;
  let response;
  try {
    response = await fetch(`${origin}${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: {
        "User-Agent": "cogni-work-item-context/1",
        "x-request-id": reqId,
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    const data = JSON.parse(text);
    return {
      ok: response.ok,
      status: response.status,
      reqId: response.headers.get("x-request-id") ?? reqId,
      data,
    };
  } catch {
    // A transport/parse failure after a write may have committed. Never retry here.
    return {
      ok: false,
      status: response?.status,
      reqId,
      unavailable: true,
      error: method === "GET" ? "read_unavailable" : "mutation_outcome_unknown",
    };
  }
}

function owns(binding, coordination, profile) {
  const session = coordination?.session;
  if (!binding || !session) return false;
  if (profile.kind === "node-run") {
    return (
      session.status === "active" &&
      session.claimedByRun === binding.claimIdentity
    );
  }
  return (
    session.coordinationId === binding.claimIdentity &&
    !session.closedAt &&
    ["active", "idle"].includes(session.status) &&
    Date.parse(session.deadlineAt) > Date.now()
  );
}

/** One invocation; exported only for lightweight boundary tests with real HTTP. */
export async function run(
  argv,
  env = process.env,
  cwd = process.cwd(),
  hookInput
) {
  const options = optionsFrom(argv);
  const allowed = ["claim", "update", "link-pr", "next", "session-start"];
  if (!allowed.includes(options.operation))
    throw new Error(
      `Usage: ${allowed.join("|")} ITEM [--node-url ORIGIN] [--body JSON] [--guide ID]`
    );
  let root;
  try {
    root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new Error("Run inside the target node's Git checkout");
  }
  const sessionId =
    options["session-id"] ?? env.CODEX_THREAD_ID ?? hookInput?.session_id;
  const cachePath =
    sessionId &&
    join(root, ".cogni", ".work-item-context", `${hash(sessionId)}.json`);
  let binding = cachePath && (await readJson(cachePath));
  if (binding && binding.sessionId !== sessionId) binding = undefined;

  if (options.operation === "session-start") {
    if (!binding)
      return {
        hookContext:
          "Cogni workflow: no verified work-item binding for this native session. Identify the explicit item and node, inspect current coordination, and claim only if not already held. Do not infer ownership from the branch or replay a mutation to repair missing context.",
      };
    const refresh = binding.refreshCommand
      ? `Refresh command argv (contains no credential): ${JSON.stringify(binding.refreshCommand)}`
      : "Reuse the original explicit node/item and credential/source options for next; this older projection does not retain those pointers.";
    if (!binding.context)
      return {
        hookContext: `KNOWN CLAIM — the claim for ${binding.itemId} on ${binding.nodeUrl} previously succeeded, but guidance was unavailable. Do not repeat the claim. Run read-only next, revalidate current ownership, and obtain live guidance before dependent work.\n${refresh}`,
      };
    return {
      hookContext: `CACHED WORKFLOW CONTEXT — not current authority. Before dependent work run read-only next for ${binding.itemId} on ${binding.nodeUrl}; revalidate ownership and live guidance. Do not replay prior mutations.\n${refresh}\n${JSON.stringify(binding.context)}`,
    };
  }

  const fileEnv = parseEnv(
    await readFile(
      resolve(root, options["env-file"] ?? ".env.cogni"),
      "utf8"
    ).catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    })
  );
  // An explicit env file is a separate node's credential compartment. Never let
  // the parent operator key in the process environment override that selection.
  const key = options["env-file"]
    ? fileEnv.COGNI_NODE_API_KEY
    : (env.COGNI_NODE_API_KEY ?? fileEnv.COGNI_NODE_API_KEY);
  const originValue =
    options["node-url"] ??
    (options["env-file"]
      ? fileEnv.COGNI_NODE_URL
      : (env.COGNI_NODE_URL ?? fileEnv.COGNI_NODE_URL));
  if (!originValue || !key)
    throw new Error(
      "Configure this node's COGNI_NODE_URL and COGNI_NODE_API_KEY; operator CI/CD credentials are never a fallback"
    );
  const origin = nodeOrigin(originValue);
  const itemId =
    options.itemId ??
    (binding?.nodeUrl === origin ? binding.itemId : undefined);
  if (!validId(itemId ?? ""))
    throw new Error(
      "An explicit work-item id is required without a matching native-session binding"
    );
  if (binding && (binding.nodeUrl !== origin || binding.itemId !== itemId))
    binding = undefined;
  const guideOrigin = options["guide-origin"]
    ? nodeOrigin(options["guide-origin"])
    : origin;
  let guideKey = key;
  if (guideOrigin !== origin) {
    if (!options["guide-env-file"])
      throw new Error(
        "Cross-node guidance requires explicit --guide-env-file; node credentials are never forwarded to another hub"
      );
    const guideEnv = parseEnv(
      await readFile(resolve(root, options["guide-env-file"]), "utf8")
    );
    // Nodes already store their separate operator knowledge-reader principal
    // under this name. A distinct owning hub env file may instead name its own
    // NODE key. Deployment credentials are deliberately never considered.
    guideKey =
      guideEnv.COGNI_OPERATOR_NODE_API_KEY ?? guideEnv.COGNI_NODE_API_KEY;
    if (!guideKey)
      throw new Error(
        "Selected guidance file has no node or operator knowledge-reader key"
      );
    if (guideKey === key)
      throw new Error(
        "Cross-hub guidance requires a separate reader key; refusing to forward this node's credential"
      );
  }
  const requestedGuide = options.guide ?? CORE_GUIDE;
  if (!validGuide(requestedGuide)) throw new Error("Invalid guide id");
  const refreshCommand = [
    "node",
    fileURLToPath(import.meta.url),
    "next",
    itemId,
    "--node-url",
    origin,
    ...(options["env-file"]
      ? ["--env-file", resolve(root, options["env-file"])]
      : []),
    ...(guideOrigin !== origin
      ? [
          "--guide-origin",
          guideOrigin,
          "--guide-env-file",
          resolve(root, options["guide-env-file"]),
        ]
      : []),
    ...(requestedGuide !== CORE_GUIDE ? ["--guide", requestedGuide] : []),
    ...(options["session-id"] ? ["--session-id", options["session-id"]] : []),
  ];
  let body = JSON.parse(options.body ?? "{}");
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new Error("body must be a JSON object");

  const discovery = await request(origin, "/.well-known/agent.json");
  if (!discovery.ok) return { result: "guidance_unavailable", discovery };
  const profile = profileFor(discovery.data, origin);
  const path = `/api/v1/work/items/${encodeURIComponent(itemId)}`;
  const mutation = ["claim", "update", "link-pr"].includes(options.operation);
  let mutationResult;
  if (mutation) {
    let method = "POST",
      suffix = "";
    if (options.operation === "claim") {
      suffix = "/claims";
      if (profile.kind === "node-run") {
        const runId = sessionId ?? body.runId;
        if (!runId || (sessionId && body.runId && body.runId !== sessionId))
          throw new Error(
            "Node claim runId must match the native session; without native identity pass runId explicitly"
          );
        body = { ...body, runId, command: body.command ?? "/implement" };
      }
    } else if (options.operation === "update" || profile.kind === "node-run") {
      method = "PATCH";
      if (options.operation === "link-pr") {
        if (!body.pr || !body.branch)
          throw new Error("Node link-pr requires explicit pr URL and branch");
        body = {
          set: { pr: body.pr, branch: body.branch },
          ...(body.expectedRevision === undefined
            ? {}
            : { expectedRevision: body.expectedRevision }),
        };
      }
      if (!body.set || typeof body.set !== "object" || Array.isArray(body.set))
        throw new Error(
          "update requires {set:{...}}; use existing lifecycle commands to authorize advancement"
        );
      if (profile.cas && !Number.isInteger(body.expectedRevision))
        throw new Error(
          "This node supports CAS: expectedRevision is required; read current state first"
        );
      if (!profile.cas && body.expectedRevision !== undefined)
        throw new Error(
          "This node does not expose PATCH CAS; refusing to silently drop expectedRevision"
        );
    } else suffix = "/pr";
    mutationResult = await request(origin, path + suffix, key, method, body);
    if (!mutationResult.ok)
      return {
        result: mutationResult.unavailable
          ? "mutation_outcome_unknown"
          : "mutation_failed",
        mutation: mutationResult,
        instruction:
          "Do not replay blindly. Read back current state/operation receipt before deciding another write.",
      };
    if (options.operation === "claim") {
      const result = mutationResult.data;
      const successful =
        profile.kind === "node-run"
          ? result.id === itemId && result.claimedByRun === body.runId
          : result.claimed === true &&
            result.conflict === false &&
            result.session?.coordinationId;
      if (!successful)
        return {
          result: "claim_not_acquired",
          mutation: mutationResult,
          instruction:
            "No binding created; inspect claim conflict/current ownership.",
        };
      binding = sessionId
        ? {
            nodeUrl: origin,
            itemId,
            sessionId,
            refreshCommand,
            claimIdentity:
              profile.kind === "node-run"
                ? body.runId
                : result.session.coordinationId,
          }
        : undefined;
      // Persist the successful claim even if subsequent guidance acquisition fails.
      if (binding) {
        try {
          await saveJson(cachePath, binding);
        } catch {
          return {
            result: "mutation_succeeded_guidance_unavailable",
            mutation: mutationResult,
            instruction:
              "Claim succeeded but local binding could not be saved. Use explicit item reads; never repeat the mutation to repair the cache.",
          };
        }
      }
    }
  }

  const guideIds = [...new Set([CORE_GUIDE, requestedGuide])];
  const reads = await Promise.all([
    request(origin, path, key),
    request(origin, `${path}/coordination`, key),
    ...guideIds.map((id) =>
      request(guideOrigin, `/api/v1/knowledge/${id}`, guideKey)
    ),
  ]);
  const [item, coordination, ...guides] = reads;
  const unavailable =
    reads.some((r) => !r.ok) ||
    item.data?.id !== itemId ||
    guides.some(
      (g, i) =>
        g.data?.id !== guideIds[i] ||
        typeof g.data?.content !== "string" ||
        !g.data.content.trim()
    );
  if (unavailable)
    return {
      result: mutation
        ? "mutation_succeeded_guidance_unavailable"
        : "guidance_unavailable",
      mutation: mutationResult,
      reads: reads.map(({ data, ...receipt }) => receipt),
      instruction:
        "Retry only read-only next. Do not repeat a successful mutation to retrieve guidance.",
    };

  const context = {
    nodeUrl: origin,
    guideOrigin,
    itemId,
    retrievedAt: new Date().toISOString(),
    profile,
    ownership: owns(binding, coordination.data, profile)
      ? "verified_current_claim"
      : "unbound_or_stale_read_only",
    item: item.data,
    coordination: coordination.data,
    guides: guides.map((g) => ({
      id: g.data.id,
      sourceRef: g.data.sourceRef,
      sha256: hash(g.data.content),
      content: g.data.content,
      reqId: g.reqId,
    })),
    receipts: {
      item: item.reqId,
      coordination: coordination.reqId,
      discoveryBuild: discovery.data.buildSha,
    },
    instruction:
      "Read the complete owning guidance. Inspect current PR head/checks/review/scorecard/deployment evidence before selecting the first unsupported checkpoint. needs_merge is coarse. Sources and reads do not certify compliance or authorize advancement. Refresh after watchers even without status changes. Never replay completed mutations. Raw API calls bypass automatic client guidance.",
  };
  // Merely inspecting another item must never create ownership or a recovery binding.
  if (cachePath && context.ownership === "verified_current_claim") {
    try {
      await saveJson(cachePath, { ...binding, refreshCommand, context });
    } catch {
      context.cacheWarning =
        "Local recovery projection could not be saved; current context remains usable. Do not replay writes.";
    }
  }
  return {
    result: mutation ? "mutation_succeeded" : "context_refreshed",
    mutation: mutationResult,
    context,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    let hookInput;
    if (process.argv[2] === "session-start" && !process.stdin.isTTY) {
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (text) hookInput = JSON.parse(text);
    }
    const output = await run(
      process.argv.slice(2),
      process.env,
      process.cwd(),
      hookInput
    );
    if (output.hookContext) process.stdout.write(`${output.hookContext}\n`);
    else {
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
      if (!["context_refreshed", "mutation_succeeded"].includes(output.result))
        process.exitCode = 1;
    }
  } catch (error) {
    if (process.argv[2] === "session-start") {
      // Recovery notice is advisory; it cannot wedge all native agent sessions.
      process.stdout.write(
        "Cogni workflow context unavailable; use the explicit node/item read-only next before dependent work.\n"
      );
    } else {
      process.stderr.write(`work-item-context: ${error.message}\n`);
      process.exitCode = 1;
    }
  }
}
