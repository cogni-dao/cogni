// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Score `${resources...}` placeholders are literal manifest text

/**
 * Module: `@cogni/repo-spec/tests/workload-manifest`
 * Purpose: Prove the two-pass workload-manifest check and the byte-identical canary lowering.
 *   One test per policy refusal, the cross-file rules, and the operator's REAL
 *   `.cogni/workloads/canary.yaml` lowered against the pre-manifest `deployment.workloads` golden.
 * Scope: Unit tests of packages/repo-spec/src/workload-manifest.ts. Does not call the network or the operator.
 * Invariants: the vendored Score schema matches its pinned sha256; the canary lowering matches the golden sha256.
 * Side-effects: IO (reads .cogni/workloads/canary.yaml and the golden fixture)
 * Links: packages/repo-spec/src/workload-manifest.ts, hub `workload-manifest`
 * @internal
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse as parseYaml, stringify } from "yaml";

import { nodeWorkloadSpecSchema } from "../src/schema";
import {
  SCORE_V1B1_SCHEMA_TEXT,
  SCORE_V1B1_SOURCE,
} from "../src/vendor/score-v1b1.schema";
import {
  checkWorkloadDirectoryEntries,
  findLiteralSecret,
  lowerWorkloadManifest,
  lowerWorkloadManifests,
  MAX_WORKLOAD_MANIFEST_BYTES,
  parseWorkloadManifest,
  placementCountriesOf,
  quantityToCpu,
  quantityToMi,
  resolvePlacementCountries,
  type WorkloadManifestError,
  type WorkloadManifestIssueCode,
} from "../src/workload-manifest";

const here = path.dirname(fileURLToPath(import.meta.url));
const CANARY_PATH = ".cogni/workloads/canary.yaml";
const CANARY = readFileSync(
  path.resolve(here, "../../..", CANARY_PATH),
  "utf8"
);
/**
 * `JSON.stringify(extractNodeWorkloads(parseRepoSpec(<root .cogni/repo-spec.yaml>)), null, 2)` at
 * cogni-dao/cogni main 85e7cedff4, the last commit that declared the canary under
 * `deployment.workloads`. Its compact serialization hashes to GOLDEN_SHA256.
 */
const GOLDEN_TEXT = readFileSync(
  path.resolve(here, "fixtures/canary-node-workload-spec.golden.json"),
  "utf8"
);
const GOLDEN_SHA256 =
  "87caac453bafd016bdf4ce983428007afb27523eb9daf6852f13d9e5df090295";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const DIGEST = `sha256:${"a".repeat(64)}`;

// biome-ignore lint/suspicious/noExplicitAny: the tests mutate arbitrary parsed-YAML shapes
type Doc = Record<string, any>;
const canaryDoc = (): Doc => parseYaml(CANARY) as Doc;
const app = (d: Doc): Doc => d.containers.app;

/** Mutate the canary, run both passes, and return the refusal codes (empty when accepted). */
function refusals(mutate: (d: Doc) => void): WorkloadManifestIssueCode[] {
  const d = canaryDoc();
  mutate(d);
  try {
    parseWorkloadManifest(stringify(d));
    return [];
  } catch (error) {
    return (error as WorkloadManifestError).issues.map((i) => i.code);
  }
}

function crossFileRefusals(
  files: { path: string; text: string }[]
): WorkloadManifestIssueCode[] {
  try {
    lowerWorkloadManifests(files);
    return [];
  } catch (error) {
    return (error as WorkloadManifestError).issues.map((i) => i.code);
  }
}

describe("the vendored Score v1b1 schema", () => {
  it("is byte-identical to the upstream file at the pinned commit", () => {
    expect(SCORE_V1B1_SOURCE.url).toContain(SCORE_V1B1_SOURCE.commit);
    expect(sha256(SCORE_V1B1_SCHEMA_TEXT)).toBe(SCORE_V1B1_SOURCE.sha256);
    expect(SCORE_V1B1_SOURCE.sha256).toBe(
      "d326c718112ceff4bb90a32e997cc81e9067b00a93516c7d6b715018a3ece940"
    );
  });
});

