// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/repo-spec/parse`
 * Purpose: Pure parse function for .cogni/repo-spec.yaml content.
 * Scope: Accepts raw YAML string or pre-parsed object, validates with Zod, returns typed result. Does not perform I/O, caching, or side effects.
 * Invariants: REPO_SPEC_AUTHORITY — single canonical parser. Input flexibility enables local file, GitHub API, and test fixture use cases.
 * Side-effects: none
 * Links: .cogni/repo-spec.yaml, https://node-template.cognidao.org/knowledge/node-sovereignty-contract
 * @public
 */

import { parse } from "yaml";

import { type RepoSpec, repoSpecSchema } from "./schema.js";

/**
 * Parse and validate repo-spec content.
 *
 * Accepts either:
 * - A raw YAML string (e.g., from `fs.readFileSync` or GitHub API)
 * - A pre-parsed object (e.g., from `yaml.parse()` or test fixtures)
 *
 * Returns a fully validated `RepoSpec` with Zod defaults applied.
 * Throws on invalid YAML syntax or schema validation failure.
 */
export function parseRepoSpec(input: string | unknown): RepoSpec {
  let parsed: unknown;

  if (typeof input === "string") {
    try {
      parsed = parse(input);
    } catch (error) {
      throw new Error(
        `[repo-spec] Failed to parse YAML: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  } else {
    parsed = input;
  }

  const result = repoSpecSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `[repo-spec] Invalid repo-spec structure: ${result.error.message}`
    );
  }

  return result.data;
}
