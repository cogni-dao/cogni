// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/review-model-served`
 * Purpose: Pin every repo-spec `review.model` to a model the shared LiteLLM proxy serves for free.
 * Scope: Static validation of committed repo-spec and LiteLLM YAML. Does not call LiteLLM or GitHub.
 * Invariants:
 *   - REVIEW_MODEL_IS_SERVED: `review.model` is a `model_name` in the production LiteLLM config.
 *     An unserved id fails every ai-rule gate as NEUTRAL "Graph execution failed" — silently,
 *     because the review check is advisory (story.5102: dead from ~PR #2050 to #2861).
 *   - REVIEW_MODEL_IS_FREE: that model is `is_free: true`. Review runs bill the system tenant,
 *     which holds no credits, so a paid model fails the preflight credit check the same way.
 * Side-effects: IO (reads committed YAML)
 * Links: story.5102, .cogni/repo-spec.yaml, infra/compose/runtime/configs/litellm.config.yaml
 * @public
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "yaml";

const ROOT = path.resolve(__dirname, "../..");
const LITELLM_CONFIG = path.join(
  ROOT,
  "infra/compose/runtime/configs/litellm.config.yaml"
);

interface LiteLlmModel {
  model_name: string;
  model_info?: { is_free?: boolean };
}

function readYaml<T>(file: string): T {
  return yaml.parse(readFileSync(file, "utf-8")) as T;
}

/** LiteLLM `model_name` → whether it is `is_free`. */
const isFreeByServedModel = new Map(
  readYaml<{ model_list: LiteLlmModel[] }>(LITELLM_CONFIG).model_list.map(
    (m) => [m.model_name, m.model_info?.is_free === true]
  )
);

function repoSpecPaths(): string[] {
  const nodeSpecs = readdirSync(path.join(ROOT, "nodes"))
    .map((node) => path.join(ROOT, "nodes", node, ".cogni/repo-spec.yaml"))
    .filter(existsSync);
  return [path.join(ROOT, ".cogni/repo-spec.yaml"), ...nodeSpecs];
}

const reviewModelPins = repoSpecPaths().flatMap((file) => {
  const model = readYaml<{ review?: { model?: string } }>(file).review?.model;
  return model ? [{ file: path.relative(ROOT, file), model }] : [];
});

describe("PR review model (story.5102)", () => {
  it("the root repo-spec pins a review model", () => {
    expect(reviewModelPins.map((c) => c.file)).toContain(
      ".cogni/repo-spec.yaml"
    );
  });

  it.each(reviewModelPins)("$file review.model $model is served and free", ({
    model,
  }) => {
    expect(
      isFreeByServedModel.has(model),
      `not a LiteLLM model_name: ${[...isFreeByServedModel.keys()].join(", ")}`
    ).toBe(true);
    expect(
      isFreeByServedModel.get(model),
      "review runs bill the unfunded system tenant"
    ).toBe(true);
  });
});
