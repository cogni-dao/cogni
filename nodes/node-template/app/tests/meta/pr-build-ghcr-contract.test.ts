// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/meta/pr-build-ghcr-contract`
 * Purpose: Pins the node-at-root GHCR publish contract inherited by minted node repos.
 * Scope: Static workflow contract only; no GitHub or registry calls.
 * Invariants: NODE_REPO_SELF_PUBLISH — node repos publish ghcr.io/<owner>/<repo>:sha-<sourceSha>
 *   using their repo-scoped GITHUB_TOKEN, not a shared deploy PAT.
 * Side-effects: IO (reads the projected node-template workflow).
 * Links: docs/spec/node-ci-cd-contract.md, nodes/node-template/.github/workflows/pr-build.yml
 * @public
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const WORKFLOW_PATH = join(
  TEST_DIR,
  "..",
  "..",
  "..",
  ".github/workflows/pr-build.yml"
);
const ACTION_EXPR_OPEN = "$" + "{{";
const SHELL_VAR_OPEN = "$" + "{";
const GITHUB_ACTOR_EXPR = `${ACTION_EXPR_OPEN} github.actor }}`;
const GITHUB_TOKEN_EXPR = `${ACTION_EXPR_OPEN} secrets.GITHUB_TOKEN }}`;
const SHOULD_PUSH_EXPR = `${ACTION_EXPR_OPEN} steps.source.outputs.should_push == 'true' }}`;
const IMAGE_TAG_EXPR = `${ACTION_EXPR_OPEN} steps.source.outputs.image_name }}:${ACTION_EXPR_OPEN} steps.source.outputs.image_tag }}`;
const GITHUB_REPOSITORY_EXPR = `${ACTION_EXPR_OPEN} github.repository }}`;
const SOURCE_SHA_EXPR = `${ACTION_EXPR_OPEN} steps.source.outputs.source_sha }}`;

function asRecord(value: unknown, label: string): Record<string, unknown> {
  expect(value, `${label} must be an object`).toEqual(expect.any(Object));
  expect(Array.isArray(value), `${label} must not be an array`).toBe(false);
  return value as Record<string, unknown>;
}

function asString(value: unknown, label: string): string {
  expect(typeof value, `${label} must be a string`).toBe("string");
  return value as string;
}

function workflowText(): string {
  return readFileSync(WORKFLOW_PATH, "utf8");
}

function workflow(): Record<string, unknown> {
  return asRecord(parseYaml(workflowText()), "workflow");
}

function workflowStep(name: string): Record<string, unknown> {
  const jobs = asRecord(workflow().jobs, "jobs");
  const build = asRecord(jobs.build, "jobs.build");
  const steps = build.steps;
  expect(Array.isArray(steps), "jobs.build.steps must be an array").toBe(true);

  const step = (steps as unknown[]).find((candidate) => {
    const record = asRecord(candidate, "workflow step");
    return record.name === name;
  });

  expect(step, `workflow step "${name}" must exist`).toBeDefined();
  return asRecord(step, `workflow step "${name}"`);
}

describe("node-template PR Build GHCR contract", () => {
  it("uses repo-scoped GitHub token package write permissions", () => {
    const permissions = asRecord(workflow().permissions, "permissions");

    expect(permissions.contents).toBe("read");
    expect(permissions.packages).toBe("write");

    const loginStep = workflowStep("Login to GHCR");
    const withBlock = asRecord(loginStep.with, "Login to GHCR.with");

    expect(loginStep.uses).toBe("docker/login-action@v3");
    expect(withBlock.registry).toBe("ghcr.io");
    expect(withBlock.username).toBe(GITHUB_ACTOR_EXPR);
    expect(withBlock.password).toBe(GITHUB_TOKEN_EXPR);
    expect(workflowText()).not.toMatch(/GHCR_DEPLOY|PAT|write:packages/);
  });

  it("publishes a source-addressed image in the workflow repository namespace", () => {
    const resolveStep = workflowStep("Resolve source metadata");
    const resolveScript = asString(
      resolveStep.run,
      "Resolve source metadata.run"
    );

    expect(resolveScript).toContain('owner_lc="$(printf');
    expect(resolveScript).toContain('repo_lc="$(printf');
    expect(resolveScript).toContain(
      `echo "image_name=ghcr.io/${SHELL_VAR_OPEN}owner_lc}/${SHELL_VAR_OPEN}repo_lc}"`
    );
    expect(resolveScript).toContain(
      `echo "image_tag=sha-${SHELL_VAR_OPEN}source_sha}"`
    );
    expect(resolveScript).toContain("should_push=false");

    const buildStep = workflowStep("Build app image");
    const withBlock = asRecord(buildStep.with, "Build app image.with");
    const labels = asString(withBlock.labels, "Build app image.with.labels");

    expect(withBlock.push).toBe(SHOULD_PUSH_EXPR);
    expect(withBlock.tags).toBe(IMAGE_TAG_EXPR);
    expect(labels).toContain(
      `org.opencontainers.image.source=https://github.com/${GITHUB_REPOSITORY_EXPR}`
    );
    expect(labels).toContain(
      `org.opencontainers.image.revision=${SOURCE_SHA_EXPR}`
    );
  });
});
