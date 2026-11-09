// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/repo-spec/secrets-catalog`
 * Purpose: The ONE schema for secrets catalogs (`infra/secrets-catalog.yaml` and a node's
 *   `.cogni/secrets-catalog.yaml`), plus the sovereign-node check the node-deploy verb runs on a node's
 *   catalog read at a source sha (bug.5254).
 * Scope: Pure Zod schemas and checks. Does not read files, generate values or call the network. Value
 *   generators stay in `scripts/lib/secrets-catalog-loader.ts`, which imports these schemas.
 * Invariants:
 *   - CATALOG_IS_THE_ONE_READER: the operator loader and the node-deploy verb parse with the same entry
 *     schema; neither keeps a copy.
 *   - TWO_PASSES: pass 1 is the shared entry schema. Pass 2 (`parseNodeSecretsCatalog`) is the
 *     sovereign-node policy: a node may declare only node-owned values it or the operator can supply
 *     safely. Every refusal names a stable `code` and a path.
 *   - WORKLOADS_ARE_OPT_IN (CD1): an entry reaches a workload only when its `workloads` names that
 *     repo-spec service. An entry with no `workloads` projects nothing.
 *   - NO_SOURCE_ECHO: refusals name keys and fields, never YAML text or values.
 *   - BOUNDED_INPUT: a catalog over 64 KiB is refused before YAML parsing.
 * Side-effects: none
 * Links: scripts/lib/secrets-catalog-loader.ts, nodes/operator/app/src/features/node-deploy/declarations.ts,
 *   https://cognidao.org/knowledge/secrets-catalog-is-ssot, bug.5254
 * @public
 */

import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const SecretTierSchema = z.enum(["A1", "A2", "B", "D", "E", "F", "G"]);
export const SecretEnvironmentSchema = z.enum([
  "candidate-a",
  "preview",
  "production",
]);
export const InheritEnvironmentByLaneSchema = z
  .object({
    "candidate-a": z.enum(["lane", "control"]).optional(),
    preview: z.enum(["lane", "control"]).optional(),
    production: z.enum(["lane", "control"]).optional(),
  })
  .strict();

// Capability classes a secret can be gated to (design.secrets-catalog-per-node
// §Amendment v2). An operator-domain entry uses `appliesTo:` instead of a
// single `service:` — the loader fans it to every type:node whose node-spec
// declares that capability. `all-nodes` = the genuine boot-floor.
export const SecretCapabilitySchema = z.enum([
  "all-nodes",
  "web",
  "database",
  "llm",
  "payments",
]);

export const SecretGenerateSchema = z.discriminatedUnion("kind", [
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
  // error when their non-special-cased name reaches the throw stub.
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
  // need randomness.
  z.object({
    kind: z.literal("derive-env"),
    template: z.string().min(1),
  }),
]);

export const SecretTransformSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("append-path"), path: z.string() }),
]);

export const SecretSyncTargetSchema = z.enum([
  "github-app-webhook",
  "litellm-virtual-key",
]);

/** A repo-spec service name, the same shape as a workload `metadata.name`. */
const WorkloadNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);

