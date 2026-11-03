// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Score `${resources...}` placeholders are literal manifest text

/**
 * Module: `@cogni/repo-spec/workload-manifest`
 * Purpose: Check a node's workload manifests (`.cogni/workloads/<name>.yaml`, Score v1b1 format) in two
 *   passes and lower them to the existing `NodeWorkloadSpec`, so the payer, the actuator and the
 *   node-deploy sequencer stay unchanged (story.5137, hub `workload-manifest`).
 * Scope: Pure check and lowering. Does not read files or call the network: callers read the files at a
 *   source sha and pass their text.
 * Invariants:
 *   - TWO_PASSES: pass 1 is the vendored, commit-pinned Score v1b1 JSON schema. Pass 2 is Cogni policy.
 *     Pass 2 runs only on a manifest that passed pass 1. Every refusal names a stable `code` and a path.
 *   - NOTHING_SILENTLY_DROPPED: a field with no row in the mapping table is refused (`unmapped_field`),
 *     and so is any entry in `.cogni/workloads/` that is not a `*.yaml` file.
 *   - BOUNDED_INPUT: a manifest over 64 KiB is refused before YAML parsing or any regex runs on it.
 *   - DIGEST_OR_BUILT: an image is pinned by `@sha256:`, or is `.` (the image node CI built at the
 *     source sha, which the caller passes as `builtImage` (a digest) or as `pendingImage`
 *     (`<repo>:sha-<sha>`, the app is then `imagePending` and the sequencer pins the digest, story.5137).
 *   - EXCLUSIVE_REQUIRED: `cogni.dev/exclusive` must be present and `"false"`; `"true"` is refused
 *     until the single-leader fence ships (CD6). Only `exclusive`, `version-path` and
 *     `ephemeral-storage` exist under `cogni.dev/`.
 *   - NO_LITERAL_SECRETS: one scanner covers variables, command and args; it never echoes the value.
 *   - OPERATOR_OWNS_URLS: a dependency output is used only as a whole `variables` value,
 *     `${resources.<key>.url}`; a manifest never builds a URL from parts.
 *   - DATA_HAS_AN_ID: a data-bearing dependency (`postgres`, `knowledge`, `volume`) names an explicit
 *     `id`. Ids are unique across the node's manifests and differ from every workload name.
 *   - SIZE_PER_FIELD: cpu = `limits.cpu ?? requests.cpu`, memory = `limits.memory ?? requests.memory`,
 *     each field on its own (Akash rents one size); storage = `cogni.dev/ephemeral-storage` or 256Mi.
 *   - SUPPORTED_IN_THIS_VERSION: dependencies `postgres` (class `dedicated`, lowered to a `state`
 *     workload named by its id, from the operator-owned profile below) and `route`. Anything else is
 *     `unsupported_dependency_type` / `unsupported_dependency_class`.
 * Side-effects: none
 * Links: packages/repo-spec/src/vendor/score-v1b1.schema.ts, .cogni/workloads/canary.yaml,
 *   hub `workload-manifest`, hub `node-service-delivery`
 * @public
 */

import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import { parse as parseYaml, YAMLError } from "yaml";

import { type NodeWorkloadSpec, nodeWorkloadSpecSchema } from "./schema.js";
import { SCORE_V1B1_SCHEMA_TEXT } from "./vendor/score-v1b1.schema.js";

/** Directory (relative to the node repo root) that holds one manifest per workload. */
export const WORKLOAD_MANIFEST_DIR = ".cogni/workloads";
/** A manifest file is `<metadata.name>.yaml`. */
export const WORKLOAD_MANIFEST_SUFFIX = ".yaml";
/** Upper bound on manifests per node, so one read cannot fan out without limit. */
export const MAX_WORKLOAD_MANIFESTS = 16;
/** Upper bound on one manifest's UTF-8 size, checked before any parse or regex runs on it. */
export const MAX_WORKLOAD_MANIFEST_BYTES = 64 * 1024;

export type WorkloadManifestIssueCode =
  | "manifest_unparseable"
  | "schema_invalid"
  | "unmapped_field"
  | "invalid_name"
  | "manifest_name_mismatch"
  | "duplicate_workload_name"
  | "too_many_manifests"
  | "manifest_too_large"
  | "unexpected_manifest_entry"
  | "image_not_digest_pinned"
  | "built_image_unresolved"
  | "exclusive_missing"
  | "exclusive_unsupported"
  | "unknown_annotation"
  | "invalid_annotation"
  | "literal_secret"
  | "unsupported_dependency_type"
  | "unsupported_dependency_class"
  | "data_resource_id_required"
  | "duplicate_data_resource_id"
  | "data_resource_id_is_workload_name"
  | "placeholder_not_whole_value"
  | "unsupported_placeholder"
  | "probe_port_mismatch"
  | "readiness_probe_required"
  | "route_invalid"
  | "invalid_quantity"
  | "sidecars_unsupported"
  | "lowered_spec_invalid";

export interface WorkloadManifestIssue {
  readonly code: WorkloadManifestIssueCode;
  /** Dotted path inside the manifest, e.g. `containers.app.variables.DATABASE_URL`. */
  readonly path: string;
  readonly message: string;
  /** The manifest file path, when the caller supplied one. */
  readonly file?: string;
}

