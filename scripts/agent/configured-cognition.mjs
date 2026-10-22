// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO
/**
 * Module: scripts/agent/configured-cognition.mjs
 * Purpose: Load explicitly configured canonical knowledge through native cognition.
 * Scope: Optional node-owned context projection shared by project and installed hooks.
 * Invariants: Canonical bodies remain unchanged; loading grants no role or authority.
 *   Admit only complete node/config-bound projections; preserve a last good cache.
 *   Native imports require pre-session warming, never a retrospective hook repair.
 * Side-effects: Bounded same-node reads, atomic cache writes, optional background refresh.
 * Links: https://cognidao.org/knowledge/expertise-role-contract
 *   https://cognidao.org/knowledge/cognition-substrate-bootstrap
 */

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const CACHE = ".cogni/.cognition-cache.md";
const CONFIG = ".cogni/cognition-sources.json";
const LIMIT = 1024 * 1024;
const BUDGET = 6000;
const PREFIX = "<!-- cogni-context-v1 ";
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const read = (p) => {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
};
const keys = (v, names) =>
  v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.keys(v).sort().join() === [...names].sort().join();
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const id = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const tracked = () =>
  spawnSync("git", ["ls-files", "--error-unmatch", "--", CACHE], {
    stdio: "ignore",
  }).status === 0;