describe("the operator canary manifest", () => {
  it("lowers to a NodeWorkloadSpec pair byte-identical to the pre-manifest deployment.workloads pair", () => {
    const lowered = lowerWorkloadManifests([
      { path: CANARY_PATH, text: CANARY },
    ]);
    expect(sha256(JSON.stringify(JSON.parse(GOLDEN_TEXT)))).toBe(GOLDEN_SHA256);
    expect(sha256(JSON.stringify(lowered))).toBe(GOLDEN_SHA256);
    expect(JSON.stringify(lowered)).toBe(
      JSON.stringify(JSON.parse(GOLDEN_TEXT))
    );
  });

  it("canary-db is the state named by the dependency id; canary binds DATABASE_URL to it", () => {
    const [db, canary] = lowerWorkloadManifest(parseWorkloadManifest(CANARY));
    expect(db).toMatchObject({
      name: "canary-db",
      kind: "state",
      storageMi: 512,
      expose: { tcp: { global: true } },
    });
    expect(canary).toMatchObject({
      name: "canary",
      kind: "app",
      port: 8080,
      storageMi: 256,
      env: {},
      bindings: [{ env: "DATABASE_URL", workload: "canary-db" }],
      health: { version: "/version", ready: "/readyz" },
      exclusive: false,
    });
  });
});

describe("private companion shape", () => {
  it("accepts a private companion before the public entry regardless of order", () => {
    const d = canaryDoc();
    d.containers = {
      "paper-trader": {
        image: ".",
        readinessProbe: { httpGet: { path: "/readyz", port: 9100 } },
        resources: { limits: { cpu: "250m", memory: "256Mi" } },
      },
      app: d.containers.app,
    };
    d.metadata.annotations["cogni.dev/qualification-path"] =
      "/api/v1/deploy/qualification";
    d.metadata.annotations["cogni.dev/qualification-timeout-ms"] = "20000";
    expect(() => parseWorkloadManifest(stringify(d))).not.toThrow();
  });
});

describe("private companion lowering", () => {
  it.each([
    512, 513,
  ])("bounds companion readiness at %i characters", (length) => {
    const d = canaryDoc();
    d.containers.helper = {
      image: ".",
      readinessProbe: {
        httpGet: { path: `/${"a".repeat(length - 1)}`, port: 8181 },
      },
      resources: { limits: { cpu: "250m", memory: "256Mi" } },
    };
    d.metadata.annotations["cogni.dev/qualification-path"] = "/qualification";
    d.metadata.annotations["cogni.dev/qualification-timeout-ms"] = "20000";
    const lower = () =>
      lowerWorkloadManifest(parseWorkloadManifest(stringify(d)), {
        pendingImage: `ghcr.io/example/node:sha-${"1".repeat(40)}`,
      });
    if (length === 513) expect(lower).toThrow(/512/);
    else
      expect(
        lower().find((w) => w.kind === "app")?.companions?.[0]?.ready
      ).toBe(d.containers.helper.readinessProbe.httpGet.path);
  });

  it("preserves long public health paths without companions", () => {
    const d = canaryDoc();
    d.containers.app.readinessProbe.httpGet.path = `/${"a".repeat(512)}`;
    const out = lowerWorkloadManifest(parseWorkloadManifest(stringify(d)), {
      builtImage: `ghcr.io/example/node@${DIGEST}`,
    });
    expect(out.find((w) => w.kind === "app")?.health?.ready).toBe(
      d.containers.app.readinessProbe.httpGet.path
    );
  });

  it("lowers the public entry by target port and retains the private container runtime", () => {
    const d = canaryDoc();
    d.containers = {
      helper: {
        image: ".",
        command: ["helper"],
        args: ["serve"],
        readinessProbe: { httpGet: { path: "/health", port: 8181 } },
        resources: { requests: { cpu: "500m", memory: "384Mi" } },
        variables: { MODE: "synthetic" },
      },
      app: d.containers.app,
    };
    d.metadata.annotations["cogni.dev/qualification-path"] =
      "/api/v1/deploy/qualification";
    d.metadata.annotations["cogni.dev/qualification-timeout-ms"] = "20000";
    const out = lowerWorkloadManifest(parseWorkloadManifest(stringify(d)), {
      pendingImage: `ghcr.io/example/node:sha-${"1".repeat(40)}`,
    });
    const app = out.find((w) => w.kind === "app");
    expect(app?.port).toBe(8080);
    expect(app?.companions?.[0]).toMatchObject({
      name: "helper",
      imagePending: true,
      port: 8181,
      cpu: 0.5,
      memoryMi: 384,
      command: ["helper", "serve"],
      ready: "/health",
      env: { MODE: "synthetic" },
    });
  });
  it("refuses ambiguous public entry ports instead of using container order", () => {
    const d = canaryDoc();
    d.containers.other = structuredClone(d.containers.app);
    expect(() => parseWorkloadManifest(stringify(d))).toThrow(
      /exactly one readiness port/
    );
  });
  it("supports eight containers and refuses nine before lowering", () => {
    const d = canaryDoc();
    d.metadata.annotations["cogni.dev/qualification-path"] =
      "/api/v1/deploy/qualification";
    d.metadata.annotations["cogni.dev/qualification-timeout-ms"] = "20000";
    for (let i = 0; i < 7; i++)
      d.containers[`helper-${i}`] = {
        image: ".",
        readinessProbe: { httpGet: { path: "/readyz", port: 8100 + i } },
        resources: { limits: { cpu: "250m", memory: "256Mi" } },
      };
    expect(() => parseWorkloadManifest(stringify(d))).not.toThrow();
    d.containers.extra = structuredClone(d.containers["helper-0"]);
    expect(() => parseWorkloadManifest(stringify(d))).toThrow(/1–8 containers/);
  });
});