/** Thrown when any manifest is refused. Carries every issue found, not only the first. */
export class WorkloadManifestError extends Error {
  readonly code: WorkloadManifestIssueCode;
  constructor(readonly issues: readonly WorkloadManifestIssue[]) {
    const first = issues[0];
    super(
      issues
        .slice(0, 5)
        .map((i) => `${i.file ? `${i.file}: ` : ""}${i.path}: ${i.message}`)
        .join("; ")
        .slice(0, 1000) || "workload manifest refused"
    );
    this.name = "WorkloadManifestError";
    this.code = first?.code ?? "schema_invalid";
  }
}

// ---------------------------------------------------------------------------
// The Score shape after pass 1 (only the parts pass 2 and the lowering read)
// ---------------------------------------------------------------------------

interface ScoreQuantities {
  readonly cpu?: string;
  readonly memory?: string;
}

interface ScoreContainer {
  readonly image: string;
  readonly command?: readonly string[];
  readonly args?: readonly string[];
  readonly variables?: Readonly<Record<string, string>>;
  readonly resources?: {
    readonly limits?: ScoreQuantities;
    readonly requests?: ScoreQuantities;
  };
  readonly readinessProbe?: Readonly<Record<string, unknown>> & {
    readonly httpGet?: Readonly<Record<string, unknown>> & {
      readonly path: string;
      readonly port: number;
    };
  };
  readonly [field: string]: unknown;
}

interface ScoreResource {
  readonly type: string;
  readonly class?: string;
  readonly id?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly params?: Readonly<Record<string, unknown>>;
}

interface ScoreServicePort {
  readonly port: number;
  readonly targetPort?: number;
  readonly protocol?: "TCP" | "UDP";
}

/** A manifest that passed pass 1 (the Score v1b1 schema). */
export interface ScoreWorkload {
  readonly apiVersion: "score.dev/v1b1";
  readonly metadata: Readonly<Record<string, unknown>> & {
    readonly name: string;
    readonly annotations?: Readonly<Record<string, string>>;
  };
  readonly service?: {
    readonly ports?: Readonly<Record<string, ScoreServicePort>>;
  };
  readonly containers: Readonly<Record<string, ScoreContainer>>;
  readonly resources?: Readonly<Record<string, ScoreResource>>;
}

// ---------------------------------------------------------------------------
// Policy constants
// ---------------------------------------------------------------------------

const NAME_RE = /^[a-z][a-z0-9-]{0,62}$/;
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const DIGEST_IMAGE_RE =
  /^[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$/;
const HOST_RE =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const HEALTH_PATH_RE = /^\/[A-Za-z0-9._~/-]*$/;
/** `${resources.<key>.<output>}` as a WHOLE value. */
const WHOLE_RESOURCE_PLACEHOLDER_RE = /^\$\{resources\.([^.}]+)\.([^}]+)\}$/;

/** The image node CI built at the source sha. */
export const BUILT_IMAGE_REF = ".";

const ANNOTATION = {
  exclusive: "cogni.dev/exclusive",
  versionPath: "cogni.dev/version-path",
  ephemeralStorage: "cogni.dev/ephemeral-storage",
} as const;
const ALLOWED_COGNI_ANNOTATIONS = new Set<string>(Object.values(ANNOTATION));
const DEFAULT_VERSION_PATH = "/version";
const DEFAULT_STORAGE_MI = 256;
/** The edge serves every route on port 80 (NodeWorkloadSpec has no public-port field). */
const ROUTE_SERVICE_PORT = 80;

/** Dependencies that hold data. Removing or reclassing one must never drop the data. */
export const DATA_BEARING_DEPENDENCY_TYPES: ReadonlySet<string> = new Set([
  "postgres",
  "knowledge",
  "volume",
]);

/**
 * Dependency type -> the classes this version supports (`null` = the type takes no class). A Map, not
 * an object literal, so `constructor`, `toString` and other prototype keys are never "supported".
 */
const SUPPORTED_DEPENDENCIES: ReadonlyMap<string, readonly string[] | null> =
  new Map<string, readonly string[] | null>([
    ["postgres", ["dedicated"]],
    ["route", null],
  ]);

const ALLOWED_CONTAINER_FIELDS = new Set([
  "image",
  "command",
  "args",
  "variables",
  "resources",
  "readinessProbe",
]);

/**
 * The operator-owned provisioner profile for `postgres` class `dedicated`, version 1. The manifest
 * names only the id; the operator chooses the image, the TLS boot script and the size. These values
 * are, byte for byte, the `canary-db` state workload the operator declared before manifests existed,
 * so the live production state lease keeps its identity (it is adopted, never recreated).
 * POSTGRES_PASSWORD is injected by the sequencer; clients use sslmode=require (self-signed cert).
 */
