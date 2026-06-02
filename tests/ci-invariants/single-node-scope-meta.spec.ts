// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/single-node-scope-meta`
 * Purpose: Pins the `single-node-scope` job in `.github/workflows/ci.yaml` to the `nodes/*`
 *          directory listing, and asserts `dorny/paths-filter` is SHA-pinned.
 * Scope: Static structural test that reads two files. Does NOT shell out to git or invoke the action.
 * Invariants: DIRECTORY_IS_SOURCE_OF_TRUTH, NO_INFRA_ENUMERATION, ACTION_PINNED_BY_SHA (see work/items/task.0381.* §Invariants).
 * Side-effects: IO (reads .github/workflows/ci.yaml and nodes/ listing)
 * Notes: Adding `nodes/<X>/` and forgetting to update the workflow filters
 *        causes this test to fail with an actionable message.
 * Links: .github/workflows/ci.yaml, docs/spec/node-ci-cd-contract.md
 * @public
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "yaml";

const REPO_ROOT = path.resolve(__dirname, "../..");
const WORKFLOW_PATH = path.join(REPO_ROOT, ".github/workflows/ci.yaml");
const NODES_DIR = path.join(REPO_ROOT, "nodes");
const OPERATOR_NODE = "operator";
const SHA40 = /^[0-9a-f]{40}$/;

function listNonOperatorNodes(): string[] {
  return readdirSync(NODES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== OPERATOR_NODE)
    .map((d) => d.name)
    .sort();
}

function loadJob() {
  const doc = yaml.parse(readFileSync(WORKFLOW_PATH, "utf8")) as {
    jobs: Record<string, { steps: Array<Record<string, unknown>> }>;
  };
  const job = doc.jobs["single-node-scope"];
  expect(job, "single-node-scope job must exist in ci.yaml").toBeDefined();
  return job;
}

function findStep<T extends Record<string, unknown>>(
  job: { steps: Array<Record<string, unknown>> },
  predicate: (s: Record<string, unknown>) => boolean
): T {
  const step = job.steps.find(predicate);
  expect(step, "expected step not found").toBeDefined();
  return step as T;
}

