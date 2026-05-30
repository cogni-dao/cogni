// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO
/**
 * Module: `@scripts/lib/secrets-catalog-loader`
 * Purpose: Walk per-node + operator-domain YAML catalogs, validate via Zod, and emit the Secret[] + SecretRouting shapes that setup-secrets.ts consumes.
 * Scope: Pure data loading and validation only. Does NOT shell out to gh, does NOT write any GitHub or filesystem state beyond reading catalog YAML files via readFileSync.
 * Invariants: every entry has a tier; per-node `service:` matches parent dir; names unique across catalogs.
 * Side-effects: IO (readFileSync of catalog YAML; one execSync to resolve git repo root)
 * Links: docs/design/secrets-catalog-per-node.md, docs/spec/secrets-classification.md
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

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

const TierSchema = z.enum(["A1", "A2", "B", "D", "E", "F", "G"]);

const GenerateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("base64"), bytes: z.number().int().positive() }),
  z.object({ kind: z.literal("hex"), bytes: z.number().int().positive() }),
  z.object({
    kind: z.literal("sk-cogni"),
    randHexBytes: z.number().int().positive(),
  }),
  z.object({ kind: z.literal("static"), value: z.string() }),
  // env-bound generators handled by setup-secrets.ts main loop, not the loader.
  // Catalog entry MUST set name to a value the main loop special-cases
  // (today: SSH_DEPLOY_KEY). Anyone copying as a template gets a clear
  // error when their non-special-cased name reaches the throw stub below.
  z.object({
    kind: z.literal("special-cased-by-main"),
    specialName: z.string(),
  }),
  z.object({
    kind: z.literal("derived"),
    source: z.enum(["node-dbs", "node-endpoints"]),
  }),
  // Derived at call-time from a process.env interpolation template — e.g.,
  // `https://${DOMAIN}` resolves to `https://test.opencompany.cc` once the
  // operator's DOMAIN reaches the provision shell. Used for values that are
  // a pure function of another (already-set) env var; not for secrets that
  // need randomness. Phase 5c's seed loop reads the generator at the same
  // shell scope that just sourced `.env.${DEPLOY_ENV}`, so DOMAIN is set.
  z.object({
    kind: z.literal("derive-env"),
    template: z.string().min(1),
  }),
]);

const TransformSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("append-path"), path: z.string() }),
]);

const CatalogEntrySchema = z
  .object({
    name: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
    tier: TierSchema,
    service: z.string().optional(),
    coConsumed: z.boolean().optional(),
    required: z.boolean(),
    category: z.string(),
    source: z.enum(["agent", "human"]),
    description: z.string(),
    steps: z.array(z.string()),
    url: z.string().url().optional(),
    perEnv: z.boolean().optional(),
    repoLevel: z.boolean().optional(),
    generate: GenerateSchema.optional(),
    transform: TransformSchema.optional(),
  })
  .refine((e) => e.source !== "agent" || e.generate !== undefined, {
    message: "source: agent requires generate field",
  });

type CatalogEntry = z.infer<typeof CatalogEntrySchema>;

const CatalogFileSchema = z.object({
  // Optional file-level default; loader auto-fills per-node files from parent dir.
  service: z.string().optional(),
  secrets: z.array(CatalogEntrySchema),
});

// ── Public types (mirror setup-secrets.ts shapes) ──────────────────────────

export interface Secret {
  name: string;
  required: boolean;
  category: string;
  description: string;
  source: "agent" | "human";
  url?: string;
  steps: string[];
  generate?: () => string;
  perEnv?: boolean;
  repoLevel?: boolean;
  transform?: (value: string) => string;
}

export type Tier = z.infer<typeof TierSchema>;
export interface SecretRouting {
  tier: Tier;
  service?: string;
  coConsumed?: boolean;
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
  // node domains from node-ci-cd-contract.md (poly, resy). The future-domain
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
  const operatorServiceAllowlist = new Set<string>([
    "_shared",
    "_system",
    ...knownNodes,
    ...CANONICAL_FUTURE_DOMAINS,
  ]);

  const operatorAbs = join(opts.repoRoot, operatorCatalogPath);
  if (existsSync(operatorAbs)) {
    const parsed = parseFile(operatorAbs);
    for (const entry of parsed.secrets) {
      if (
        entry.service !== undefined &&
        !operatorServiceAllowlist.has(entry.service)
      ) {
        throw new Error(
          `${operatorAbs}: entry ${entry.name} declares service: "${entry.service}" which is not one of [${[...operatorServiceAllowlist].sort().join(", ")}]. Add a nodes/<name>/ directory or use _shared/_system; for future-node placeholders, the name must match a canonical domain in node-ci-cd-contract.md.`
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
    if (entry.coConsumed !== undefined) r.coConsumed = entry.coConsumed;
    routing[entry.name] = r;
  }

  return { secrets, routing };
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

function generatorFor(g: z.infer<typeof GenerateSchema>): () => string {
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

function transformerFor(
  t: z.infer<typeof TransformSchema>
): (value: string) => string {
  switch (t.kind) {
    case "append-path":
      return (v: string) => {
        const base = v.replace(/\/+$/, "");
        return base.includes(t.path) ? base : `${base}${t.path}`;
      };
  }
}