export const POSTGRES_DEDICATED_PROFILE_V1 = {
  image:
    "postgres:16@sha256:5db6dac2ef5dcff512f4f00a009c3c332b9f2f28f24277175bf3e4a3d02ef83a",
  command: [
    "bash",
    "-c",
    "mkdir -p /etc/pgtls && openssl req -new -x509 -days 30 -nodes -subj /CN=state -out /etc/pgtls/server.crt -keyout /etc/pgtls/server.key && chown postgres:postgres /etc/pgtls/server.* && chmod 600 /etc/pgtls/server.key && exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/etc/pgtls/server.crt -c ssl_key_file=/etc/pgtls/server.key",
  ],
  port: 5432,
  cpu: 0.5,
  memoryMi: 512,
  storageMi: 512,
  persistent: { sizeMi: 2048, mountPath: "/var/lib/postgresql/data" },
  env: { PGDATA: "/var/lib/postgresql/data/pgdata" },
} as const;

// ---------------------------------------------------------------------------
// Literal-secret scanner (one scanner for variables, command, args)
// ---------------------------------------------------------------------------

const SECRET_NAME_RE =
  /(PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIAL)/i;

const SECRET_VALUE_PATTERNS: readonly (readonly [string, RegExp])[] = [
  [
    "a URL with an embedded password",
    /[a-z][a-z0-9+.-]{0,31}:\/\/[^\s/:@]+:[^\s/@]+@/i,
  ],
  ["a PEM private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  [
    "a GitHub token",
    /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{20,})/,
  ],
  ["an AWS access key id", /\bAKIA[0-9A-Z]{16}\b/],
  ["an sk- API key", /\bsk-[A-Za-z0-9_-]{20,}/],
  ["a Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  [
    "a password, secret, token or key assignment",
    /\b(password|passwd|secret|token|api[_-]?key)\s*[=:]\s*['"]?[^\s'"$]{8,}/i,
  ],
];

/** Returns a description of the secret shape found, or undefined. Never returns the value. */
export function findLiteralSecret(value: string): string | undefined {
  for (const [what, re] of SECRET_VALUE_PATTERNS)
    if (re.test(value)) return what;
  if (containsJwt(value)) return "a JWT";
  return undefined;
}

const B64URL_RUN = /^[A-Za-z0-9_-]*$/;
const JWT_SEGMENT = { min: 10, max: 1024 } as const;

/**
 * Linear-time match of `\beyJ[A-Za-z0-9_-]{10,1024}\.[A-Za-z0-9_-]{10,1024}\.[A-Za-z0-9_-]{10}`. A regex
 * scan is quadratic on hostile input (every `eyJ` start re-reads up to 1024 chars), so split on dots
 * once and look only at each part's bounded tail. Each character is visited a constant number of times.
 */
