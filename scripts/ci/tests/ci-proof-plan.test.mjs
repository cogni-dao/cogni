// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/ci/tests/ci-proof-plan`
 * Purpose: Exercise native-selection provenance and terminal proof gates through their CLI.
 * Scope: Disposable local Git repositories and result fixtures. Does not access Docker or network.
 * Invariants: Unknown means full; stale events never use newer-main policy; failed children stay red.
 * Side-effects: IO (temporary files and Git commits removed after each fixture).
 * Links: scripts/ci/ci-proof-plan.mjs, task.5314
 * @internal
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";

const cli = resolve("scripts/ci/ci-proof-plan.mjs");
const policy = "scripts/ci/ci-proof-plan.mjs";
const config = "scripts/vitest/vitest.native.config.mts";
const sha = "a".repeat(40);
function invoke(mode, env = {}, cwd = process.cwd()) {
  return spawnSync(process.execPath, [cli, mode], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}
function fixture(run) {
  const cwd = mkdtempSync(join(tmpdir(), "ci-proof-"));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const put = (file, content = "fixture\n") => {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), content);
  };
  const commit = () => {
    git("add", ".");
    git(
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fixture"
    );
    return git("rev-parse", "HEAD");
  };
  try {
    git("init", "-q");
    put(policy, readFileSync(cli));
    put(config);
    put("docs/old.md");
    const base = commit();
    run({
      cwd,
      git,
      put,
      commit,
      base,
      plan(head, extra = {}) {
        const result = invoke(
          "plan",
          {
            CI_EVENT: "pull_request",
            EVENT_BASE_SHA: base,
            EVENT_HEAD_SHA: head,
            EVENT_BASE_REF: "main",
            POLICY_SHA: base,
            ...extra,
          },
          cwd
        );
        assert.equal(result.status, 0, result.stderr);
        return JSON.parse(result.stdout);
      },
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("only audited app/docs diffs may skip native; non-main and full events cannot", () =>
  fixture(({ put, commit, plan }) => {
    put("nodes/operator/app/src/example.ts");
    const head = commit();
    assert.equal(plan(head).native_required, "false");
    for (const env of [
      { CI_EVENT: "merge_group" },
      { CI_EVENT: "push" },
      { EVENT_BASE_REF: "staging" },
    ])
      assert.equal(plan(head, env).native_required, "true");
  }));

test("unknown, renamed/deleted native input, new native spec and symlink require native", () => {
  for (const path of [
    "infra/input.yaml",
    "scripts/input.sh",
    "pnpm-lock.yaml",
    "packages/new/src.ts",
    "tests/ci-invariants/native/new.spec.ts",
  ])
    fixture(({ put, commit, plan }) => {
      put(path);
      assert.equal(plan(commit()).native_required, "true");
    });
  fixture(({ put, git, commit, plan }) => {
    put("infra/input");
    const input = commit();
    git("mv", "infra/input", "docs/input");
    assert.equal(
      plan(commit(), { EVENT_BASE_SHA: input, POLICY_SHA: input })
        .native_required,
      "true"
    );
  });
  fixture(({ cwd, commit, plan }) => {
    symlinkSync("old.md", join(cwd, "docs/link.md"));
    assert.equal(plan(commit()).native_required, "true");
  });
});

test("empty diff, unresolved object and incompatible config fall back to full", () =>
  fixture(({ base, put, commit, plan }) => {
    assert.equal(plan(base).native_required, "true");
    assert.equal(plan(sha).native_required, "true");
    put(config, "changed config");
    assert.equal(plan(commit()).native_required, "true");
  }));

test("event policy identity cannot drift to a newer main or a PR policy", () =>
  fixture(({ base, put, commit, plan }) => {
    put("docs/new.md");
    const head = commit();
    assert.equal(plan(head, { POLICY_SHA: head }).native_required, "true");
    assert.equal(plan(head, { POLICY_SHA: base }).native_required, "false");
  }));

const unit = {
  CLASSIFIER_RESULT: "success",
  CORE_RESULT: "success",
  SHELL_RESULT: "success",
  NATIVE_RESULT: "success",
  NATIVE_REQUIRED: "true",
  PLAN_VERSION: "1",
  POLICY_SHA: sha,
  PLAN_BASE_SHA: sha,
  PLAN_HEAD_SHA: sha,
  EVENT_BASE_SHA: sha,
  EVENT_HEAD_SHA: sha,
};
test("unit aggregate refuses failures, cancellations, unexpected skips and malformed provenance", () => {
  assert.equal(invoke("verify-unit", unit).status, 0);
  for (const key of [
    "CLASSIFIER_RESULT",
    "CORE_RESULT",
    "SHELL_RESULT",
    "NATIVE_RESULT",
  ])
    for (const result of ["failure", "cancelled", "skipped", ""])
      assert.notEqual(
        invoke("verify-unit", { ...unit, [key]: result }).status,
        0,
        `${key}=${result}`
      );
  assert.equal(
    invoke("verify-unit", {
      ...unit,
      NATIVE_REQUIRED: "false",
      NATIVE_RESULT: "skipped",
    }).status,
    0
  );
  for (const result of ["failure", "cancelled"])
    assert.notEqual(
      invoke("verify-unit", {
        ...unit,
        NATIVE_REQUIRED: "false",
        NATIVE_RESULT: result,
      }).status,
      0
    );
  for (const patch of [
    { NATIVE_REQUIRED: "" },
    { PLAN_VERSION: "" },
    { POLICY_SHA: "b".repeat(40) },
    { PLAN_HEAD_SHA: "b".repeat(40) },
  ])
    assert.notEqual(invoke("verify-unit", { ...unit, ...patch }).status, 0);
});

const manifest = {
  RESOLVE_RESULT: "success",
  DETECT_RESULT: "success",
  BUILD_RESULT: "success",
  HAS_TARGETS: "true",
  TARGETS_JSON: '["operator"]',
  SOURCE_SHA: sha,
  IMAGE_TAG: `sha-${sha}`,
};
test("manifest refuses upstream failure/cancel, missing identity and target contradictions", () => {
  assert.equal(invoke("verify-manifest", manifest).status, 0);
  assert.equal(
    invoke("verify-manifest", {
      ...manifest,
      HAS_TARGETS: "false",
      TARGETS_JSON: "[]",
      BUILD_RESULT: "skipped",
    }).status,
    0
  );
  for (const key of ["RESOLVE_RESULT", "DETECT_RESULT", "BUILD_RESULT"])
    for (const result of ["failure", "cancelled", "skipped", ""])
      assert.notEqual(
        invoke("verify-manifest", { ...manifest, [key]: result }).status,
        0,
        `${key}=${result}`
      );
  for (const patch of [
    { SOURCE_SHA: "" },
    { IMAGE_TAG: "sha-other" },
    { HAS_TARGETS: "false" },
    { TARGETS_JSON: "[]" },
    { TARGETS_JSON: "garbage" },
  ])
    assert.notEqual(
      invoke("verify-manifest", { ...manifest, ...patch }).status,
      0
    );
});

test("component aggregate requires both independent proofs", () => {
  assert.equal(
    invoke("verify-component", {
      COMPONENT_RESULT: "success",
      MIGRATOR_RESULT: "success",
    }).status,
    0
  );
  for (const key of ["COMPONENT_RESULT", "MIGRATOR_RESULT"])
    for (const result of ["failure", "cancelled", "skipped", ""])
      assert.notEqual(
        invoke("verify-component", {
          COMPONENT_RESULT: "success",
          MIGRATOR_RESULT: "success",
          [key]: result,
        }).status,
        0
      );
});