export const SecretsCatalogEntrySchema = z
  .object({
    name: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
    tier: SecretTierSchema,
    service: z.string().optional(),
    // Capability-gated fan-out (operator-domain, v2). Mutually exclusive with
    // `service:` — `appliesTo` declares the secret ONCE and the write side fans
    // it to every in-scope type:node. `shared: true` → one value at the
    // `_shared` path; default (false) → distinct value per node at the node path.
    appliesTo: SecretCapabilitySchema.optional(),
    shared: z.boolean().optional(),
    // Canonical-custody lane: per-node materialization inherits this key's value
    // verbatim from `cogni/<env>/<inheritFrom>/<KEY>` instead of the blind
    // node-template→operator→_shared ancestor scan. Use when the value MUST
    // byte-match one owner (SCHEDULER_API_TOKEN ← scheduler-worker). See
    // scripts/ci/secret-materialize.sh inherit_shared_value + bug.5021.
    inheritFrom: z.string().optional(),
    // Staged producer binding: omitted lanes retain their current control owner.
    inheritEnvironmentByLane: InheritEnvironmentByLaneSchema.optional(),
    // Explicit fan-out destinations (supersedes the old `coConsumed` boolean).
    // The pod emitter (print-pod-keys.ts) includes a key iff `pod` ∈ consumedBy.
    // `tier` stays the source/authority; `consumedBy` is where it's consumed.
    // Set it on B-tier keys the pod also reads (OPENROUTER_API_KEY) and on
    // compose+pod duals (DB creds, LiteLLM). Absent → defaults from tier+path.
    consumedBy: z.array(z.enum(["pod", "compose", "worker"])).optional(),
    // Node-deploy consumers (bug.5254): the node's repo-spec services whose
    // workloads receive this key. Opt-in: absent → no workload receives it.
    workloads: z.array(WorkloadNameSchema).min(1).max(16).optional(),
    required: z.boolean(),
    category: z.string(),
    // ORIGIN of the value: agent = we generate it (`generate:` required);
    // human = vendor-minted; derived = canonical materializer composes owned inputs.
    // Derived structured custody is never a random credential or human prompt.
    source: z.enum(["agent", "human", "derived"]),
    // Orthogonal axis — does the value ALSO live in an external system that we
    // must keep in lockstep? A generated value can still need mirroring outward
    // (e.g. the GitHub App webhook secret: source: agent + syncTo: the App).
    // deploy-infra runs the matching push (scripts/secrets/sync-app-webhook-secret.sh).
    syncTo: SecretSyncTargetSchema.optional(),
    description: z.string(),
    steps: z.array(z.string()),
    url: z.string().url().optional(),
    perEnv: z.boolean().optional(),
    repoLevel: z.boolean().optional(),
    generate: SecretGenerateSchema.optional(),
    transform: SecretTransformSchema.optional(),
  })
  .refine((e) => e.source === "human" || e.generate !== undefined, {
    message: "source: agent or derived requires generate field",
  })
  .refine((e) => !(e.service !== undefined && e.appliesTo !== undefined), {
    message:
      "entry declares both service: and appliesTo: — they are mutually exclusive (service = one node; appliesTo = capability fan-out)",
  })
  .refine(
    (e) => e.inheritEnvironmentByLane === undefined || Boolean(e.inheritFrom),
    {
      message: "inheritEnvironmentByLane requires inheritFrom",
    }
  );

export type SecretsCatalogEntry = z.infer<typeof SecretsCatalogEntrySchema>;
export type SecretTier = z.infer<typeof SecretTierSchema>;
export type SecretCapability = z.infer<typeof SecretCapabilitySchema>;
export type SecretGenerate = z.infer<typeof SecretGenerateSchema>;
export type SecretTransform = z.infer<typeof SecretTransformSchema>;
export type SecretSyncTarget = z.infer<typeof SecretSyncTargetSchema>;

export const SecretsCatalogFileSchema = z.object({
  // Optional file-level default; loader auto-fills per-node files from parent dir.
  service: z.string().optional(),
  secrets: z.array(SecretsCatalogEntrySchema),
});

// ---------------------------------------------------------------------------
// Sovereign-node catalog (pass 2), read by the node-deploy verb at a source sha
// ---------------------------------------------------------------------------

export const NODE_SECRETS_CATALOG_PATH = ".cogni/secrets-catalog.yaml";
const MAX_CATALOG_BYTES = 64 * 1024;

export type SecretsCatalogIssueCode =
  | "too_large"
  | "yaml_invalid"
  | "schema_invalid"
  | "duplicate_name"
  | "operator_only_field"
  | "unsupported_source"
  | "unsupported_generator"
  | "foreign_service"
  | "unknown_workload";

export interface SecretsCatalogIssue {
  readonly code: SecretsCatalogIssueCode;
  /** Dotted path inside the catalog, e.g. `secrets[0].generate`. */
  readonly path: string;
  readonly message: string;
}

/** Thrown when a node's catalog is refused. Carries every issue found, not only the first. */
export class SecretsCatalogError extends Error {
  constructor(readonly issues: readonly SecretsCatalogIssue[]) {
    super(
      issues
        .slice(0, 5)
        .map((i) => `${i.path}: ${i.message}`)
        .join("; ")
        .slice(0, 1000) || "secrets catalog refused"
    );
    this.name = "SecretsCatalogError";
  }
}

/** The part of a node catalog entry the node-deploy verb uses. Value-free. */
export interface NodeSecretsCatalogEntry {
  readonly name: string;
  readonly source: "agent" | "human";
  readonly workloads: readonly string[];
  readonly generate?: {
    readonly kind: "hex" | "base64";
    readonly bytes: number;
  };
}