function containsJwt(value: string): boolean {
  const parts = value.split(".");
  for (let i = 0; i + 2 < parts.length; i++) {
    const [head, mid, tail] = [
      parts[i] ?? "",
      parts[i + 1] ?? "",
      parts[i + 2] ?? "",
    ];
    if (mid.length < JWT_SEGMENT.min || mid.length > JWT_SEGMENT.max) continue;
    if (!B64URL_RUN.test(mid)) continue;
    if (!/^[A-Za-z0-9_-]{10}/.test(tail)) continue;
    // head must END with `eyJ` + 10..1024 base64url chars, preceded by a non-word char or the start.
    let runStart = head.length;
    while (runStart > 0 && /[A-Za-z0-9_-]/.test(head[runStart - 1] ?? ""))
      runStart--;
    const lowest = Math.max(runStart, head.length - (3 + JWT_SEGMENT.max));
    const highest = head.length - (3 + JWT_SEGMENT.min);
    for (
      let at = head.indexOf("eyJ", lowest);
      at !== -1 && at <= highest;
      at = head.indexOf("eyJ", at + 1)
    ) {
      const before = at === 0 ? "" : (head[at - 1] ?? "");
      if (!/[A-Za-z0-9_]/.test(before)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Pass 1: the vendored Score schema
// ---------------------------------------------------------------------------

let scoreValidator: ValidateFunction | undefined;

function validateScoreSchema(doc: unknown): WorkloadManifestIssue[] {
  scoreValidator ??= new Ajv2020({
    allErrors: true,
    strict: true,
    strictRequired: false,
  }).compile(JSON.parse(SCORE_V1B1_SCHEMA_TEXT) as object);
  if (scoreValidator(doc)) return [];
  return (scoreValidator.errors ?? []).slice(0, 20).map((e) => ({
    code: "schema_invalid" as const,
    path: e.instancePath.replace(/^\//, "").replace(/\//g, ".") || "(root)",
    message: `${e.message ?? "invalid"}${
      e.keyword === "additionalProperties"
        ? ` (${String((e.params as { additionalProperty?: string }).additionalProperty)})`
        : ""
    }`,
  }));
}

// ---------------------------------------------------------------------------
// Quantities
// ---------------------------------------------------------------------------

const MEMORY_UNITS: Readonly<Record<string, number>> = {
  "": 1,
  K: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18,
  Ki: 2 ** 10,
  Mi: 2 ** 20,
  Gi: 2 ** 30,
  Ti: 2 ** 40,
  Pi: 2 ** 50,
  Ei: 2 ** 60,
};

/** A Kubernetes memory quantity as whole mebibytes, or undefined when it is not a whole number. */
export function quantityToMi(q: string): number | undefined {
  const m =
    /^(0\.\d+|[1-9]\d*(?:\.\d+)?)(K|M|G|T|P|E|Ki|Mi|Gi|Ti|Pi|Ei)?$/.exec(q);
  if (!m) return undefined;
  const bytes = Number(m[1]) * (MEMORY_UNITS[m[2] ?? ""] ?? Number.NaN);
  const mi = bytes / 2 ** 20;
  return Number.isInteger(mi) && mi > 0 ? mi : undefined;
}

/** A Kubernetes CPU quantity (`250m`, `1`, `0.5`) as cores. */
export function quantityToCpu(q: string): number | undefined {
  const milli = /^(\d+)m$/.exec(q);
  if (milli) return Number(milli[1]) / 1000;
  if (/^\d+(?:\.\d+)?$/.test(q)) return Number(q);
  return undefined;
}

// ---------------------------------------------------------------------------
// Pass 2: Cogni policy (one manifest)
// ---------------------------------------------------------------------------

function unmapped(path: string, what?: string): WorkloadManifestIssue {
  return {
    code: "unmapped_field",
    path,
    message: `${what ?? "this field"} has no row in the workload-manifest mapping table; it is refused, not dropped`,
  };
}

function placeholderIssue(
  path: string,
  value: string
): WorkloadManifestIssue | undefined {
  if (!value.includes("${")) return undefined;
  if (value.includes("${resources"))
    return {
      code: "placeholder_not_whole_value",
      path,
      message:
        "a ${resources...} placeholder is allowed only as a whole variables value",
    };
  return {
    code: "unsupported_placeholder",
    path,
    message:
      "only ${resources.<key>.url} placeholders are supported; write $VAR instead of ${VAR} in shell text",
  };
}

function checkPolicy(m: ScoreWorkload): WorkloadManifestIssue[] {
  const issues: WorkloadManifestIssue[] = [];
  const add = (i: WorkloadManifestIssue) => issues.push(i);
  const resources = m.resources ?? {};

  // -- metadata --------------------------------------------------------------
  if (!NAME_RE.test(m.metadata.name))
    add({
      code: "invalid_name",
      path: "metadata.name",
      message: "metadata.name must match ^[a-z][a-z0-9-]{0,62}$",
    });
  for (const key of Object.keys(m.metadata))
    if (key !== "name" && key !== "annotations")
      add(unmapped(`metadata.${key}`));

  const annotations = m.metadata.annotations ?? {};
  for (const key of Object.keys(annotations)) {
    if (key.startsWith("cogni.dev/")) {
      if (!ALLOWED_COGNI_ANNOTATIONS.has(key))
        add({
          code: "unknown_annotation",
          path: `metadata.annotations.${key}`,
          message: `unknown cogni.dev key; allowed: ${[...ALLOWED_COGNI_ANNOTATIONS].join(", ")}`,
        });
    } else
      add(
        unmapped(`metadata.annotations.${key}`, "a non-cogni.dev annotation")
      );
  }
  const exclusive = annotations[ANNOTATION.exclusive];
  if (exclusive === undefined)
    add({
      code: "exclusive_missing",
      path: `metadata.annotations.${ANNOTATION.exclusive}`,
      message: `${ANNOTATION.exclusive} is required: does this workload do work only one live instance may do?`,
    });
  else if (exclusive === "true")
    add({
      code: "exclusive_unsupported",
      path: `metadata.annotations.${ANNOTATION.exclusive}`,
      message: `${ANNOTATION.exclusive}: "true" is refused until the single-leader fence ships (CD6)`,
    });
  else if (exclusive !== "false")
    add({
      code: "invalid_annotation",
      path: `metadata.annotations.${ANNOTATION.exclusive}`,
      message: `${ANNOTATION.exclusive} must be "false" (or "true", which is refused today)`,
    });
  const versionPath = annotations[ANNOTATION.versionPath];
  if (versionPath !== undefined && !HEALTH_PATH_RE.test(versionPath))
    add({
      code: "invalid_annotation",
      path: `metadata.annotations.${ANNOTATION.versionPath}`,
      message: `${ANNOTATION.versionPath} must be an absolute URL path`,
    });
  const storage = annotations[ANNOTATION.ephemeralStorage];
  if (storage !== undefined && quantityToMi(storage) === undefined)
    add({
      code: "invalid_annotation",
      path: `metadata.annotations.${ANNOTATION.ephemeralStorage}`,
      message: `${ANNOTATION.ephemeralStorage} must be a memory quantity of whole MiB, e.g. 256Mi`,
    });

  // -- resources (dependencies) ---------------------------------------------
  const routes: [string, ScoreResource][] = [];
  for (const [key, r] of Object.entries(resources)) {
    const path = `resources.${key}`;
    if (DATA_BEARING_DEPENDENCY_TYPES.has(r.type) && r.id === undefined)
      add({
        code: "data_resource_id_required",
        path: `${path}.id`,
        message: `a data-bearing dependency (${r.type}) must name an explicit id`,
      });
    if (!SUPPORTED_DEPENDENCIES.has(r.type)) {
      add({
        code: "unsupported_dependency_type",
        path: `${path}.type`,
        message: `dependency type ${r.type} is not supported yet; supported: ${[...SUPPORTED_DEPENDENCIES.keys()].join(", ")}`,
      });
      continue;
    }
    if (r.metadata !== undefined) add(unmapped(`${path}.metadata`));
    const classes = SUPPORTED_DEPENDENCIES.get(r.type) ?? null;
    if (r.type === "postgres") {
      if (r.class === undefined || !classes?.includes(r.class))
        add({
          code: "unsupported_dependency_class",
          path: `${path}.class`,
          message: `postgres class must be one of: ${classes?.join(", ")} (shared ships later)`,
        });
      if (r.id !== undefined && !NAME_RE.test(r.id))
        add({
          code: "invalid_name",
          path: `${path}.id`,
          message: "a dependency id must match ^[a-z][a-z0-9-]{0,62}$",
        });
      if (r.id !== undefined && r.id === m.metadata.name)
        add({
          code: "data_resource_id_is_workload_name",
          path: `${path}.id`,
          message:
            "a data-bearing dependency id must differ from every workload name",
        });
      if (r.params !== undefined) add(unmapped(`${path}.params`));
    }
    if (r.type === "route") {
      routes.push([key, r]);
      if (r.class !== undefined)
        add({
          code: "unsupported_dependency_class",
          path: `${path}.class`,
          message: "a route takes no class",
        });
      if (r.id !== undefined) add(unmapped(`${path}.id`, "a route id"));
      for (const p of Object.keys(r.params ?? {}))
        if (p !== "host" && p !== "path" && p !== "port")
          add(unmapped(`${path}.params.${p}`));
    }
  }

  // -- containers ------------------------------------------------------------
  const containers = Object.entries(m.containers);
  if (containers.length !== 1)
    add({
      code: "sidecars_unsupported",
      path: "containers",
      message:
        "exactly one container is supported in this version; sidecars have no mapping yet",
    });
  for (const [name, c] of containers) {
    const base = `containers.${name}`;
    for (const key of Object.keys(c))
      if (!ALLOWED_CONTAINER_FIELDS.has(key)) add(unmapped(`${base}.${key}`));

    if (c.image !== BUILT_IMAGE_REF && !DIGEST_IMAGE_RE.test(c.image))
      add({
        code: "image_not_digest_pinned",
        path: `${base}.image`,
        message: `image must be pinned by digest (repo[:tag]@sha256:<64 hex>) or be "${BUILT_IMAGE_REF}" (the image node CI built at the source sha)`,
      });

    if (c.args !== undefined && c.command === undefined)
      add(
        unmapped(
          `${base}.args`,
          "args without command (NodeWorkloadSpec carries the full argv)"
        )
      );
    [
      ...(c.command ?? []).map((v, i) => [`${base}.command.${i}`, v] as const),
      ...(c.args ?? []).map((v, i) => [`${base}.args.${i}`, v] as const),
    ].forEach(([path, v]) => {
      const p = placeholderIssue(path, v);
      if (p) add(p);
      const secret = findLiteralSecret(v);
      if (secret)
        add({
          code: "literal_secret",
          path,
          message: `looks like ${secret}; secrets arrive through declared dependencies, never in the manifest`,
        });
    });

    for (const [key, value] of Object.entries(c.variables ?? {})) {
      const path = `${base}.variables.${key}`;
      if (!ENV_KEY_RE.test(key))
        add({
          code: "invalid_name",
          path,
          message: "a variable name must match ^[A-Z][A-Z0-9_]{0,63}$",
        });
      const whole = WHOLE_RESOURCE_PLACEHOLDER_RE.exec(value);
      if (whole) {
        const target = resources[whole[1] ?? ""];
        if (!target || target.type !== "postgres" || whole[2] !== "url")
          add({
            code: "unsupported_placeholder",
            path,
            message:
              "only ${resources.<key>.url} of a declared postgres dependency is supported",
          });
        continue;
      }
      const p = placeholderIssue(path, value);
      if (p) {
        add(p);
        continue;
      }
      const secret = findLiteralSecret(value);
      if (secret || (SECRET_NAME_RE.test(key) && value.length > 0))
        add({
          code: "literal_secret",
          path,
          message: `looks like ${secret ?? "a literal secret (secret-like name)"}; secrets arrive through declared dependencies, never in the manifest`,
        });
    }

    const limits = c.resources?.limits ?? {};
    const requests = c.resources?.requests ?? {};
    const cpu = limits.cpu ?? requests.cpu;
    const memory = limits.memory ?? requests.memory;
    if (cpu === undefined || quantityToCpu(cpu) === undefined)
      add({
        code: "invalid_quantity",
        path: `${base}.resources`,
        message: "cpu is required in limits or requests (e.g. 250m)",
      });
    if (memory === undefined || quantityToMi(memory) === undefined)
      add({
        code: "invalid_quantity",
        path: `${base}.resources`,
        message:
          "memory is required in limits or requests, in whole MiB (e.g. 256Mi)",
      });

    const probe = c.readinessProbe;
    if (!probe?.httpGet)
      add({
        code: "readiness_probe_required",
        path: `${base}.readinessProbe`,
        message:
          "readinessProbe.httpGet {path, port} is required (it becomes health.ready)",
      });
    for (const key of Object.keys(probe ?? {}))
      if (key !== "httpGet") add(unmapped(`${base}.readinessProbe.${key}`));
    for (const key of Object.keys(probe?.httpGet ?? {}))
      if (key !== "path" && key !== "port")
        add(unmapped(`${base}.readinessProbe.httpGet.${key}`));
    if (probe?.httpGet && !HEALTH_PATH_RE.test(probe.httpGet.path))
      add({
        code: "readiness_probe_required",
        path: `${base}.readinessProbe.httpGet.path`,
        message: "the readiness path must be an absolute URL path",
      });
  }

  // -- service + route -------------------------------------------------------
  const ports = Object.entries(m.service?.ports ?? {});
  for (const [key, p] of ports)
    if (p.protocol !== undefined && p.protocol !== "TCP")
      add(unmapped(`service.ports.${key}.protocol`, `protocol ${p.protocol}`));
  if (routes.length !== 1)
    add({
      code: "route_invalid",
      path: "resources",
      message: "a workload needs exactly one route dependency in this version",
    });
  if (ports.length !== 1)
    add({
      code: "route_invalid",
      path: "service.ports",
      message: "exactly one service port is supported; the route targets it",
    });
  const [routeKey, route] = routes[0] ?? [];
  const [portKey, servicePort] = ports[0] ?? [];
  if (route && servicePort) {
    const params = route.params ?? {};
    const rpath = `resources.${routeKey}.params`;
    if (typeof params.host !== "string" || !HOST_RE.test(params.host))
      add({
        code: "route_invalid",
        path: `${rpath}.host`,
        message:
          "route params.host must be a lowercase DNS name (the production host)",
      });
    if (params.path !== "/")
      add({
        code: "route_invalid",
        path: `${rpath}.path`,
        message: 'route params.path must be "/"',
      });
    if (params.port !== servicePort.port)
      add({
        code: "route_invalid",
        path: `${rpath}.port`,
        message: `route params.port must name the service port (${servicePort.port})`,
      });
    if (servicePort.port !== ROUTE_SERVICE_PORT)
      add({
        code: "route_invalid",
        path: `service.ports.${portKey}.port`,
        message: `the edge serves a route on port ${ROUTE_SERVICE_PORT}`,
      });
    const target = servicePort.targetPort ?? servicePort.port;
    for (const [name, c] of containers) {
      const probePort = c.readinessProbe?.httpGet?.port;
      if (probePort !== undefined && probePort !== target)
        add({
          code: "probe_port_mismatch",
          path: `containers.${name}.readinessProbe.httpGet.port`,
          message: `the readiness probe port (${probePort}) must equal the route's targetPort (${target})`,
        });
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function withFile(
  issues: readonly WorkloadManifestIssue[],
  file: string | undefined
): WorkloadManifestIssue[] {
  return file ? issues.map((i) => ({ ...i, file })) : [...issues];
}

/**
 * Parse one manifest's YAML text and run both passes. Returns the checked manifest, or throws a
 * `WorkloadManifestError` with every issue found.
 */
export function parseWorkloadManifest(
  text: string,
  file?: string
): ScoreWorkload {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > MAX_WORKLOAD_MANIFEST_BYTES)
    throw new WorkloadManifestError(
      withFile(
        [
          {
            code: "manifest_too_large",
            path: "(root)",
            message: `a manifest is at most ${MAX_WORKLOAD_MANIFEST_BYTES} bytes; this one is ${bytes}`,
          },
        ],
        file
      )
    );
  let doc: unknown;
  try {
    // NO_SOURCE_ECHO: never put the YAML library's message in a refusal. It can quote source text
    // (alias names, %YAML directives, block headers) that may hold a secret. Only code + line.
    doc = parseYaml(text, { prettyErrors: false, logLevel: "error" });
  } catch (error) {
    throw new WorkloadManifestError(
      withFile(
        [
          {
            code: "manifest_unparseable",
            path: "(root)",
            message: yamlErrorSummary(error, text),
          },
        ],
        file
      )
    );
  }
  const pass1 = validateScoreSchema(doc);
  if (pass1.length > 0) throw new WorkloadManifestError(withFile(pass1, file));
  const manifest = doc as ScoreWorkload;
  const pass2 = checkPolicy(manifest);
  if (pass2.length > 0) throw new WorkloadManifestError(withFile(pass2, file));
  return manifest;
}

/** A YAML error as `<code> at line <n>` only; any other error (e.g. an unresolved alias) is generic. */
function yamlErrorSummary(error: unknown, text: string): string {
  if (error instanceof YAMLError) {
    const offset = error.pos?.[0];
    const line =
      offset === undefined
        ? undefined
        : text.slice(0, offset).split("\n").length;
    return `invalid YAML: ${error.code}${line === undefined ? "" : ` at line ${line}`}`;
  }
  return "invalid YAML (for example an unresolved alias)";
}

export interface LowerWorkloadOptions {
  /** The digest-pinned image node CI built at the source sha; resolves an image of `.`. */
  readonly builtImage?: string;
  /**
   * `<image_repository>:sha-<sha>`: resolves an image of `.` to the tag node CI will publish and marks the
   * app `imagePending`, so the caller never waits on CI at record time (story.5137). The sequencer
   * resolves it to a digest before the first paid create. Ignored when `builtImage` is given.
   */
  readonly pendingImage?: string;
}

function lowerValidated(
  m: ScoreWorkload,
  options: LowerWorkloadOptions
): NodeWorkloadSpec[] {
  const resources = Object.entries(m.resources ?? {});
  const [containerEntry] = Object.entries(m.containers);
  if (!containerEntry)
    throw new Error("unreachable: pass 2 requires one container");
  const [containerName, c] = containerEntry;
  const annotations = m.metadata.annotations ?? {};

  const states: NodeWorkloadSpec[] = resources
    .filter(([, r]) => r.type === "postgres")
    .map(([, r]) => ({
      name: r.id as string,
      kind: "state" as const,
      image: POSTGRES_DEDICATED_PROFILE_V1.image,
      command: [...POSTGRES_DEDICATED_PROFILE_V1.command],
      port: POSTGRES_DEDICATED_PROFILE_V1.port,
      expose: { tcp: { global: true as const } },
      cpu: POSTGRES_DEDICATED_PROFILE_V1.cpu,
      memoryMi: POSTGRES_DEDICATED_PROFILE_V1.memoryMi,
      storageMi: POSTGRES_DEDICATED_PROFILE_V1.storageMi,
      persistent: { ...POSTGRES_DEDICATED_PROFILE_V1.persistent },
      env: { ...POSTGRES_DEDICATED_PROFILE_V1.env },
      bindings: [],
      exclusive: false,
    }));

  const env: Record<string, string> = {};
  const bindings: { env: string; workload: string }[] = [];
  for (const [key, value] of Object.entries(c.variables ?? {})) {
    const whole = WHOLE_RESOURCE_PLACEHOLDER_RE.exec(value);
    const target = whole ? m.resources?.[whole[1] ?? ""] : undefined;
    if (target?.id) bindings.push({ env: key, workload: target.id });
    else env[key] = value;
  }

  const route = resources.find(([, r]) => r.type === "route")?.[1];
  const [servicePort] = Object.values(m.service?.ports ?? {});
  const limits = c.resources?.limits ?? {};
  const requests = c.resources?.requests ?? {};
  const command = [...(c.command ?? []), ...(c.args ?? [])];
  const storage = annotations[ANNOTATION.ephemeralStorage];

  let image = c.image;
  let imagePending = false;
  if (image === BUILT_IMAGE_REF) {
    if (!options.builtImage && options.pendingImage) {
      image = options.pendingImage;
      imagePending = true;
    } else if (!options.builtImage)
      throw new WorkloadManifestError([
        {
          code: "built_image_unresolved",
          path: `containers.${containerName}.image`,
          message: `image "${BUILT_IMAGE_REF}" needs the digest node CI built at the source sha; it was not supplied`,
        },
      ]);
    else image = options.builtImage;
  }

  const app = {
    name: m.metadata.name,
    kind: "app" as const,
    image,
    ...(imagePending ? { imagePending: true as const } : {}),
    ...(command.length > 0 ? { command } : {}),
    port: servicePort?.targetPort ?? servicePort?.port,
    expose: { http: { host: route?.params?.host } },
    cpu: quantityToCpu((limits.cpu ?? requests.cpu) as string),
    memoryMi: quantityToMi((limits.memory ?? requests.memory) as string),
    storageMi:
      storage === undefined ? DEFAULT_STORAGE_MI : quantityToMi(storage),
    env,
    bindings,
    exclusive: false,
    health: {
      version: annotations[ANNOTATION.versionPath] ?? DEFAULT_VERSION_PATH,
      ready: c.readinessProbe?.httpGet?.path,
    },
  };

  // Re-parse through the deploy-spec schema: it is the last gate, and it fixes the key order, so the
  // lowered spec serializes byte-identically to a spec parsed from the old repo-spec block.
  const out: NodeWorkloadSpec[] = [];
  for (const spec of [...states, app]) {
    const parsed = nodeWorkloadSpecSchema.safeParse(spec);
    if (!parsed.success)
      throw new WorkloadManifestError(
        parsed.error.issues.slice(0, 10).map((i) => ({
          code: "lowered_spec_invalid" as const,
          path: [spec.name, ...i.path].join("."),
          message: i.message,
        }))
      );
    out.push(parsed.data);
  }
  return out;
}

/** Lower ONE checked manifest: its `postgres` dedicated dependencies (as state workloads), then its app. */
export function lowerWorkloadManifest(
  manifest: ScoreWorkload,
  options: LowerWorkloadOptions = {}
): NodeWorkloadSpec[] {
  return lowerValidated(manifest, options);
}

export interface WorkloadDirectoryEntry {
  readonly name: string;
  /** Entry type: `file`, `dir`, `symlink` or `submodule` (a submodule is never `file`). */
  readonly type: string;
  /** Size in bytes, when the listing reports it; checked against the manifest cap before any read. */
  readonly size?: number;
}

/**
 * Check a listing of `.cogni/workloads/`. Every entry must be a regular `*.yaml` file: a `.yml` file,
 * a subdirectory, a symlink or any other file would otherwise be skipped without a word, so it is
 * refused instead. Returns the manifest file names (in listing order) or throws with every issue.
 */
export function checkWorkloadDirectoryEntries(
  entries: readonly WorkloadDirectoryEntry[]
): string[] {
  const issues: WorkloadManifestIssue[] = entries
    .filter(
      (e) => e.type !== "file" || !e.name.endsWith(WORKLOAD_MANIFEST_SUFFIX)
    )
    .map((e) => ({
      code: "unexpected_manifest_entry" as const,
      path: `${WORKLOAD_MANIFEST_DIR}/${e.name}`,
      message: `${WORKLOAD_MANIFEST_DIR} may hold only <name>${WORKLOAD_MANIFEST_SUFFIX} files; this ${e.type} is refused, not skipped`,
    }));
  for (const e of entries)
    if (e.size !== undefined && e.size > MAX_WORKLOAD_MANIFEST_BYTES)
      issues.push({
        code: "manifest_too_large",
        path: `${WORKLOAD_MANIFEST_DIR}/${e.name}`,
        message: `a manifest is at most ${MAX_WORKLOAD_MANIFEST_BYTES} bytes; the listing says ${e.size}`,
      });
  if (entries.length > MAX_WORKLOAD_MANIFESTS)
    issues.push({
      code: "too_many_manifests",
      path: WORKLOAD_MANIFEST_DIR,
      message: `at most ${MAX_WORKLOAD_MANIFESTS} workload manifests per node`,
    });
  if (issues.length > 0) throw new WorkloadManifestError(issues.slice(0, 20));
  return entries.map((e) => e.name);
}

export interface WorkloadManifestFile {
  /** Repo-relative path, e.g. `.cogni/workloads/canary.yaml`. */
  readonly path: string;
  readonly text: string;
}

/**
 * Check and lower EVERY manifest a node declares (the whole `.cogni/workloads/` directory at one
 * source sha). Applies the cross-file rules: the file name is `<metadata.name>.yaml`, workload names
 * are unique, data-bearing ids are unique and differ from every workload name. Returns every lowered
 * `NodeWorkloadSpec` (state workloads first, then apps, in file order), or throws with every issue.
 */
export function lowerWorkloadManifests(
  files: readonly WorkloadManifestFile[],
  options: LowerWorkloadOptions = {}
): NodeWorkloadSpec[] {
  if (files.length > MAX_WORKLOAD_MANIFESTS)
    throw new WorkloadManifestError([
      {
        code: "too_many_manifests",
        path: WORKLOAD_MANIFEST_DIR,
        message: `at most ${MAX_WORKLOAD_MANIFESTS} workload manifests per node`,
      },
    ]);
  const issues: WorkloadManifestIssue[] = [];
  const checked: [WorkloadManifestFile, ScoreWorkload][] = [];
  for (const file of files) {
    try {
      checked.push([file, parseWorkloadManifest(file.text, file.path)]);
    } catch (error) {
      if (!(error instanceof WorkloadManifestError)) throw error;
      issues.push(...error.issues);
    }
  }

  const workloadNames = new Set<string>();
  const dataIds = new Map<string, string>();
  for (const [file, m] of checked) {
    const base = file.path.split("/").pop() ?? file.path;
    if (base !== `${m.metadata.name}${WORKLOAD_MANIFEST_SUFFIX}`)
      issues.push({
        code: "manifest_name_mismatch",
        path: "metadata.name",
        message: `the file must be named ${m.metadata.name}${WORKLOAD_MANIFEST_SUFFIX}`,
        file: file.path,
      });
    if (workloadNames.has(m.metadata.name))
      issues.push({
        code: "duplicate_workload_name",
        path: "metadata.name",
        message: `workload ${m.metadata.name} is declared twice`,
        file: file.path,
      });
    workloadNames.add(m.metadata.name);
  }
  for (const [file, m] of checked)
    for (const [key, r] of Object.entries(m.resources ?? {})) {
      if (!DATA_BEARING_DEPENDENCY_TYPES.has(r.type) || r.id === undefined)
        continue;
      const prior = dataIds.get(r.id);
      if (prior !== undefined)
        issues.push({
          code: "duplicate_data_resource_id",
          path: `resources.${key}.id`,
          message: `data-bearing id ${r.id} is already declared by ${prior}; one id has one creator`,
          file: file.path,
        });
      else dataIds.set(r.id, file.path);
      // A manifest's own name is already refused by pass 2; this catches the other manifests' names.
      if (workloadNames.has(r.id) && r.id !== m.metadata.name)
        issues.push({
          code: "data_resource_id_is_workload_name",
          path: `resources.${key}.id`,
          message: `data-bearing id ${r.id} equals a workload name; they share one key space`,
          file: file.path,
        });
    }
  if (issues.length > 0) throw new WorkloadManifestError(issues);

  const lowered = checked.map(([file, m]) => {
    try {
      return lowerValidated(m, options);
    } catch (error) {
      if (error instanceof WorkloadManifestError)
        throw new WorkloadManifestError(withFile(error.issues, file.path));
      throw error;
    }
  });
  return [
    ...lowered.flatMap((specs) => specs.filter((s) => s.kind === "state")),
    ...lowered.flatMap((specs) => specs.filter((s) => s.kind === "app")),
  ];
}