describe("pass 1: the Score schema", () => {
  it.each<[string, (d: Doc) => void]>([
    [
      "a wrong apiVersion",
      (d) => {
        d.apiVersion = "score.dev/v1b2";
      },
    ],
    [
      "an unknown top-level field",
      (d) => {
        d.kind = "Deployment";
      },
    ],
    [
      "an unknown container field",
      (d) => {
        app(d).ports = [80];
      },
    ],
    [
      "a non-string annotation",
      (d) => {
        d.metadata.annotations["cogni.dev/exclusive"] = false;
      },
    ],
    [
      "a missing image",
      (d) => {
        delete app(d).image;
      },
    ],
  ])("refuses %s", (_name, mutate) => {
    expect(refusals(mutate)).toContain("schema_invalid");
  });

  it("a YAML refusal never echoes source text (a secret-looking line stays out of the error)", () => {
    const text =
      "apiVersion: score.dev/v1b1\npassword: hunter2secretvalue: [x\n  c: d\n";
    try {
      parseWorkloadManifest(text);
      expect.unreachable("must refuse");
    } catch (error) {
      const e = error as WorkloadManifestError;
      expect(e.code).toBe("manifest_unparseable");
      expect(e.message).not.toContain("hunter2secretvalue");
      expect(JSON.stringify(e.issues)).not.toContain("hunter2secretvalue");
    }
  });

  it("refuses YAML that does not parse", () => {
    expect(() => parseWorkloadManifest("a: [unclosed")).toThrow(
      expect.objectContaining({ code: "manifest_unparseable" })
    );
  });
});