/** Fields only the operator domain may set: each one reaches another owner's value or system. */
const OPERATOR_ONLY_FIELDS = [
  "inheritFrom",
  "inheritEnvironmentByLane",
  "syncTo",
  "transform",
  "repoLevel",
] as const;

/**
 * Check a sovereign node's `.cogni/secrets-catalog.yaml` (pass 1 + pass 2). `null` text (no file)
 * is an empty catalog. Throws `SecretsCatalogError` listing every issue.
 */
export function parseNodeSecretsCatalog(
  text: string | null,
  ctx: { readonly nodeSlug: string; readonly serviceNames: readonly string[] }
): readonly NodeSecretsCatalogEntry[] {
  if (text === null) return [];
  if (new TextEncoder().encode(text).length > MAX_CATALOG_BYTES)
    throw new SecretsCatalogError([
      { code: "too_large", path: "", message: "catalog is over 64 KiB" },
    ]);
  let raw: unknown;
  try {
    raw = parseYaml(text, { prettyErrors: false, logLevel: "error" });
  } catch {
    throw new SecretsCatalogError([
      { code: "yaml_invalid", path: "", message: "catalog is not valid YAML" },
    ]);
  }
  const parsed = SecretsCatalogFileSchema.safeParse(raw ?? { secrets: [] });
  if (!parsed.success)
    throw new SecretsCatalogError(
      parsed.error.issues.slice(0, 20).map((i) => ({
        code: "schema_invalid" as const,
        path: i.path
          .map((p) => (typeof p === "number" ? `[${p}]` : `.${p}`))
          .join("")
          .replace(/^\./, ""),
        // A Zod message names the rule, never the input value.
        message: i.message,
      }))
    );

  const issues: SecretsCatalogIssue[] = [];
  const services = new Set(ctx.serviceNames);
  const seen = new Set<string>();
  const out: NodeSecretsCatalogEntry[] = [];
  parsed.data.secrets.forEach((e, i) => {
    const at = `secrets[${i}]`;
    if (seen.has(e.name))
      issues.push({
        code: "duplicate_name",
        path: at,
        message: `${e.name} is declared twice`,
      });
    seen.add(e.name);
    for (const field of OPERATOR_ONLY_FIELDS)
      if (e[field] !== undefined)
        issues.push({
          code: "operator_only_field",
          path: `${at}.${field}`,
          message: `${e.name}: ${field} is operator-only`,
        });
    if (e.shared === true)
      issues.push({
        code: "operator_only_field",
        path: `${at}.shared`,
        message: `${e.name}: shared values are operator-only`,
      });
    if (e.service !== undefined && e.service !== ctx.nodeSlug)
      issues.push({
        code: "foreign_service",
        path: `${at}.service`,
        message: `${e.name}: service must be this node (${ctx.nodeSlug})`,
      });
    if (e.source === "derived")
      issues.push({
        code: "unsupported_source",
        path: `${at}.source`,
        message: `${e.name}: derived values are operator-only`,
      });
    if (
      e.generate !== undefined &&
      e.generate.kind !== "hex" &&
      e.generate.kind !== "base64"
    )
      issues.push({
        code: "unsupported_generator",
        path: `${at}.generate.kind`,
        message: `${e.name}: a node may generate only hex or base64 random values`,
      });
    for (const w of e.workloads ?? [])
      if (!services.has(w))
        issues.push({
          code: "unknown_workload",
          path: `${at}.workloads`,
          message: `${e.name}: ${w} is not a repo-spec service`,
        });
    if (e.source === "derived") return;
    out.push({
      name: e.name,
      source: e.source,
      workloads: e.workloads ?? [],
      ...(e.generate?.kind === "hex" || e.generate?.kind === "base64"
        ? { generate: { kind: e.generate.kind, bytes: e.generate.bytes } }
        : {}),
    });
  });
  if (issues.length > 0) throw new SecretsCatalogError(issues.slice(0, 20));
  return out;
}

/** The catalog keys a repo-spec service's workload receives, in catalog order. */
export function catalogSecretKeysFor(
  entries: readonly NodeSecretsCatalogEntry[],
  serviceName: string
): string[] {
  return entries
    .filter((e) => e.workloads.includes(serviceName))
    .map((e) => e.name);
}
