// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/overlay-behavior-parity`
 * Purpose: Candidate-a control-plane overlays may differ from production's only in identity, because candidate is where production behavior is proven (task.5270).
 * Scope: Static comparison of operator + scheduler-worker overlay sources (fields, JSON6902 ops, strategic-merge patches, local resources); does not render kustomize or reach a cluster.
 * Invariants:
 *   - IDENTITY_ONLY_DELTA: every differing leaf matches the declared identity allowlist.
 *   - NAMED_EXCEPTIONS_ONLY: every behavior exception is reasoned, scoped, and must still apply.
 *   - NO_DEAD_ALLOWLIST: every identity pattern matches a current delta.
 * Notes: File parity is not behavior parity: candidate's 3-provider Akash pin validated a
 *   different auction than production's 12 and nothing failed. Identity = namespace/env,
 *   account, domain/URL/host, secret ref, org/repo, deploy ref, artifact pin.
 * Side-effects: IO (reads infra/k8s/overlays/{candidate-a,production}/{operator,scheduler-worker})
 * Links: infra/k8s/overlays/candidate-a/operator/kustomization.yaml,
 *   infra/k8s/overlays/production/operator/kustomization.yaml, task.5270, story.5038
 * @public
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "yaml";

const REPO_ROOT = path.resolve(__dirname, "../..");
const OVERLAYS = path.join(REPO_ROOT, "infra/k8s/overlays");

type Leaves = Map<string, string>;

const docs = (text: string): unknown[] =>
  yaml
    .parseAllDocuments(text)
    .map((d) => d.toJSON() as unknown)
    .filter((d) => d !== null && d !== undefined);

/** Arrays of named objects (containers, env, ports) are keyed by name, so order never counts. */
function flatten(value: unknown, prefix: string, out: Leaves): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      const named =
        item !== null &&
        typeof item === "object" &&
        typeof (item as { name?: unknown }).name === "string";
      const key = named ? (item as { name: string }).name : String(index);
      flatten(item, `${prefix}[${key}]`, out);
    });
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, `${prefix}.${key}`, out);
    }
    return;
  }
  out.set(prefix, JSON.stringify(value));
}

const objectId = (doc: unknown): string => {
  const o = doc as { kind?: string; metadata?: { name?: string } };
  return `${o.kind ?? "?"}/${o.metadata?.name ?? "?"}`;
};

interface PatchEntry {
  path?: string;
  patch?: string;
  target?: { kind?: string; name?: string };
}

function patchLeaves(entry: PatchEntry, dir: string, out: Leaves): void {
  const body = entry.path
    ? readFileSync(path.join(dir, entry.path), "utf8")
    : (entry.patch ?? "");
  for (const doc of docs(body)) {
    const target = entry.target
      ? `${entry.target.kind ?? "?"}/${entry.target.name ?? "?"}`
      : objectId(doc);
    if (Array.isArray(doc)) {
      // JSON6902: one leaf per (op, path), so an op that moves between envs is a delta.
      for (const op of doc as { op: string; path: string; value?: unknown }[]) {
        flatten(op.value ?? null, `patch[${target}] ${op.op} ${op.path}`, out);
      }
    } else {
      flatten(doc, `patch[${target}]`, out);
    }
  }
}

/** Every behavior-bearing leaf one overlay declares, independent of ordering and comments. */
function overlayLeaves(env: string, component: string): Leaves {
  const dir = path.join(OVERLAYS, env, component);
  const kustomization = yaml.parse(
    readFileSync(path.join(dir, "kustomization.yaml"), "utf8")
  ) as Record<string, unknown>;
  const out: Leaves = new Map();
  for (const [key, value] of Object.entries(kustomization)) {
    if (key === "patches") continue;
    if (key === "resources") {
      for (const ref of value as string[]) {
        const file = path.join(dir, ref);
        if (
          ref.startsWith("./") &&
          existsSync(file) &&
          file.endsWith(".yaml")
        ) {
          for (const doc of docs(readFileSync(file, "utf8"))) {
            flatten(doc, `resource[${objectId(doc)}]`, out);
          }
        } else {
          out.set(`resources[${ref}]`, "true");
        }
      }
      continue;
    }
    flatten(value, `kustomization.${key}`, out);
  }
  for (const entry of (kustomization.patches ?? []) as PatchEntry[]) {
    patchLeaves(entry, dir, out);
  }
  return out;
}