describe("pass 2: Cogni policy refuses before any paid create", () => {
  it.each<[string, (d: Doc) => void, WorkloadManifestIssueCode]>([
    [
      "an unmapped Score field (livenessProbe)",
      (d) => {
        app(d).livenessProbe = { httpGet: { path: "/x", port: 8080 } };
      },
      "unmapped_field",
    ],
    [
      "an unmapped Score field (files)",
      (d) => {
        app(d).files = { "/etc/x": { content: "x" } };
      },
      "unmapped_field",
    ],
    [
      "an unmapped metadata field",
      (d) => {
        d.metadata.labels = "x";
      },
      "unmapped_field",
    ],
    [
      "a non-cogni.dev annotation",
      (d) => {
        d.metadata.annotations["example.com/team"] = "y";
      },
      "unmapped_field",
    ],
    [
      "an unmapped route param",
      (d) => {
        d.resources.web.params.tls = "on";
      },
      "unmapped_field",
    ],
    [
      "postgres params (the operator owns the size)",
      (d) => {
        d.resources.db.params = { size: "10Gi" };
      },
      "unmapped_field",
    ],
    [
      "a readinessProbe exec",
      (d) => {
        app(d).readinessProbe.exec = { command: ["true"] };
      },
      "unmapped_field",
    ],
    [
      "args without command",
      (d) => {
        app(d).args = app(d).command;
        delete app(d).command;
      },
      "unmapped_field",
    ],
    [
      "a mutable image tag",
      (d) => {
        app(d).image = "python:3.12-alpine";
      },
      "image_not_digest_pinned",
    ],
    [
      "a missing cogni.dev/exclusive",
      (d) => {
        delete d.metadata.annotations["cogni.dev/exclusive"];
      },
      "exclusive_missing",
    ],
    [
      'cogni.dev/exclusive: "true"',
      (d) => {
        d.metadata.annotations["cogni.dev/exclusive"] = "true";
      },
      "exclusive_unsupported",
    ],
    [
      "an unknown cogni.dev key",
      (d) => {
        d.metadata.annotations["cogni.dev/replicas"] = "2";
      },
      "unknown_annotation",
    ],
    [
      "a bad ephemeral-storage value",
      (d) => {
        d.metadata.annotations["cogni.dev/ephemeral-storage"] = "1.5M";
      },
      "invalid_annotation",
    ],
    [
      "a literal password in a URL variable",
      (d) => {
        app(d).variables.OTHER_URL = "postgres://u:hunter22@db:5432/x";
      },
      "literal_secret",
    ],
    [
      "a literal value in a secret-named variable",
      (d) => {
        app(d).variables.API_TOKEN = "abc";
      },
      "literal_secret",
    ],
    [
      "a token in command",
      (d) => {
        app(d).command.push(`ghp_${"A".repeat(36)}`);
      },
      "literal_secret",
    ],
    [
      "a password assignment in args",
      (d) => {
        app(d).args = ["--password=correcthorse"];
      },
      "literal_secret",
    ],
    [
      "an unsupported dependency type (redis)",
      (d) => {
        d.resources.cache = { type: "redis" };
      },
      "unsupported_dependency_type",
    ],
    [
      "a prototype key as a dependency type (constructor)",
      (d) => {
        d.resources.proto = { type: "constructor" };
      },
      "unsupported_dependency_type",
    ],
    [
      "a prototype key as a dependency type (toString)",
      (d) => {
        d.resources.proto = { type: "toString" };
      },
      "unsupported_dependency_type",
    ],
    [
      "an unsupported dependency type (ai-gateway)",
      (d) => {
        d.resources.llm = { type: "ai-gateway" };
      },
      "unsupported_dependency_type",
    ],
    [
      "postgres class shared (not in this version)",
      (d) => {
        d.resources.db.class = "shared";
      },
      "unsupported_dependency_class",
    ],
    [
      "postgres with no class",
      (d) => {
        delete d.resources.db.class;
      },
      "unsupported_dependency_class",
    ],
    [
      "a probe port that differs from the route targetPort",
      (d) => {
        app(d).readinessProbe.httpGet.port = 9090;
      },
      "probe_port_mismatch",
    ],
    [
      "a workload name outside ^[a-z][a-z0-9-]{0,62}$",
      (d) => {
        d.metadata.name = "9canary";
      },
      "invalid_name",
    ],
    [
      "a dependency id outside ^[a-z][a-z0-9-]{0,62}$",
      (d) => {
        d.resources.db.id = "canary.db";
      },
      "invalid_name",
    ],
    [
      "a workload name containing -mesh- (attempt-key Secret delete allow-list, task.5431)",
      (d) => {
        d.metadata.name = "x-mesh-y";
      },
      "invalid_name",
    ],
    [
      "a dependency id containing -mesh- (it names a state password Secret)",
      (d) => {
        d.resources.db.id = "db-mesh-1";
      },
      "invalid_name",
    ],
    [
      "a data-bearing dependency with no id",
      (d) => {
        delete d.resources.db.id;
      },
      "data_resource_id_required",
    ],
    [
      "a data-bearing id equal to the workload name",
      (d) => {
        d.resources.db.id = "canary";
      },
      "data_resource_id_is_workload_name",
    ],
    [
      "a resource placeholder inside a larger variables value",
      (d) => {
        app(d).variables.DATABASE_URL = "${resources.db.url}?x=1";
      },
      "placeholder_not_whole_value",
    ],
    [
      "a resource placeholder in command",
      (d) => {
        app(d).command.push("${resources.db.url}");
      },
      "placeholder_not_whole_value",
    ],
    [
      "a URL built from parts (an output other than url)",
      (d) => {
        app(d).variables.DB_HOST = "${resources.db.host}";
      },
      "unsupported_placeholder",
    ],
    [
      "a placeholder for an undeclared resource",
      (d) => {
        app(d).variables.DATABASE_URL = "${resources.nope.url}";
      },
      "unsupported_placeholder",
    ],
    [
      "a private container without readiness/resources",
      (d) => {
        d.containers.side = { image: `busybox@${DIGEST}` };
      },
      "readiness_probe_required",
    ],
    [
      "a missing route",
      (d) => {
        delete d.resources.web;
      },
      "route_invalid",
    ],
    [
      "a route path other than /",
      (d) => {
        d.resources.web.params.path = "/api";
      },
      "route_invalid",
    ],
    [
      "a missing readiness probe",
      (d) => {
        delete app(d).readinessProbe;
      },
      "readiness_probe_required",
    ],
    [
      "no cpu or memory",
      (d) => {
        delete app(d).resources;
      },
      "invalid_quantity",
    ],
  ])("refuses %s", (_name, mutate, code) => {
    expect(refusals(mutate)).toContain(code);
  });

  it("never echoes a secret value in the refusal", () => {
    const d = canaryDoc();
    app(d).variables.OTHER_URL = "postgres://u:hunter22@db:5432/x";
    expect(() => parseWorkloadManifest(stringify(d))).toThrow(
      expect.not.objectContaining({
        message: expect.stringContaining("hunter22"),
      })
    );
  });

  it("accepts the canary itself and an image built at the source sha", () => {
    expect(refusals(() => undefined)).toEqual([]);
    expect(
      refusals((d) => {
        app(d).image = ".";
      })
    ).toEqual([]);
  });
});

