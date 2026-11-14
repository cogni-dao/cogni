// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO
/**
 * Module: `@scripts/lib/secrets-catalog-loader`
 * Purpose: Walk per-node + operator-domain YAML catalogs, validate via Zod, and emit the Secret[] + SecretRouting shapes that setup-secrets.ts consumes.
 * Scope: Pure data loading and validation only. Does NOT shell out to gh, does NOT write any GitHub or filesystem state beyond reading catalog YAML files via readFileSync.
 * Invariants: every entry has a tier; per-node `service:` matches parent dir; names unique across catalogs.
 * Side-effects: IO (readFileSync of catalog YAML; one execSync to resolve git repo root)
 * Links: docs/design/secrets-catalog-per-node.md, https://node-template.cognidao.org/knowledge/secrets-routing-tiers
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type SecretCapability,
  SecretEnvironmentSchema,
  type SecretGenerate,
  type SecretSyncTarget,
  type SecretsCatalogEntry,
  SecretsCatalogFileSchema,
  type SecretTier,
  type SecretTransform,
} from "@cogni/node-declarations";
import { parse as parseYaml } from "yaml";

// ── Generators ─────────────────────────────────────────────────────────────
// Kept here (not in setup-secrets.ts) so the YAML `generate.kind` discriminator
// resolves to a function at catalog-load time. New kinds: add a case below.

function rand64(bytes = 32): string {
  return execSync(`openssl rand -base64 ${bytes}`).toString().trim();
}
function randHex(bytes = 32): string {
  return execSync(`openssl rand -hex ${bytes}`).toString().trim();
}
function deriveCogniNodeDbs(): string {
  const root = execSync("git rev-parse --show-toplevel", {
    encoding: "utf-8",
  }).trim();
  return readdirSync(join(root, "nodes"))
    .filter(
      (d) =>
        d !== "node-template" &&
        existsSync(join(root, "nodes", d, ".cogni", "repo-spec.yaml"))
    )
    .map((d) => `cogni_${d}`)
    .join(",");
}
function deriveCogniNodeEndpoints(): string {
  const root = execSync("git rev-parse --show-toplevel", {
    encoding: "utf-8",
  }).trim();
  const portMap: Record<string, number> = {
    operator: 30000,
    poly: 30100,
    resy: 30300,
  };
  return readdirSync(join(root, "nodes"))
    .filter(
      (d) =>
        d !== "node-template" &&
        existsSync(join(root, "nodes", d, ".cogni", "repo-spec.yaml"))
    )
    .map((d) => {
      const spec = readFileSync(
        join(root, "nodes", d, ".cogni", "repo-spec.yaml"),
        "utf-8"
      );
      const nodeId = spec.match(/^node_id:\s*"([^"]+)"/m)?.[1] ?? d;
      const port = portMap[d] ?? 30000;
      return `${nodeId}=http://host.docker.internal:${port}/api/internal/billing/ingest`;
    })
    .join(",");
}

// ── Schema ──────────────────────────────────────────────────────────────────
// The entry schema lives in @cogni/repo-spec so the node-deploy verb parses a
// node's catalog with the SAME schema (CATALOG_IS_THE_ONE_READER, bug.5254).
// Imported by source path so `tsx` callers need no package build.

export type Capability = SecretCapability;
export type SyncTarget = SecretSyncTarget;

/**
 * Non-node PLATFORM SERVICES that own their own OpenBao bucket + ExternalSecret.
 *
 * A "node" is a bundle of services (https://cognidao.org/knowledge/node-baas-substrate-model), and Invariant 1 makes
 * `<service>` the catalog name in `cogni/<env>/<service>/<KEY>` — so a service whose blast
 * radius must NOT be the owning node's gets its own `<service>` rather than borrowing the
 * node's. That is the whole point: the operator app consumes the ENTIRE `cogni/<env>/operator`
 * bucket via `dataFrom: extract`, so anything parked there is readable by the public app.
 *
 * Membership is a SECURITY BOUNDARY, not a convenience — adding a name here declares a new
 * OpenBao path that needs its own dedicated ExternalSecret + least-privilege pod projection.
 * Keep it short and justify every entry.
 *
 * - `akash-tx-actuator`: the private Akash transaction actuator (task.5102). It holds the
 *   operator sponsor wallet's Console credential and the bearer token that unlocks it; an
 *   operator-app compromise must not reach either (story.5016 secret-boundary amendments).
 * - `database-reliability-actuator`: a private control process whose dedicated OpenBao
 *   bucket contains the generated, least-privilege Postgres control DSN and status-read
 *   bearer (tasks 5246/5247). The public operator receives only the latter.
 * - `database-reliability-readmitter`: a separate human-command process whose bucket
 *   contains the readmit-only Postgres DSN and narrow command bearer.
 *
 * These are NOT nodes: they receive no node DNS, no node DB, and no NODE_BASELINE_KEYS
 * fan-out. `_node_gets_key` already drops a `service:`-pinned key from every node whose name
 * does not match, so declaring one here cannot leak it into a node bucket.
 */