describe("single-node-scope workflow gate · structural pins", () => {
  it("filter list matches `nodes/*` directory listing minus operator", () => {
    const job = loadJob();
    const filterStep = findStep<{ with: { filters: string } }>(
      job,
      (s) =>
        typeof s.uses === "string" && s.uses.startsWith("dorny/paths-filter@")
    );
    const filters = yaml.parse(filterStep.with.filters) as Record<
      string,
      unknown
    >;

    const nonOperatorFilters = Object.keys(filters)
      .filter((k) => k !== OPERATOR_NODE)
      .sort();
    const expected = listNonOperatorNodes();

    expect(
      nonOperatorFilters,
      `Workflow filter list must equal nodes/* minus operator. ` +
        `Got [${nonOperatorFilters.join(", ")}], expected [${expected.join(", ")}]. ` +
        `Add or remove the matching filter (and update the operator negation list) ` +
        `in .github/workflows/ci.yaml.`
    ).toEqual(expected);
  });

  it("filter block is wrapped in render-scope-filters.sh GENERATED sentinels (CATALOG_IS_SSOT)", () => {
    const raw = readFileSync(WORKFLOW_PATH, "utf8");
    expect(
      raw,
      "filter block must be wrapped in the render-scope-filters.sh BEGIN sentinel " +
        "so the dorny filters stay catalog-derived (no hand-listed `<slug>:` filters). " +
        "Run `pnpm gen:scope-filters`."
    ).toContain(
      "# >>> GENERATED scope-filters (scripts/ci/render-scope-filters.sh) — DO NOT EDIT BY HAND"
    );
    expect(
      raw,
      "filter block must close with the GENERATED end sentinel"
    ).toContain("# <<< GENERATED scope-filters");
  });

  it("operator filter is `**` plus negations of every other filter (no positive infra paths)", () => {
    const job = loadJob();
    const filterStep = findStep<{ with: { filters: string } }>(
      job,
      (s) =>
        typeof s.uses === "string" && s.uses.startsWith("dorny/paths-filter@")
    );
    const filters = yaml.parse(filterStep.with.filters) as Record<
      string,
      string[]
    >;
    const operator = filters[OPERATOR_NODE];

    expect(operator, "operator filter must exist").toBeDefined();
    expect(operator[0], "operator filter must start with '**'").toBe("**");

    const negations = operator.slice(1);
    for (const pattern of negations) {
      expect(
        pattern.startsWith("!"),
        `operator filter entry "${pattern}" must be a negation. ` +
          `Adding positive infra paths to operator is forbidden ` +
          `(NO_INFRA_ENUMERATION) — operator owns "everything not under another node".`
      ).toBe(true);
    }

    const negatedNodes = negations
      .map((p) => p.replace(/^!nodes\//, "").replace(/\/\*\*$/, ""))
      .sort();
    const expected = listNonOperatorNodes();
    expect(
      negatedNodes,
      `operator filter negations must exactly cover every other-node filter. ` +
        `Got [${negatedNodes.join(", ")}], expected [${expected.join(", ")}].`
    ).toEqual(expected);
  });

  it("`dorny/paths-filter` uses `predicate-quantifier: every` so operator negations subtract", () => {
    const job = loadJob();
    const filterStep = findStep<{
      with: { "predicate-quantifier"?: string };
    }>(
      job,
      (s) =>
        typeof s.uses === "string" && s.uses.startsWith("dorny/paths-filter@")
    );
    expect(
      filterStep.with["predicate-quantifier"],
      "operator filter relies on `**` + `!nodes/<X>/**` to mean " +
        "\"everywhere outside another node's dir\". With dorny's default " +
        "`some` quantifier the rules are OR'd and the negations are dead, " +
        "so a poly-only PR misclassifies as poly + operator. " +
        "Set `predicate-quantifier: every` on the dorny step."
    ).toBe("every");
  });

  it("`dorny/paths-filter` is pinned by full 40-char SHA, not by tag", () => {
    const job = loadJob();
    const step = findStep<{ uses: string }>(
      job,
      (s) =>
        typeof s.uses === "string" && s.uses.startsWith("dorny/paths-filter@")
    );
    const ref = step.uses.split("@")[1].split(/\s/)[0];
    expect(
      SHA40.test(ref),
      `dorny/paths-filter must be pinned by full commit SHA (got "${ref}"). ` +
        `Tag pins like @v3 are forbidden (ACTION_PINNED_BY_SHA).`
    ).toBe(true);
  });

  it("enforce step uses `dorny/paths-filter` outputs (changes + operator_files) inline", () => {
    const job = loadJob();
    const enforce = findStep<{ env: Record<string, string>; run: string }>(
      job,
      (s) => s.name === "Enforce single-domain scope"
    );
    expect(enforce.env.MATCHED).toContain("steps.domains.outputs.changes");
    expect(enforce.env.OPERATOR_FILES).toContain(
      "steps.domains.outputs.operator_files"
    );
    expect(
      enforce.run,
      "ride-along whitelist must include pnpm-lock.yaml in the inline run: block"
    ).toContain("pnpm-lock.yaml");
    expect(
      enforce.run,
      "ride-along whitelist must include work/ prefix in the inline run: block " +
        "(must mirror RIDE_ALONG_PATTERNS in tests/ci-invariants/classify.ts)"
    ).toContain('startswith("work/")');
    expect(
      enforce.run,
      "ride-along whitelist must include docs/ prefix in the inline run: block " +
        "(must mirror RIDE_ALONG_PATTERNS in tests/ci-invariants/classify.ts)"
    ).toContain('startswith("docs/")');
    expect(
      enforce.run,
      "ride-along whitelist must include the .claude/skills/ prefix " +
        "(must mirror RIDE_ALONG_PATTERNS in tests/ci-invariants/classify.ts)"
    ).toContain('startswith(".claude/skills/")');
    expect(
      enforce.run,
      "ride-along whitelist must include the exact CI workflow path " +
        "(must mirror RIDE_ALONG_PATTERNS in tests/ci-invariants/classify.ts)"
    ).toContain('".github/workflows/ci.yaml"');
    expect(
      enforce.run,
      "ride-along whitelist must include the single-node-scope fixture prefix " +
        "(must mirror RIDE_ALONG_PATTERNS in tests/ci-invariants/classify.ts)"
    ).toContain(
      'startswith("tests/ci-invariants/fixtures/single-node-scope/")'
    );
    expect(
      enforce.run,
      "node-birth wiring whitelist must include the scheduler-worker configmap " +
        "(catalog-derived regen artifact; must mirror isNodeWiring in classify.ts)"
    ).toContain('"infra/k8s/base/scheduler-worker/configmap.yaml"');
    expect(
      enforce.run,
      "node-birth wiring whitelist must include the edge Caddyfile.tmpl " +
        "(catalog-derived regen artifact; bug.5086 parity — must mirror isNodeWiring " +
        "in classify.ts so a catalog-driven Caddyfile regen rides a node birth)"
    ).toContain('"infra/compose/edge/configs/Caddyfile.tmpl"');
  });
});