describe("lowering rules", () => {
  it("limits win over requests; storage and version path come from annotations", () => {
    const d = canaryDoc();
    app(d).resources.limits = { cpu: "1", memory: "1Gi" };
    d.metadata.annotations["cogni.dev/ephemeral-storage"] = "1Gi";
    d.metadata.annotations["cogni.dev/version-path"] = "/v";
    app(d).variables.LOG_LEVEL = "info";
    const [, canary] = lowerWorkloadManifest(
      parseWorkloadManifest(stringify(d))
    );
    expect(canary).toMatchObject({
      cpu: 1,
      memoryMi: 1024,
      storageMi: 1024,
      env: { LOG_LEVEL: "info" },
      health: { version: "/v", ready: "/readyz" },
    });
  });

  it('an image "." needs the digest node CI built; it is refused when absent', () => {
    const d = canaryDoc();
    app(d).image = ".";
    const m = parseWorkloadManifest(stringify(d));
    expect(() => lowerWorkloadManifest(m)).toThrow(
      expect.objectContaining({ code: "built_image_unresolved" })
    );
    const built = `ghcr.io/cogni-dao/canary@${DIGEST}`;
    expect(lowerWorkloadManifest(m, { builtImage: built })[1]?.image).toBe(
      built
    );
  });

  it('an image "." can be deferred to `<repo>:sha-<sha>` as a PENDING app; the schema accepts a tag only with imagePending (story.5137)', () => {
    const d = canaryDoc();
    app(d).image = ".";
    const m = parseWorkloadManifest(stringify(d));
    const sha = "a".repeat(40);
    const tag = `ghcr.io/cogni-dao/canary:sha-${sha}`;
    const app0 = lowerWorkloadManifest(m, { pendingImage: tag })[1];
    expect(app0).toMatchObject({ image: tag, imagePending: true });
    // a digest, when also supplied, wins and the app is not pending
    const built = `ghcr.io/cogni-dao/canary@${DIGEST}`;
    const pinned = lowerWorkloadManifest(m, {
      builtImage: built,
      pendingImage: tag,
    })[1];
    expect(pinned?.image).toBe(built);
    expect(pinned?.imagePending).toBeUndefined();
    // a bare tag without the pending flag is still refused, so a mutable tag never becomes a spec
    expect(
      nodeWorkloadSpecSchema.safeParse({ ...app0, imagePending: undefined })
        .success
    ).toBe(false);
    // a pending image must be the sha tag, and only an app can be pending
    expect(
      nodeWorkloadSpecSchema.safeParse({ ...app0, image: "ghcr.io/x/y:latest" })
        .success
    ).toBe(false);
  });

  it("a stored release spec recorded with legacy secret_refs still parses, and the field is dropped (bug.5254)", () => {
    const d = canaryDoc();
    app(d).image = ".";
    const m = parseWorkloadManifest(stringify(d));
    const tag = `ghcr.io/cogni-dao/canary:sha-${"a".repeat(40)}`;
    const app0 = lowerWorkloadManifest(m, { pendingImage: tag })[1];
    const service = (name: string, extra: Record<string, unknown>) => ({
      name,
      artifact: { name },
      port: 3200,
      visibility: name === "app" ? "public" : "private",
      bindings: {},
      bind_host: "0.0.0.0",
      resources: { cpu_units: 1, memory_mi: 512, storage_mi: 1024 },
      ...extra,
    });
    const stored = {
      ...app0,
      artifactPlan: {
        repository: "cogni-dao/canary",
        imageRepository: "ghcr.io/cogni-dao/canary",
        services: [
          // `[]` is what the old `.default([])` froze into every row; real keys are poly's and red's rows
          service("app", { secret_refs: [] }),
          service("helper", { secret_refs: [{ key: "X" }] }),
          service("plain", {}),
        ],
      },
    };
    const parsed = nodeWorkloadSpecSchema.safeParse(stored);
    expect(parsed.success).toBe(true);
    for (const frozen of parsed.success
      ? (parsed.data.artifactPlan?.services ?? [])
      : [])
      expect(frozen).not.toHaveProperty("secret_refs");
    expect(
      parsed.success && parsed.data.artifactPlan?.services.map((s) => s.name)
    ).toEqual(["app", "helper", "plain"]);
  });

  it("parses Kubernetes quantities", () => {
    expect(quantityToCpu("250m")).toBe(0.25);
    expect(quantityToCpu("2")).toBe(2);
    expect(quantityToCpu("0.5")).toBe(0.5);
    expect(quantityToMi("256Mi")).toBe(256);
    expect(quantityToMi("2Gi")).toBe(2048);
    expect(quantityToMi("1M")).toBeUndefined();
    expect(findLiteralSecret("create table x(id serial primary key)")).toBe(
      undefined
    );
  });
});