export const PLATFORM_SERVICES: ReadonlySet<string> = new Set([
  "akash-tx-actuator",
  "database-reliability-actuator",
  "database-reliability-readmitter",
]);

/** setup-secrets must never mirror private platform-service values to GitHub. */
export function isSetupSecretsManaged(
  name: string,
  routing: Readonly<Record<string, SecretRouting>>
): boolean {
  const route = routing[name];
  // Private node-scoped DB components are composed by the sole OpenBao writer,
  // including dynamic per-cell banks. They are not GitHub setup inputs.
  if (
    route?.tier === "A1" &&
    route.appliesTo === "database" &&
    route.consumedBy?.includes("compose") &&
    !route.consumedBy.includes("pod")
  )
    return false;
  const service = route?.service;
  return service === undefined || !PLATFORM_SERVICES.has(service);
}

type CatalogEntry = SecretsCatalogEntry;
const CatalogFileSchema = SecretsCatalogFileSchema;

// ── Public types (mirror setup-secrets.ts shapes) ──────────────────────────

export interface Secret {
  name: string;
  required: boolean;
  category: string;
  description: string;
  source: "agent" | "human" | "derived";
  syncTo?: SyncTarget;
  url?: string;
  steps: string[];
  generate?: () => string;
  perEnv?: boolean;
  repoLevel?: boolean;
  transform?: (value: string) => string;
}

export type Tier = SecretTier;
export interface SecretRouting {
  tier: Tier;
  service?: string;
  /** Capability gate (v2). When set, the write side fans this secret to every
   *  in-scope type:node instead of a single `service`. */
  appliesTo?: Capability;
  /** `true` → one value at `cogni/<env>/_shared/<KEY>` for all in-scope nodes;
   *  default → distinct value per node at `cogni/<env>/<node>/<KEY>`. */
  shared?: boolean;
  /** Per-node materialization inherits this key verbatim from
   *  `cogni/<env>/<inheritFrom>/<KEY>` (canonical-custody lane) instead of the
   *  blind ancestor scan. Set when the value must byte-match one owner. */
  inheritFrom?: string;
  /** Select a lane-owned producer without changing the other lanes' owner. */
  inheritEnvironmentByLane?: Partial<
    Record<"candidate-a" | "preview" | "production", "lane" | "control">
  >;
  /** Explicit consumption destinations. `pod` ∈ consumedBy ⟹ the key fans out
   *  to node-app pods (the print-pod-keys universe). Absent ⟹ defaulted from
   *  tier+path by the emitter. */
  consumedBy?: ("pod" | "compose" | "worker")[];
}

// ── Loader ──────────────────────────────────────────────────────────────────

export interface LoadOptions {
  repoRoot: string;
  /** Glob-equivalent: `nodes/*\/.cogni/secrets-catalog.yaml`. */
  nodesDir?: string;
  /** Single operator-domain catalog file. */
  operatorCatalogPath?: string;
}

export interface LoadResult {
  secrets: Secret[];
  routing: Record<string, SecretRouting>;
}