function leafDeltas(candidate: Leaves, production: Leaves): string[] {
  const keys = new Set([...candidate.keys(), ...production.keys()]);
  return [...keys]
    .filter((key) => candidate.get(key) !== production.get(key))
    .sort();
}

function deltas(component: string): string[] {
  return leafDeltas(
    overlayLeaves("candidate-a", component),
    overlayLeaves("production", component)
  );
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
/** A JSON6902 op on a ConfigMap data key, either `add` or `replace`. */
const dataKey = (configMap: string, key: string): RegExp =>
  new RegExp(
    `^patch\\[ConfigMap/${esc(configMap)}\\] (add|replace) /data/${esc(key)}$`
  );
const envValue = (
  deployment: string,
  container: string,
  name: string
): RegExp =>
  new RegExp(
    `^patch\\[Deployment/${esc(deployment)}\\]\\.spec\\.template\\.spec\\.containers\\[${esc(container)}\\]\\.env\\[${esc(name)}\\]\\.value$`
  );

interface Rule {
  why: string;
  pattern: RegExp;
  /** A named pilot rule must match its reviewed value, with no production declaration. */
  values?: { candidate: string; production: undefined };
}

function accepts(
  rule: Rule,
  key: string,
  candidate: Leaves,
  production: Leaves
): boolean {
  return (
    rule.pattern.test(key) &&
    (!rule.values ||
      (candidate.get(key) === rule.values.candidate &&
        production.get(key) === rule.values.production))
  );
}

function deadRules(
  rules: Rule[],
  found: string[],
  candidate: Leaves,
  production: Leaves
): string[] {
  return rules
    .filter(
      (rule) => !found.some((key) => accepts(rule, key, candidate, production))
    )
    .map((rule) => `${rule.why} :: ${rule.pattern.source}`);
}

const COMMON_IDENTITY: Rule[] = [
  { why: "namespace", pattern: /^kustomization\.namespace$/ },
  {
    why: "artifact pin (digest vs promotion placeholder)",
    pattern: /^kustomization\.images\[[^\]]+\]\.(digest|newTag)$/,
  },
  {
    why: "env VM host",
    pattern: /^patch\[Service\/[a-z0-9-]+\]\.spec\.externalName$/,
  },
];

const IDENTITY: Record<string, Rule[]> = {
  operator: [
    ...COMMON_IDENTITY,
    ...[
      "AKASH_ACTUATOR_ACCOUNT_ID",
      "DEPLOY_ENVIRONMENT",
      "TEMPORAL_NAMESPACE",
      "FLEET_CONTROL_ENV",
      "FORK_DOMAIN_ROOT",
      "NEXTAUTH_URL",
      "NODE_MINT_OWNER",
      "NODE_TEMPLATE_OWNER",
      "NODE_SUBMODULE_PARENT_OWNER",
      "NODE_SUBMODULE_PARENT_REPO",
      "DOLTHUB_OWNER",
      "DOLTHUB_NONPROD_OWNER",
      "KNOWLEDGE_DOLTHUB_REMOTE_URL",
      "OPENBAO_NODE_SECRETS_WRITER_ROLE",
    ].map((key) => ({
      why: `identity config ${key}`,
      pattern: dataKey("node-app-config", key),
    })),
    {
      why: "env name",
      pattern: envValue("akash-tx-actuator", "actuator", "DEPLOY_ENVIRONMENT"),
    },
    {
      why: "sponsor account",
      pattern: envValue(
        "akash-tx-actuator",
        "actuator",
        "AKASH_ACTUATOR_ACCOUNT_ID"
      ),
    },
    {
      why: "env name",
      pattern: envValue("lease-log-pump", "pump", "DEPLOY_ENVIRONMENT"),
    },
    {
      why: "env name",
      pattern: envValue(
        "database-reliability-actuator",
        "actuator",
        "DEPLOY_ENVIRONMENT"
      ),
    },
    {
      why: "secret ref (OpenBao path)",
      pattern:
        /^resource\[ExternalSecret\/[a-z0-9-]+\]\.spec\.(data\[\d+\]\.remoteRef|dataFrom\[\d+\]\.extract)\.key$/,
    },
    {
      why: "secret ref (OpenBao path)",
      pattern:
        /^patch\[ExternalSecret\/[a-z0-9-]+\] replace \/spec\/data\/\d+\/remoteRef\/key$/,
    },
    {
      why: "deploy ref",
      pattern:
        /^resource\[Application\/[a-z0-9-]+\]\.spec\.source\.targetRevision$/,
    },
  ],
  "scheduler-worker": [
    ...COMMON_IDENTITY,
    ...["TEMPORAL_NAMESPACE", "DEPLOY_ENVIRONMENT", "IMAGE_DIGEST"].map(
      (key) => ({
        why: `identity config ${key}`,
        pattern: dataKey("scheduler-worker-config", key),
      })
    ),
    {
      why: "routing hosts, GENERATED per env by render-scheduler-worker-endpoints.sh",
      pattern:
        /^patch\[ConfigMap\/scheduler-worker-config\]\.data\.(COGNI_NODE_ENDPOINTS|TEMPORAL_CUSTODIED_NODE_ENDPOINTS)$/,
    },
  ],
};