describe("placement countries (story.5141, hub node-choose-placement-region)", () => {
  const BASE = "cogni.dev/placement-countries";
  const withPlacement = (annotations: Record<string, string>): Doc => {
    const d = canaryDoc();
    Object.assign(d.metadata.annotations, annotations);
    return d;
  };

  it("a base set applies to every env", () => {
    const m = parseWorkloadManifest(
      stringify(withPlacement({ [BASE]: "FI,NL,PT" }))
    );
    const placement = placementCountriesOf(m);
    expect(placement).toEqual({ default: ["FI", "NL", "PT"], byEnv: {} });
    for (const env of ["candidate-a", "preview", "production"])
      expect(resolvePlacementCountries(placement, env)).toEqual([
        "FI",
        "NL",
        "PT",
      ]);
  });

  it("a per-env set replaces the base for that env only", () => {
    const m = parseWorkloadManifest(
      stringify(
        withPlacement({
          [BASE]: "FI,NL,PT",
          [`${BASE}-candidate-a`]: "BE",
        })
      )
    );
    const placement = placementCountriesOf(m);
    expect(placement).toEqual({
      default: ["FI", "NL", "PT"],
      byEnv: { "candidate-a": ["BE"] },
    });
    expect(resolvePlacementCountries(placement, "candidate-a")).toEqual(["BE"]);
    expect(resolvePlacementCountries(placement, "production")).toEqual([
      "FI",
      "NL",
      "PT",
    ]);
  });

  it("a per-env set alone leaves the other envs unconstrained", () => {
    const placement = placementCountriesOf(
      parseWorkloadManifest(
        stringify(withPlacement({ [`${BASE}-production`]: "PT" }))
      )
    );
    expect(resolvePlacementCountries(placement, "production")).toEqual(["PT"]);
    expect(resolvePlacementCountries(placement, "preview")).toBeUndefined();
  });

  it("the app lowers with the set for the release env; the state workload never carries one", () => {
    const m = parseWorkloadManifest(
      stringify(
        withPlacement({ [BASE]: "FI,NL,PT", [`${BASE}-candidate-a`]: "BE" })
      )
    );
    const [db, prod] = lowerWorkloadManifest(m, { env: "production" });
    expect(prod?.placement).toEqual({
      requiredCountryCodes: ["FI", "NL", "PT"],
    });
    expect(db?.placement).toBeUndefined();
    const [, cand] = lowerWorkloadManifest(m, { env: "candidate-a" });
    expect(cand?.placement).toEqual({ requiredCountryCodes: ["BE"] });
  });

  it("a declared set needs the release env at lowering (never dropped in silence)", () => {
    const m = parseWorkloadManifest(stringify(withPlacement({ [BASE]: "FI" })));
    expect(() => lowerWorkloadManifest(m)).toThrow(/release env/);
    // the base set applies to any env (a local `dev` harness included); per-env keys exist for three
    expect(lowerWorkloadManifest(m, { env: "dev" })[1]?.placement).toEqual({
      requiredCountryCodes: ["FI"],
    });
  });

  it("no annotation lowers with no placement field, in every env", () => {
    const m = parseWorkloadManifest(CANARY);
    expect(placementCountriesOf(m)).toEqual({ byEnv: {} });
    const [, canary] = lowerWorkloadManifest(m, { env: "production" });
    expect(canary && "placement" in canary).toBe(false);
  });

  it.each<[string, Record<string, string>, WorkloadManifestIssueCode]>([
    ["a lowercase code", { [BASE]: "fi,NL" }, "invalid_annotation"],
    ["a three-letter code", { [BASE]: "FIN" }, "invalid_annotation"],
    ["a digit in a code", { [BASE]: "F1" }, "invalid_annotation"],
    ["a space after a comma", { [BASE]: "FI, NL" }, "invalid_annotation"],
    ["an empty set", { [BASE]: "" }, "invalid_annotation"],
    ["an empty member", { [BASE]: "FI,,NL" }, "invalid_annotation"],
    ["a trailing comma", { [BASE]: "FI," }, "invalid_annotation"],
    ["a duplicate code", { [BASE]: "FI,NL,FI" }, "invalid_annotation"],
    [
      "an invalid per-env set",
      { [`${BASE}-production`]: "pt" },
      "invalid_annotation",
    ],
    [
      "an unknown env suffix",
      { [`${BASE}-staging`]: "PT" },
      "unknown_annotation",
    ],
    [
      "a misspelled key",
      { "cogni.dev/placement-country": "PT" },
      "unknown_annotation",
    ],
  ])("refuses %s", (_label, annotations, code) => {
    expect(
      refusals((d) => Object.assign(d.metadata.annotations, annotations))
    ).toEqual([code]);
  });

  it("refuses more than 32 codes", () => {
    const codes = Array.from({ length: 33 }, (_, i) =>
      String.fromCharCode(65 + Math.floor(i / 26), 65 + (i % 26))
    ).join(",");
    expect(
      refusals((d) => {
        d.metadata.annotations[BASE] = codes;
      })
    ).toEqual(["invalid_annotation"]);
  });
});