export function loadSecretsCatalog(opts: LoadOptions): LoadResult {
  const nodesDir = opts.nodesDir ?? "nodes";
  const operatorCatalogPath =
    opts.operatorCatalogPath ?? "infra/secrets-catalog.yaml";

  const allEntries: { entry: CatalogEntry; source: string }[] = [];

  // 1. Walk per-node files: nodes/<node>/.cogni/secrets-catalog.yaml
  const nodesAbsDir = join(opts.repoRoot, nodesDir);
  if (existsSync(nodesAbsDir)) {
    for (const nodeName of readdirSync(nodesAbsDir)) {
      const filePath = join(
        nodesAbsDir,
        nodeName,
        ".cogni",
        "secrets-catalog.yaml"
      );
      if (!existsSync(filePath)) continue;
      const parsed = parseFile(filePath);
      for (const entry of parsed.secrets) {
        if (entry.service && entry.service !== nodeName) {
          throw new Error(
            `${filePath}: entry ${entry.name} has service: "${entry.service}" but lives under nodes/${nodeName}/. Service must match the parent node directory.`
          );
        }
        entry.service = entry.service ?? nodeName;
        allEntries.push({ entry, source: filePath });
      }
    }
  }

  // 2. Load operator-domain catalog (single file).
  // Build the set of valid operator-catalog `service:` values: pseudo-services
  // (_shared/_system) + present-day node directories + canonical-but-future
  // node domains from https://node-template.cognidao.org/knowledge/node-ci-sovereignty (poly, resy). The future-domain
  // allowlist exists so A2 placeholder entries in node-template baseline
  // don't fail the loader before cogni-poly imports them. Catches typos like
  // `service: nodee-template` that would otherwise produce an unreconcilable
  // OpenBao path silently.
  const knownNodes = existsSync(nodesAbsDir)
    ? new Set(readdirSync(nodesAbsDir))
    : new Set<string>();
  const CANONICAL_FUTURE_DOMAINS = new Set([
    "poly",
    "resy",
    "node-template",
    "operator",
  ]);
  // Capability-gated baseline entries declare `appliesTo:` instead of
  // `service:` (v2) — they skip this allowlist (service is undefined). This set
  // only validates entries that pin a single `service:`.
  const operatorServiceAllowlist = new Set<string>([
    "_shared",
    "_system",
    ...knownNodes,
    ...CANONICAL_FUTURE_DOMAINS,
    ...PLATFORM_SERVICES,
  ]);

  const operatorAbs = join(opts.repoRoot, operatorCatalogPath);
  if (existsSync(operatorAbs)) {
    const parsed = parseFile(operatorAbs);
    for (const entry of parsed.secrets) {
      if (entry.workloads !== undefined)
        throw new Error(
          `${operatorAbs}: entry ${entry.name} declares workloads:, which only a node catalog may set (bug.5254).`
        );
      if (
        entry.service !== undefined &&
        !operatorServiceAllowlist.has(entry.service)
      ) {
        throw new Error(
          `${operatorAbs}: entry ${entry.name} declares service: "${entry.service}" which is not one of [${[...operatorServiceAllowlist].sort().join(", ")}]. Add a nodes/<name>/ directory or use _shared/_system; for future-node placeholders, the name must match a canonical domain in https://node-template.cognidao.org/knowledge/node-ci-sovereignty.`
        );
      }
      allEntries.push({ entry, source: operatorAbs });
    }
  }

  // 3. Validate uniqueness.
  const seenNames = new Map<string, string>();
  for (const { entry, source } of allEntries) {
    const prior = seenNames.get(entry.name);
    if (prior) {
      throw new Error(
        `Secret name collision: ${entry.name} declared in both ${prior} and ${source}.`
      );
    }
    seenNames.set(entry.name, source);
  }

  // 4. Build Secret[] and routing record.
  const secrets: Secret[] = [];
  const routing: Record<string, SecretRouting> = {};
  for (const { entry } of allEntries) {
    secrets.push(catalogEntryToSecret(entry));
    const r: SecretRouting = { tier: entry.tier };
    if (entry.service !== undefined) r.service = entry.service;
    if (entry.appliesTo !== undefined) r.appliesTo = entry.appliesTo;
    if (entry.shared !== undefined) r.shared = entry.shared;
    if (entry.inheritFrom !== undefined) r.inheritFrom = entry.inheritFrom;
    if (entry.inheritEnvironmentByLane !== undefined)
      r.inheritEnvironmentByLane = entry.inheritEnvironmentByLane;
    if (entry.consumedBy !== undefined) r.consumedBy = entry.consumedBy;
    routing[entry.name] = r;
  }

  return { secrets, routing };
}

/** Resolve byte authority once; custody/writer identity do not change. */
export function inheritedSecretOwner(
  routing: SecretRouting,
  laneInput: string,
  controlInput: string
): { environment: string; service: string } | null {
  const lane = SecretEnvironmentSchema.parse(laneInput);
  const control = SecretEnvironmentSchema.parse(controlInput);
  if (!routing.inheritFrom) return null;
  const selector = routing.inheritEnvironmentByLane?.[lane] ?? "control";
  return {
    environment: selector === "lane" ? lane : control,
    service: routing.inheritFrom,
  };
}

