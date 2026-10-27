#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/dev/verify-local-stack`
 * Purpose: Check the actual local app, data reads, worker, gateway and Studio server.
 * Scope: Read-only local HTTP probes; does not start services or call a model.
 * Invariants: Loopback targets only. Shallow readiness and authentication alone
 *   cannot pass. Secrets and source bodies never enter the report.
 * Side-effects: IO (loopback HTTP reads; assistant search is POST; JSON on stdout; exit code).
 * Usage: pnpm dev:verify --identity .context/local-dev-identity.json
 * Links: https://cognidao.org/work/items/bug.5542
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    app: { type: "string", default: "http://localhost:3000" },
    worker: { type: "string", default: "http://localhost:9001" },
    langgraph: { type: "string", default: "http://localhost:2024" },
    identity: { type: "string" },
    knowledge: { type: "string" },
    "work-item": { type: "string" },
  },
});
if (existsSync(".env.local")) process.loadEnvFile(".env.local");

function localBase(value) {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Probe targets must be HTTP loopback origins");
  }
  return url.origin;
}

const app = localBase(values.app);
const worker = localBase(values.worker);
const langgraph = localBase(values.langgraph);
const gateway = localBase(
  process.env.LITELLM_BASE_URL || "http://localhost:4000"
);
const apiKey = values.identity
  ? JSON.parse(readFileSync(values.identity, "utf8")).apiKey
  : process.env.COGNI_LOCAL_API_KEY;
const appHeaders = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
const gatewayHeaders = process.env.LITELLM_MASTER_KEY
  ? { Authorization: `Bearer ${process.env.LITELLM_MASTER_KEY}` }
  : {};
const checks = [];

async function request(base, path, headers = {}, body) {
  const response = await fetch(`${base}${path}`, {
    headers: {
      ...headers,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    method: body ? "POST" : "GET",
    body: body ? JSON.stringify(body) : undefined,
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await response.text();
  return response.headers.get("content-type")?.includes("application/json")
    ? JSON.parse(text)
    : text;
}

async function check(name, run) {
  const started = Date.now();
  try {
    const proof = await run();
    checks.push({ name, ok: true, ms: Date.now() - started, ...proof });
  } catch (error) {
    // Keep server error bodies, credentials and source text out of this report.
    const reason = /^HTTP \d{3}$/.test(error.message)
      ? error.message
      : error.name === "TimeoutError"
        ? "timeout"
        : "unavailable or invalid response";
    checks.push({ name, ok: false, ms: Date.now() - started, reason });
  }
}

function fingerprint(text) {
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("Missing body");
  }
  return {
    bytes: Buffer.byteLength(text),
    sha256: createHash("sha256").update(text).digest("hex"),
  };
}

await Promise.all([
  check("app version", async () => {
    const result = await request(app, "/version");
    if (!result.version) throw new Error("Missing version");
    return { version: result.version, buildSha: result.buildSha ?? null };
  }),
  check("deep readiness", async () => {
    const result = await request(app, "/readyz?deep=1");
    if (result.status !== "healthy") throw new Error("Unhealthy");
    return { status: result.status };
  }),
  check("worker readiness", async () => {
    const result = await request(worker, "/readyz");
    if (result !== "ok") throw new Error("Unhealthy worker");
    return {};
  }),
  check("gateway models", async () => {
    const result = await request(gateway, "/v1/models", gatewayHeaders);
    if (!result.data?.length) throw new Error("Empty model catalog");
    return { modelCount: result.data.length };
  }),
  check("Studio Cogni discovery", async () => {
    const info = await request(langgraph, "/info");
    const assistants = await request(
      langgraph,
      "/assistants/search",
      {},
      { limit: 100 }
    );
    if (!assistants.some((assistant) => assistant.graph_id === "cogni")) {
      throw new Error("Cogni is not registered");
    }
    return { version: info.version, langsmith: info.flags?.langsmith === true };
  }),
  check("authenticated node Cogni discovery", async () => {
    if (!apiKey) throw new Error("Local identity required");
    const result = await request(app, "/api/v1/ai/agents", appHeaders);
    if (!result.agents?.some((agent) => agent.agentId === "langgraph:cogni")) {
      throw new Error("Cogni is not registered");
    }
    return {};
  }),
  check("authenticated knowledge body", async () => {
    if (!apiKey) throw new Error("Local identity required");
    const id =
      values.knowledge ||
      (await request(app, "/api/v1/knowledge?limit=1", appHeaders)).items?.[0]
        ?.id;
    if (!id) throw new Error("A local knowledge fixture is required");
    const result = await request(
      app,
      `/api/v1/knowledge/${encodeURIComponent(id)}`,
      appHeaders
    );
    if (result.id !== id) throw new Error("Wrong source");
    return { id, body: fingerprint(result.content) };
  }),
  check("authenticated work-item body", async () => {
    if (!apiKey) throw new Error("Local identity required");
    const id =
      values["work-item"] ||
      (await request(app, "/api/v1/work/items?limit=1", appHeaders)).items?.[0]
        ?.id;
    if (!id) throw new Error("A local work fixture is required");
    const result = await request(
      app,
      `/api/v1/work/items/${encodeURIComponent(id)}`,
      appHeaders
    );
    if (result.id !== id) throw new Error("Wrong source");
    return {
      id,
      revision: result.revision,
      summary: fingerprint(result.summary),
      outcome: fingerprint(result.outcome),
    };
  }),
]);

const ok = checks.every((item) => item.ok);
console.log(
  JSON.stringify(
    {
      ok,
      observedAt: new Date().toISOString(),
      scope:
        "local startup only; no inference, billing-effect or agent-quality claim",
      checks,
    },
    null,
    2
  )
);
process.exitCode = ok ? 0 : 1;
