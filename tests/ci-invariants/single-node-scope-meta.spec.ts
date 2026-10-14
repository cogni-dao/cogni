// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/single-node-scope-meta`
 * Purpose: Pins runtime-generated single-node-scope filters and the SHA-pinned dorny action.
 * Scope: Static structural test that reads the workflow. Does NOT shell out or invoke the action.
 * Invariants: DIRECTORY_IS_SOURCE_OF_TRUTH, NO_INFRA_ENUMERATION, ACTION_PINNED_BY_SHA (see work/items/task.0381.* §Invariants).
 * Side-effects: IO (reads .github/workflows/ci.yaml)
 * Notes: The workflow is fleet-neutral; each checkout generates its own filters at runtime.
 * Links: .github/workflows/ci.yaml, docs/spec/node-ci-cd-contract.md
 * @public
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "yaml";

const REPO_ROOT = path.resolve(__dirname, "../..");
const WORKFLOW_PATH = path.join(REPO_ROOT, ".github/workflows/ci.yaml");
const SHA40 = /^[0-9a-f]{40}$/;

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
  it("derives filters at runtime from this checkout instead of committed roster state", () => {
    const job = loadJob();
    const renderStep = findStep<{ id: string; run: string }>(
      job,
      (s) => s.id === "scope_filters"
    );
    const filterStep = findStep<{ with: { filters: string } }>(
      job,
      (s) =>
        typeof s.uses === "string" && s.uses.startsWith("dorny/paths-filter@")
    );
    expect(renderStep.run).toBe(
      "bash scripts/ci/render-scope-filters.sh --github-output"
    );
    expect(filterStep.with.filters).toBe(
      "${{ steps.scope_filters.outputs.filters }}"
    );
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
        "so a legacy-node-only PR misclassifies as legacy-node + operator. " +
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
    const enforce = findStep<{ run: string }>(
      job,
      (s) => s.name === "Enforce single-domain scope"
    );
    // ARG_MAX: a ~2200-path purge diff overflows execve when operator_files
    // rides in `env:`. Both dorny outputs are spliced into the run: body
    // (changes inline, operator_files via a quoted heredoc written to disk),
    // never passed through `env:`.
    expect(enforce.run).toContain("steps.domains.outputs.changes");
    expect(enforce.run).toContain("steps.domains.outputs.operator_files");
    expect(
      enforce.run,
      "operator_files must NOT ride in env (ARG_MAX); splice it into a quoted " +
        "heredoc in the run: body instead"
    ).toContain("COGNI_OPERATOR_FILES_EOF");
    expect(
      enforce.run,
      "node-retirement exemption: a deletion-only sweep across fully-removed " +
        "nodes is a sanctioned operator-domain retirement"
    ).toContain("node retirement");
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
      "node-formation wiring whitelist must include the scheduler-worker configmap " +
        "(catalog-derived regen artifact; must mirror isNodeWiring in classify.ts)"
    ).toContain('"infra/k8s/base/scheduler-worker/configmap.yaml"');
    expect(
      enforce.run,
      "node-formation wiring whitelist must include the edge Caddyfile.tmpl " +
        "(catalog-derived regen artifact; bug.5086 parity — must mirror isNodeWiring " +
        "in classify.ts so a catalog-driven Caddyfile regen rides a node formation)"
    ).toContain('"infra/compose/edge/configs/Caddyfile.tmpl"');
    expect(
      enforce.run,
      "devtools exception must be bounded to root app Vitest configs"
    ).toContain('test("^nodes/[^/]+/app/vitest\\\\.config\\\\.mts$")');
    expect(
      enforce.run,
      "devtools exception must be bounded to the shared Vitest helper"
    ).toContain('startswith("scripts/vitest/")');
  });
});