describe("cross-manifest rules (one node's whole .cogni/workloads/ at one sha)", () => {
  const other = (name: string, mutate: (d: Doc) => void = () => undefined) => {
    const d = canaryDoc();
    d.metadata.name = name;
    d.resources.web.params.host = `${name}.cognidao.org`;
    mutate(d);
    return { path: `.cogni/workloads/${name}.yaml`, text: stringify(d) };
  };
  const canary = { path: CANARY_PATH, text: CANARY };

  it("refuses two manifests that declare the same data-bearing id (one id, one creator)", () => {
    expect(crossFileRefusals([canary, other("second")])).toContain(
      "duplicate_data_resource_id"
    );
  });

  it("refuses a data-bearing id that equals another workload's name", () => {
    expect(
      crossFileRefusals([
        canary,
        other("second", (d) => {
          d.resources.db.id = "canary";
        }),
      ])
    ).toContain("data_resource_id_is_workload_name");
  });

  it("refuses a file whose name is not <metadata.name>.yaml", () => {
    expect(
      crossFileRefusals([{ path: ".cogni/workloads/x.yaml", text: CANARY }])
    ).toContain("manifest_name_mismatch");
  });

  it("lowers two valid manifests: states first, then apps", () => {
    const lowered = lowerWorkloadManifests([
      canary,
      other("second", (d) => {
        d.resources.db.id = "second-db";
      }),
    ]);
    expect(lowered.map((w) => `${w.kind}:${w.name}`)).toEqual([
      "state:canary-db",
      "state:second-db",
      "app:canary",
      "app:second",
    ]);
  });
});