/**
 * Resolve the OpenBao path a secret lands at for a given node + env — the
 * fan-out path resolution (design.secrets-catalog-per-node §Amendment v2):
 *   - `service: <x>`        → cogni/<env>/<x>/<KEY>        (A2 / _shared / _system)
 *   - `appliesTo`, shared   → cogni/<env>/_shared/<KEY>    (one value, all nodes)
 *   - `appliesTo`, !shared  → cogni/<env>/<node>/<KEY>     (distinct value per node)
 * Returns null for non-OpenBao secrets (B/D/E — no service, no appliesTo).
 */
export function openBaoPathFor(
  routing: SecretRouting,
  name: string,
  node: string,
  env: string
): string | null {
  if (routing.service !== undefined) {
    return `cogni/${env}/${routing.service}/${name}`;
  }
  if (routing.appliesTo !== undefined) {
    const svc = routing.shared ? "_shared" : node;
    return `cogni/${env}/${svc}/${name}`;
  }
  return null;
}

function parseFile(filePath: string): { secrets: CatalogEntry[] } {
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(filePath, "utf-8"));
  } catch (e) {
    throw new Error(`${filePath}: YAML parse error — ${(e as Error).message}`);
  }
  const result = CatalogFileSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `${filePath}: schema error — ${JSON.stringify(result.error.issues, null, 2)}`
    );
  }
  return result.data;
}

function catalogEntryToSecret(entry: CatalogEntry): Secret {
  const secret: Secret = {
    name: entry.name,
    required: entry.required,
    category: entry.category,
    description: entry.description,
    source: entry.source,
    steps: entry.steps,
  };
  if (entry.url !== undefined) secret.url = entry.url;
  if (entry.syncTo !== undefined) secret.syncTo = entry.syncTo;
  if (entry.perEnv !== undefined) secret.perEnv = entry.perEnv;
  if (entry.repoLevel !== undefined) secret.repoLevel = entry.repoLevel;
  if (entry.generate !== undefined) {
    secret.generate = generatorFor(entry.generate);
  }
  if (entry.transform !== undefined) {
    secret.transform = transformerFor(entry.transform);
  }
  return secret;
}

function generatorFor(g: SecretGenerate): () => string {
  switch (g.kind) {
    case "base64":
      return () => rand64(g.bytes);
    case "hex":
      return () => randHex(g.bytes);
    case "sk-cogni":
      return () => `sk-cogni-${randHex(g.randHexBytes)}`;
    case "static":
      return () => g.value;
    case "special-cased-by-main":
      // Generator handled by setup-secrets.ts main loop, not by this loader.
      // The thrower fires loudly if the main loop forgets to special-case
      // a new entry that declares this kind — caught at runtime on the
      // first non-special-cased invocation, not silently no-op.
      return () => {
        throw new Error(
          `setup-secrets: ${g.specialName} declares generate.kind=special-cased-by-main but the main loop did not invoke its dedicated path. Add a case in setup-secrets.ts main() for this name, or pick a real generator kind.`
        );
      };
    case "derived":
      if (g.source === "node-dbs") return deriveCogniNodeDbs;
      return deriveCogniNodeEndpoints;
    case "derive-env":
      return () =>
        // Match any `${...}` substitution token so typos surface loud (a
        // lowercase `${domain}` would otherwise pass through into the URL
        // literally — Node's URL parser would percent-encode the braces and
        // accept the malformed host, recreating the same silent-CSRF class
        // of bug this generator exists to prevent).
        g.template.replace(/\$\{([^}]+)\}/g, (_, name) => {
          if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
            throw new Error(
              `derive-env: template "${g.template}" contains \${${name}} which is not a valid env var name (must match [A-Z_][A-Z0-9_]*).`
            );
          }
          const v = process.env[name];
          if (v === undefined || v === "") {
            throw new Error(
              `derive-env: template "${g.template}" references env var ${name} which is not set. Source .env.<env> before invoking the generator.`
            );
          }
          return v;
        });
  }
}

function transformerFor(t: SecretTransform): (value: string) => string {
  switch (t.kind) {
    case "append-path":
      return (v: string) => {
        const base = v.replace(/\/+$/, "");
        return base.includes(t.path) ? base : `${base}${t.path}`;
      };
  }
}