interface TestPilotContext {
  rootRepository: string;
  operatorNodeId: string;
  namespace: string | undefined;
  parentOwner: string | undefined;
  parentRepo: string | undefined;
}

const TEST_PILOT_CONTEXT: TestPilotContext = {
  rootRepository: "https://github.com/cogni-test-org/cogni-monorepo.git",
  operatorNodeId: "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d",
  namespace: JSON.stringify("cogni-candidate-a"),
  parentOwner: JSON.stringify("cogni-test-org"),
  parentRepo: JSON.stringify("cogni-monorepo"),
};
const TEST_PILOT_VALUES = {
  PREVIEW_FLIGHTS_ENABLED: "true",
  PREVIEW_READY_STATE_GENERATIONS: JSON.stringify({
    "0": "5616bc5c-5c0f-4cbf-ae01-82c376897448",
    "1": "894d3a9d-465d-48a8-92fd-47373d8e53fe",
  }),
  PREVIEW_DNS_ZONE_ID: "23220356c352c5831c6af57887b11a27",
  PREVIEW_SUBSTRATE_HOST: "cogni-candidate-a.vm.cognidao.org",
};
const pilotKey = (key: string): string =>
  `patch[ConfigMap/node-app-config] add /data/${key}`;

function testPreviewPilotRules(context: TestPilotContext): Rule[] {
  if (
    Object.entries(TEST_PILOT_CONTEXT).some(
      ([key, value]) => context[key as keyof TestPilotContext] !== value
    )
  )
    return [];
  // This is explicitly candidate-only behavior, never identity or a production enablement.
  // Pair resets must update the reviewed configuration AND these prepared-generation proofs.
  return Object.entries(TEST_PILOT_VALUES).map(([key, value]) => ({
    why: `TRUSTED THROWAWAY TEST PREVIEW PILOT: ${key}; exact prepared pair configuration`,
    pattern: new RegExp(`^${esc(pilotKey(key))}$`),
    values: { candidate: JSON.stringify(value), production: undefined },
  }));
}

const operatorCandidate = overlayLeaves("candidate-a", "operator");
const pilotContext: TestPilotContext = {
  rootRepository: yaml.parse(
    readFileSync(
      path.join(
        REPO_ROOT,
        "infra/k8s/argocd/control-plane/candidate-a/candidate-a-control-plane-application.yaml"
      ),
      "utf8"
    )
  ).spec.source.repoURL,
  operatorNodeId: yaml.parse(
    readFileSync(
      path.join(REPO_ROOT, "nodes/operator/.cogni/repo-spec.yaml"),
      "utf8"
    )
  ).node_id,
  namespace: operatorCandidate.get("kustomization.namespace"),
  parentOwner: operatorCandidate.get(pilotKey("NODE_SUBMODULE_PARENT_OWNER")),
  parentRepo: operatorCandidate.get(pilotKey("NODE_SUBMODULE_PARENT_REPO")),
};

/**
 * The ONLY behavior deltas candidate-a may carry. Each is a named, reasoned decision — never a
 * pattern widened to make CI pass.
 */
const BEHAVIOR_EXCEPTIONS: Record<string, Rule[]> = {
  operator: testPreviewPilotRules(pilotContext),
  "scheduler-worker": [
    {
      why:
        "VM-CAPACITY POLICY (candidate-a serial-rollout.patch.yaml): the shared candidate control " +
        "VM has no memory headroom for a surge pod, so candidate rolls serially (maxSurge 0), " +
        "admits a new worker only after a startup memory-budget sample, and excludes ConfigMap " +
        "Reloader events so a config change and its image move atomically. This guards the " +
        "box, not the product; production's VM sizing is a separate decision.",
      pattern:
        /^patch\[(Deployment\/scheduler-worker\]\.(metadata\.annotations\.(configmap\.|secret\.)?reloader\.stakater\.com\/auto|spec\.paused|spec\.strategy\..+|spec\.template\.spec\.initContainers\[startup-memory-budget\]\..+)|ConfigMap\/scheduler-worker-config\]\.metadata\.annotations\.reloader\.stakater\.com\/ignore)$/,
    },
  ],
};