describe("bounded input and the manifest directory", () => {
  it("refuses a manifest over 64 KiB before parsing it (no regex runs on it)", () => {
    // A long run that would make the URL-with-password pattern backtrack if it were scanned.
    const huge = `${CANARY}\n# ${"a:".repeat(MAX_WORKLOAD_MANIFEST_BYTES)}\n`;
    const started = Date.now();
    expect(() => parseWorkloadManifest(huge, CANARY_PATH)).toThrow(
      expect.objectContaining({
        code: "manifest_too_large",
        issues: [expect.objectContaining({ file: CANARY_PATH })],
      })
    );
    expect(Date.now() - started).toBeLessThan(1000);
    expect(MAX_WORKLOAD_MANIFEST_BYTES).toBe(65536);
    expect(() => parseWorkloadManifest(CANARY)).not.toThrow();
  });

  it("refuses every .cogni/workloads entry that is not a *.yaml file, instead of skipping it", () => {
    expect(
      checkWorkloadDirectoryEntries([{ name: "canary.yaml", type: "file" }])
    ).toEqual(["canary.yaml"]);
    try {
      checkWorkloadDirectoryEntries([
        { name: "canary.yaml", type: "file" },
        { name: "worker.yml", type: "file" },
        { name: "nested", type: "dir" },
        { name: "link.yaml", type: "symlink" },
        { name: "README.md", type: "file" },
      ]);
      expect.unreachable("must refuse");
    } catch (error) {
      expect(
        (error as WorkloadManifestError).issues.map((i) => i.path)
      ).toEqual([
        ".cogni/workloads/worker.yml",
        ".cogni/workloads/nested",
        ".cogni/workloads/link.yaml",
        ".cogni/workloads/README.md",
      ]);
      expect(
        new Set((error as WorkloadManifestError).issues.map((i) => i.code))
      ).toEqual(new Set(["unexpected_manifest_entry"]));
    }
  });
});

describe("refusals never echo source text (NO_SOURCE_ECHO)", () => {
  const TOKEN = "sekrit_tok3n";
  it.each([
    [
      "an unresolved alias",
      `apiVersion: score.dev/v1b1\nmetadata: *${TOKEN}\n`,
    ],
    [
      "a bad %YAML directive",
      `%YAML 9.9 ${TOKEN}\n---\napiVersion: score.dev/v1b1\n`,
    ],
    [
      "a bad block-scalar header",
      `apiVersion: score.dev/v1b1\nmetadata:\n  name: |${TOKEN}\n    x\n`,
    ],
  ])("%s: refused with a code and line only", (_name, text) => {
    try {
      parseWorkloadManifest(text, CANARY_PATH);
      expect.unreachable("must refuse");
    } catch (error) {
      const e = error as WorkloadManifestError;
      expect(e.code).toBe("manifest_unparseable");
      expect(e.message).not.toContain(TOKEN);
      expect(JSON.stringify(e.issues)).not.toContain(TOKEN);
    }
  });
});

describe("the secret scanner stays linear on hostile input", () => {
  it("64 KiB of eyJ- scans in under 100 ms, and a real JWT is still found", () => {
    const hostile = "eyJ-".repeat(16 * 1024);
    const started = performance.now();
    expect(findLiteralSecret(hostile)).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(100);
    expect(
      findLiteralSecret(
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijklmnop"
      )
    ).toBe("a JWT");
  });
});

describe("the directory listing is checked before any read", () => {
  it("refuses an entry the listing says is over 64 KiB, and a submodule", () => {
    try {
      checkWorkloadDirectoryEntries([
        { name: "canary.yaml", type: "file", size: 1024 },
        {
          name: "big.yaml",
          type: "file",
          size: MAX_WORKLOAD_MANIFEST_BYTES + 1,
        },
        { name: "vendored.yaml", type: "submodule", size: 0 },
      ]);
      expect.unreachable("must refuse");
    } catch (error) {
      expect(
        (error as WorkloadManifestError).issues.map((i) => [i.code, i.path])
      ).toEqual([
        ["unexpected_manifest_entry", ".cogni/workloads/vendored.yaml"],
        ["manifest_too_large", ".cogni/workloads/big.yaml"],
      ]);
    }
  });
});
