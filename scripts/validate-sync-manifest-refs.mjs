#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/validate-sync-manifest-refs`
 * Purpose: Full validation of .cogni/sync-manifest.yaml — structural shape (required keys, types, patterns, uniqueness) and cross-array references (divergences[].path ∈ scope[], divergences[].repos[] ∈ artifacts[]).
 * Scope: The single CI gate for the sync-manifest contract; runs via pnpm check:docs:sync-manifest. Does NOT propagate the manifest to artifact repos — that's the project-S2 drift detector.
 * Invariants: spec.repo-sync-contract MANIFEST_IS_SSOT (structural shape) + DECLARED_DIVERGENCE (cross-refs).
 * Side-effects: IO
 * Notes: Schema-driven without ajv — the schema is small + stable, hand-rolled assertions avoid a new runtime dep.
 * Links: docs/spec/repo-sync-contract.md, .cogni/sync-manifest.schema.json
 * @public
 */

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

const MANIFEST = ".cogni/sync-manifest.yaml";
const REPO_SLUG_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

const REGEX_META = new Set([
  ".",
  "+",
  "?",
  "^",
  "$",
  "{",
  "}",
  "(",
  ")",
  "|",
  "[",
  "]",
  "\\",
]);

const globToRegex = (glob) => {
  // Minimal glob matcher: handles ** and * only. All other regex metachars
  // are escaped (including ?) so unsupported glob extensions degrade to
  // literal matching rather than silently changing semantics. Single-pass
  // walk avoids the \x00 sentinel pattern banned by biome.
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
      } else {
        out += "[^/]*";
      }
    } else if (REGEX_META.has(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`);
};

const matchesAnyScope = (path, scopeGlobs) =>
  scopeGlobs.some((g) => globToRegex(g).test(path));

const isObject = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const validateStructure = (m, errors) => {
  // Required top-level keys
  for (const key of ["schema", "hub", "artifacts", "scope", "divergences"]) {
    if (!(key in m)) errors.push(`missing required top-level key \`${key}\``);
  }
  // No extras
  const allowed = new Set([
    "schema",
    "hub",
    "artifacts",
    "scope",
    "divergences",
  ]);
  for (const key of Object.keys(m)) {
    if (!allowed.has(key)) errors.push(`unknown top-level key \`${key}\``);
  }
  // schema = 1
  if ("schema" in m && m.schema !== 1) {
    errors.push(
      `schema must be the literal number 1 (got ${JSON.stringify(m.schema)})`
    );
  }
  // hub: owner/repo
  if ("hub" in m) {
    if (typeof m.hub !== "string" || !REPO_SLUG_RE.test(m.hub)) {
      errors.push(
        `hub must be a string matching owner/repo (got ${JSON.stringify(m.hub)})`
      );
    }
  }
  // artifacts
  if ("artifacts" in m) {
    if (!Array.isArray(m.artifacts) || m.artifacts.length === 0) {
      errors.push("artifacts must be a non-empty array");
    } else {
      for (const [i, a] of m.artifacts.entries()) {
        if (!isObject(a)) {
          errors.push(`artifacts[${i}] must be an object`);
          continue;
        }
        const aKeys = new Set(Object.keys(a));
        for (const k of ["repo", "path_map"]) {
          if (!aKeys.has(k)) errors.push(`artifacts[${i}] missing \`${k}\``);
        }
        for (const k of aKeys) {
          if (k !== "repo" && k !== "path_map") {
            errors.push(`artifacts[${i}] has unknown key \`${k}\``);
          }
        }
        if (
          "repo" in a &&
          (typeof a.repo !== "string" || !REPO_SLUG_RE.test(a.repo))
        ) {
          errors.push(
            `artifacts[${i}].repo must match owner/repo (got ${JSON.stringify(a.repo)})`
          );
        }
        if ("path_map" in a && !isObject(a.path_map)) {
          errors.push(`artifacts[${i}].path_map must be an object`);
        }
      }
    }
  }
  // scope
  if ("scope" in m) {
    if (!Array.isArray(m.scope) || m.scope.length === 0) {
      errors.push("scope must be a non-empty array");
    } else {
      const seen = new Set();
      for (const [i, s] of m.scope.entries()) {
        if (typeof s !== "string" || s.length === 0) {
          errors.push(`scope[${i}] must be a non-empty string`);
        } else if (seen.has(s)) {
          errors.push(`scope[${i}] duplicate entry "${s}"`);
        } else {
          seen.add(s);
        }
      }
    }
  }
  // divergences
  if ("divergences" in m) {
    if (!Array.isArray(m.divergences)) {
      errors.push("divergences must be an array (may be empty)");
    } else {
      for (const [i, d] of m.divergences.entries()) {
        if (!isObject(d)) {
          errors.push(`divergences[${i}] must be an object`);
          continue;
        }
        const dKeys = new Set(Object.keys(d));
        for (const k of ["path", "repos", "reason"]) {
          if (!dKeys.has(k)) errors.push(`divergences[${i}] missing \`${k}\``);
        }
        for (const k of dKeys) {
          if (k !== "path" && k !== "repos" && k !== "reason") {
            errors.push(`divergences[${i}] has unknown key \`${k}\``);
          }
        }
        if (
          "path" in d &&
          (typeof d.path !== "string" || d.path.length === 0)
        ) {
          errors.push(`divergences[${i}].path must be a non-empty string`);
        }
        if (
          "reason" in d &&
          (typeof d.reason !== "string" || d.reason.length === 0)
        ) {
          errors.push(`divergences[${i}].reason must be a non-empty string`);
        }
        if ("repos" in d) {
          if (!Array.isArray(d.repos) || d.repos.length === 0) {
            errors.push(`divergences[${i}].repos must be a non-empty array`);
          } else {
            const seen = new Set();
            for (const [j, r] of d.repos.entries()) {
              if (typeof r !== "string" || !REPO_SLUG_RE.test(r)) {
                errors.push(
                  `divergences[${i}].repos[${j}] must match owner/repo (got ${JSON.stringify(r)})`
                );
              } else if (seen.has(r)) {
                errors.push(`divergences[${i}].repos[${j}] duplicate "${r}"`);
              } else {
                seen.add(r);
              }
            }
          }
        }
      }
    }
  }
};

const validateCrossRefs = (m, errors) => {
  const declaredRepos = new Set(m.artifacts.map((a) => a.repo));
  const scope = m.scope;
  for (const [i, d] of m.divergences.entries()) {
    if (!matchesAnyScope(d.path, scope)) {
      errors.push(
        `divergences[${i}].path "${d.path}" does not match any scope[] glob — declare it in scope or remove from divergences`
      );
    }
    for (const repo of d.repos) {
      if (!declaredRepos.has(repo)) {
        errors.push(
          `divergences[${i}].repos contains "${repo}" which is not declared in artifacts[]`
        );
      }
    }
  }
};

const main = () => {
  const text = readFileSync(MANIFEST, "utf8");
  const manifest = parseYaml(text);
  if (!isObject(manifest)) {
    console.error(`\n✗ ${MANIFEST}: top-level must be a YAML mapping`);
    process.exit(1);
  }
  const errors = [];
  validateStructure(manifest, errors);
  // Cross-refs only run if structure passed — otherwise they'd crash on missing fields.
  if (errors.length === 0) {
    validateCrossRefs(manifest, errors);
  }
  if (errors.length) {
    console.error(`\n✗ ${MANIFEST} validation failed:`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(`✓ ${MANIFEST} valid (structure + cross-refs)`);
};

main();