describe("candidate-a overlays differ from production only in identity (task.5270)", () => {
  for (const component of ["operator", "scheduler-worker"] as const) {
    describe(component, () => {
      const candidate = overlayLeaves("candidate-a", component);
      const production = overlayLeaves("production", component);
      const found = deltas(component);
      const rules = [...IDENTITY[component], ...BEHAVIOR_EXCEPTIONS[component]];

      it("sees the overlay (the extractor is not vacuous)", () => {
        expect(found.length).toBeGreaterThan(0);
        expect(overlayLeaves("production", component).size).toBeGreaterThan(20);
      });

      it("has no BEHAVIOR delta outside the declared identity allowlist", () => {
        const behavior = found.filter(
          (key) =>
            !rules.some((rule) => accepts(rule, key, candidate, production))
        );
        expect(
          behavior,
          "candidate-a must equal production for these keys (or, if a key is truly identity, add it to the allowlist with its reason)"
        ).toEqual([]);
      });

      it("declares no dead allowlist entry or stale exception", () => {
        const dead = deadRules(rules, found, candidate, production);
        expect(dead).toEqual([]);
      });
    });
  }

  it("limits the named TEST pilot to its exact fleet, node, paths, values and production absence", () => {
    const candidate = new Map(operatorCandidate);
    const production: Leaves = new Map();
    for (const [key, value] of Object.entries(TEST_PILOT_VALUES)) {
      candidate.set(pilotKey(key), JSON.stringify(value));
    }
    const rules = testPreviewPilotRules(TEST_PILOT_CONTEXT);
    expect(rules).toHaveLength(4);
    expect(
      deadRules(rules, leafDeltas(candidate, production), candidate, production)
    ).toEqual([]);
    for (const key of Object.keys(TEST_PILOT_CONTEXT)) {
      expect(
        testPreviewPilotRules({ ...TEST_PILOT_CONTEXT, [key]: "foreign" })
      ).toEqual([]);
    }
    for (const [key, value] of Object.entries(TEST_PILOT_VALUES)) {
      const leaf = pilotKey(key);
      const rule = rules.find((item) => item.pattern.test(leaf));
      expect(rule).toBeDefined();
      if (!rule) throw new Error("pilot rule missing");
      const wrong = new Map(candidate).set(
        leaf,
        JSON.stringify(key === "PREVIEW_FLIGHTS_ENABLED" ? "false" : "wrong")
      );
      expect(accepts(rule, leaf, wrong, production)).toBe(false);
      const partialProduction = new Map(production).set(
        leaf,
        JSON.stringify(value)
      );
      expect(
        deadRules(
          rules,
          leafDeltas(candidate, partialProduction),
          candidate,
          partialProduction
        )
      ).toHaveLength(1);
      const missing = new Map(candidate);
      missing.delete(leaf);
      expect(
        deadRules(rules, leafDeltas(missing, production), missing, production)
      ).toHaveLength(1);
      for (const other of [
        leaf.replace(" add ", " replace "),
        leaf.replace("node-app-config", "other"),
        `${leaf}_UNKNOWN`,
      ]) {
        expect(
          rules.some((item) => accepts(item, other, candidate, production))
        ).toBe(false);
      }
    }
    const copiedProduction = new Map(production);
    for (const [key, value] of Object.entries(TEST_PILOT_VALUES))
      copiedProduction.set(pilotKey(key), JSON.stringify(value));
    expect(
      deadRules(
        rules,
        leafDeltas(candidate, copiedProduction),
        candidate,
        copiedProduction
      )
    ).toHaveLength(4);
  });

  it("pins the Akash provider allowlist byte-identical across candidate-a and production", () => {
    const key = envValue(
      "akash-tx-actuator",
      "actuator",
      "AKASH_ALLOWED_PROVIDERS"
    );
    const value = (env: string): string | undefined =>
      [...overlayLeaves(env, "operator")].find(([k]) => key.test(k))?.[1];
    const production = value("production");
    expect(production).toBeDefined();
    expect(JSON.parse(production ?? '""').split(",").length).toBeGreaterThan(1);
    expect(value("candidate-a")).toBe(production);
  });
});