function configuration() {
  const raw = read(CONFIG);
  if (Buffer.byteLength(raw) > 8192) throw Error("config");
  const c = JSON.parse(raw);
  if (
    !keys(c, ["version", "nodeId", "requiredKnowledgeIds"]) ||
    c.version !== 1 ||
    !uuid.test(c.nodeId) ||
    !Array.isArray(c.requiredKnowledgeIds) ||
    c.requiredKnowledgeIds.length < 1 ||
    c.requiredKnowledgeIds.length > 8 ||
    c.requiredKnowledgeIds.some(
      (s) => typeof s !== "string" || s.length > 100 || !id.test(s)
    ) ||
    new Set(c.requiredKnowledgeIds).size !== c.requiredKnowledgeIds.length
  )
    throw Error("config");
  const spec = read(".cogni/repo-spec.yaml");
  const node = spec.match(
    /^node_id:\s*["']?([a-f0-9-]+)["']?\s*(?:#.*)?$/m
  )?.[1];
  if (node !== c.nodeId) throw Error("node");
  // Scan lines once: a multiline repetition of optional whitespace lines can
  // backtrack exponentially when a malformed intent block has no name.
  let inIntent = false;
  let slug;
  for (const line of spec.split("\n")) {
    if (/^intent:[ \t]*\r?$/.test(line)) {
      inIntent = true;
      continue;
    }
    if (!inIntent) continue;
    if (line && !/^[ \t\r]/.test(line)) {
      inIntent = false;
      continue;
    }
    const name = line.match(
      /^[ \t]+name:[ \t]*["']?([a-z0-9-]+)["']?[ \t]*(?:#.*)?\r?$/
    );
    if (name) {
      slug = name[1];
      break;
    }
  }
  if (!slug) throw Error("origin");
  const origin = ["operator", "cogni-template"].includes(slug)
    ? "https://cognidao.org"
    : `https://${slug}.cognidao.org`;
  return {
    ...c,
    origin,
    digest: sha(
      JSON.stringify({
        version: c.version,
        nodeId: c.nodeId,
        requiredKnowledgeIds: c.requiredKnowledgeIds,
      })
    ),
  };
}

// Generic semantic envelope and table structure, never a second field list.
function complete(base) {
  if (!/^## The agent-contract(?:\s|$)/m.test(base)) return false;
  const agent = [
    ...base.matchAll(
      /^\s*<agent-contract(?:\s[^>]*)?>\s*$([\s\S]*?)^\s*<\/agent-contract>\s*$/gm
    ),
  ];
  if (agent.length !== 1) return false;
  const process = agent[0][1].match(
    /^\s*<process-contract(?:\s[^>]*)?>\s*$([\s\S]+?)^\s*<\/process-contract>\s*$/m
  );
  const status = agent[0][1].match(
    /^\s*<status-contract(?:\s[^>]*)?>\s*$([\s\S]+?)^\s*<\/status-contract>\s*$/m
  );
  if (
    !process?.[1].trim() ||
    !status?.[1].trim() ||
    process.index > status.index
  )
    return false;
  const lines = status[1].split("\n");
  let tables = 0;
  const row = (s) =>
    /^\s*\|.*\|\s*$/.test(s) ? s.trim().slice(1, -1).split("|") : [];
  for (let i = 1; i + 1 < lines.length; i++) {
    const cells = row(lines[i]);
    if (
      cells.length >= 2 &&
      cells.every((s) => /^\s*:?-{3,}:?\s*$/.test(s)) &&
      row(lines[i - 1]).length === cells.length &&
      row(lines[i + 1]).length === cells.length
    )
      tables++;
  }
  return tables >= 2;
}

const sourceHeader = (s, origin) =>
  `\n## Required host context: ${s.id}\n\nSource: [${s.id}](${origin}/knowledge/${s.id})\n\n`;
function projection(c, base, sources) {
  const manifest = {
    version: 1,
    nodeId: c.nodeId,
    origin: c.origin,
    configDigest: c.digest,
    sources: sources.map(({ content, ...s }) => ({
      ...s,
      bytes: Buffer.byteLength(content),
      sha256: sha(content),
    })),
    bundle: { bytes: Buffer.byteLength(base), sha256: sha(base) },
  };
  return (
    `${PREFIX}${Buffer.from(JSON.stringify(manifest)).toString("base64")} -->\n` +
    sources.map((s) => `${sourceHeader(s, c.origin)}${s.content}\n`).join("") +
    "\n" +
    base
  );
}
function admitted(c) {
  if (tracked()) return null;
  const raw = read(CACHE);
  if (Buffer.byteLength(raw) > LIMIT || !raw.startsWith(PREFIX)) return null;
  try {
    const end = raw.indexOf(" -->\n");
    const m = JSON.parse(
      Buffer.from(raw.slice(PREFIX.length, end), "base64").toString("utf8")
    );
    if (
      !keys(m, [
        "version",
        "nodeId",
        "origin",
        "configDigest",
        "sources",
        "bundle",
      ]) ||
      m.version !== 1 ||
      m.nodeId !== c.nodeId ||
      m.origin !== c.origin ||
      m.configDigest !== c.digest ||
      !Array.isArray(m.sources) ||
      m.sources.length !== c.requiredKnowledgeIds.length ||
      !keys(m.bundle, ["bytes", "sha256"])
    )
      return null;
    let rest = Buffer.from(raw.slice(end + 5));
    const sources = [];
    for (let i = 0; i < m.sources.length; i++) {
      const s = m.sources[i];
      if (
        !keys(s, ["id", "sourceRef", "bytes", "sha256"]) ||
        s.id !== c.requiredKnowledgeIds[i] ||
        typeof s.sourceRef !== "string" ||
        !s.sourceRef.trim() ||
        !Number.isSafeInteger(s.bytes) ||
        s.bytes < 1 ||
        s.bytes > 65536
      )
        return null;
      const header = Buffer.from(sourceHeader(s, c.origin));
      if (!rest.subarray(0, header.length).equals(header)) return null;
      rest = rest.subarray(header.length);
      const content = rest.subarray(0, s.bytes).toString("utf8");
      if (sha(content) !== s.sha256 || rest[s.bytes] !== 10) return null;
      sources.push({ id: s.id, sourceRef: s.sourceRef, content });
      rest = rest.subarray(s.bytes + 1);
    }
    if (rest[0] !== 10) return null;
    const base = rest.subarray(1).toString("utf8");
    if (
      !Number.isSafeInteger(m.bundle.bytes) ||
      Buffer.byteLength(base) !== m.bundle.bytes ||
      sha(base) !== m.bundle.sha256 ||
      !complete(base) ||
      projection(c, base, sources) !== raw
    )
      return null;
    return { raw, base };
  } catch {
    return null;
  }
}
function credential() {
  if (process.env.COGNI_NODE_API_KEY) return process.env.COGNI_NODE_API_KEY;
  return (
    read(".env.cogni")
      .split("\n")
      .find((s) => s.startsWith("COGNI_NODE_API_KEY="))
      ?.slice(19)
      .trim()
      .replace(/^(["'])(.*)\1$/, "$2") ?? ""
  );
}
async function acquire(c) {
  const key = credential();
  if (!key) throw Error("credential");
  const children = new Set();
  const endsAt = Date.now() + BUDGET;
  const deadline = setTimeout(() => {
    for (const child of children) {
      child.stdout.destroy();
      child.kill("SIGKILL");
    }
  }, BUDGET);
  const get = (route) =>
    new Promise((resolve, reject) => {
      const remaining = endsAt - Date.now();
      if (remaining <= 0) {
        reject(Error("deadline"));
        return;
      }
      const child = spawn(
        "curl",
        [
          "--disable",
          "--fail",
          "--silent",
          "--show-error",
          "--proto",
          "=https",
          "--max-time",
          String(remaining / 1000),
          "--max-filesize",
          String(LIMIT),
          "-H",
          `Authorization: Bearer ${key}`,
          c.origin + route,
        ],
        { stdio: ["ignore", "pipe", "ignore"] }
      );
      children.add(child);
      const chunks = [];
      let size = 0;
      child.stdout.on("data", (b) => {
        size += b.length;
        if (size > LIMIT) child.kill();
        else chunks.push(b);
      });
      child.on("error", () => reject(Error("transport")));
      child.on("close", (code) => {
        children.delete(child);
        try {
          if (code !== 0 || size > LIMIT) throw Error("transport");
          resolve(
            JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(
                Buffer.concat(chunks)
              )
            )
          );
        } catch {
          reject(Error("response"));
        }
      });
    });
  try {
    const bundle = await get("/api/v1/cognition");
    if (
      bundle.node !== c.nodeId ||
      typeof bundle.markdown !== "string" ||
      !complete(bundle.markdown)
    )
      throw Error("bundle");
    const entries = await Promise.all(
      c.requiredKnowledgeIds.map((s) => get(`/api/v1/knowledge/${s}`))
    );
    const sources = entries.map((e, i) => {
      if (
        e.id !== c.requiredKnowledgeIds[i] ||
        typeof e.content !== "string" ||
        !e.content.trim() ||
        Buffer.byteLength(e.content) > 65536 ||
        typeof e.sourceRef !== "string" ||
        !e.sourceRef.trim()
      )
        throw Error("source");
      return { id: e.id, sourceRef: e.sourceRef, content: e.content };
    });
    const result = projection(c, bundle.markdown, sources);
    if (Buffer.byteLength(result) > LIMIT) throw Error("size");
    return result;
  } finally {
    clearTimeout(deadline);
    for (const child of children) child.kill();
  }
}
async function write(c, content, recovery = false) {
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  const guard = `${CACHE}.write-lock`;
  let held = false;
  for (let i = 0; i < 50; i++) {
    try {
      fs.mkdirSync(guard);
      held = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  if (!held) return;
  const temp = `${CACHE}.tmp.${process.pid}`;
  try {
    if (c) {
      if (configuration().digest !== c.digest || (recovery && admitted(c)))
        return;
    } else {
      // Revalidate under the same guard: invalid setup cannot overwrite a
      // matching complete projection installed by a concurrent setup repair.
      try {
        if (admitted(configuration())) return;
      } catch {}
    }
    fs.writeFileSync(temp, content, { mode: 0o600 });
    fs.renameSync(temp, CACHE);
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch {}
    fs.rmdirSync(guard);
  }
}
const recovery =
  "COGNI COGNITION — BOOTSTRAP RECOVERY (no complete contract)\n\nRequired configured canonical context is missing, invalid or unavailable. Stay in bounded bootstrap recovery. Check this node identity, cognition-sources.json, credentials and published source bodies. Run the shared loader once; then restart/resume so native imports receive the complete projection. Configuration is host context, not role adoption or permissions.\n";
async function main() {
  let c;
  try {
    c = configuration();
  } catch {
    if (!["--cached-contract", "--refresh"].includes(process.argv[2])) {
      await write(null, recovery, true);
      if (process.argv[2] === "--codex" || process.env.CODEX_THREAD_ID)
        process.stdout.write(recovery);
    }
    return;
  }
  if (process.argv[2] === "--cached-contract") {
    const cache = admitted(c);
    if (cache)
      process.stdout.write(
        cache.base.match(
          /^\s*<status-contract(?:\s[^>]*)?>\s*$([\s\S]*?)^\s*<\/status-contract>/m
        )?.[1] ?? ""
      );
    return;
  }
  if (process.argv[2] === "--refresh") {
    try {
      await write(c, await acquire(c));
    } catch {}
    return;
  }
  const codex =
    process.argv[2] === "--codex" || Boolean(process.env.CODEX_THREAD_ID);
  let session = process.env.CODEX_THREAD_ID ?? "";
  if (codex && !session && !process.stdin.isTTY) {
    try {
      let input = "";
      for await (const chunk of process.stdin) {
        input += chunk;
        if (input.length > 65536) break;
      }
      session = JSON.parse(input).session_id ?? "";
    } catch {}
  }
  let lock;
  if (session) {
    lock = path.join(
      process.env.TMPDIR ?? "/tmp",
      `cogni-cognition-${String(session).replace(/[^a-zA-Z0-9_-]/g, "")}.lock`
    );
    try {
      fs.mkdirSync(lock);
    } catch {
      return;
    }
  }
  try {
    let cache = admitted(c);
    if (cache) {
      if (codex) process.stdout.write(cache.raw);
      if (Date.now() - fs.statSync(CACHE).mtimeMs > 900000) {
        const child = spawn(process.execPath, [process.argv[1], "--refresh"], {
          detached: true,
          stdio: "ignore",
        });
        child.unref();
      }
      return;
    }
    try {
      await write(c, await acquire(c));
    } catch {
      await write(c, recovery, true);
    }
    cache = admitted(c);
    if (codex) process.stdout.write(cache?.raw ?? recovery);
  } finally {
    if (lock) {
      try {
        fs.rmdirSync(lock);
      } catch {}
    }
  }
}
main().catch(() => {
  // Never expose request arguments, credentials or remote errors. A write or
  // permission failure still needs honest bounded recovery on Codex's channel.
  if (
    process.argv[2] === "--codex" ||
    (process.env.CODEX_THREAD_ID &&
      !["--cached-contract", "--refresh"].includes(process.argv[2]))
  ) {
    process.stdout.write(recovery);
  }
});
