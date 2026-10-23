#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/migrations/lifecycle-hub-v1`
 * Purpose: Convert six inspected node command families to reviewed hub readers once.
 * Scope: Exact manifest paths in six explicitly supplied local repositories; no network or Git writes.
 * Invariants: FLEET_PREFLIGHT, EXACT_CONTENT, NODE_CREDENTIAL_ISOLATION, IDEMPOTENT, REPO_ROLLBACK.
 * Side-effects: IO (reads local Git metadata/files; --apply atomically replaces each file with per-repo rollback).
 * Links: story.5113, task.5321, https://cognidao.org/knowledge/migrate-node-trees-safely
 * @public
 */

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
export const repositories = [
  "node-template",
  "poly",
  "beacon",
  "levelup",
  "red",
  "toks5",
];
export const paths = [
  "design",
  "review-design",
  "implement",
  "review-implementation",
  "closeout",
  "contribute-to-cogni",
].map((command) => `.claude/commands/${command}.md`);
export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

function inspectRepository(root) {
  const git = (...args) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  if (
    git("rev-parse", "--is-inside-work-tree") !== "true" ||
    realpathSync(git("rev-parse", "--show-toplevel")) !== root
  )
    throw new Error(`Expected actual Git worktree root: ${root}`);
  const origin = git("remote", "get-url", "origin");
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:)cogni-dao\/([^/]+?)(?:\.git)?$/i.exec(
      origin
    );
  if (!match) throw new Error(`Unsupported repository origin: ${origin}`);
  const status = git("status", "--porcelain", "--", ...paths);
  return {
    name: match[1],
    origin,
    status,
    clean: status === "",
    head: git("rev-parse", "HEAD"),
  };
}

function sameMembers(actual, expected) {
  return (
    actual.length === expected.length &&
    expected.every((value) => actual.includes(value))
  );
}

/** Preflight the complete declared fleet before returning any writable plan. */
export function planFleet(roots, manifest, options = {}) {
  const inspect = options.inspect ?? inspectRepository;
  const templates = options.sourceRoot ?? sourceRoot;
  if (
    manifest.version !== 1 ||
    !sameMembers(Object.keys(roots), repositories) ||
    !sameMembers(Object.keys(manifest.repositories), repositories) ||
    !sameMembers(Object.keys(manifest.files), paths)
  )
    throw new Error(
      "Expected exactly the version-1 six-repository, six-path fleet"
    );
  const seen = new Set();
  return repositories.map((name) => {
    const root = realpathSync(roots[name]);
    if (seen.has(root))
      throw new Error(`Duplicate repository checkout: ${root}`);
    seen.add(root);
    const repo = inspect(root);
    if (repo.name !== name)
      throw new Error(`Repository identity failed: ${name}`);
    const expected = manifest.repositories[name];
    if (!sameMembers(Object.keys(expected.before), paths))
      throw new Error(`Invalid path inventory: ${name}`);
    const files = paths.map((relative) => {
      const target = path.join(root, relative);
      if (!lstatSync(target).isFile() || realpathSync(target) !== target)
        throw new Error(`Unsafe target path: ${name}/${relative}`);
      const rule = manifest.files[relative];
      const after =
        rule.content ??
        readFileSync(path.join(templates, relative), "utf8").replaceAll(
          "COGNI_NODE_API_KEY",
          "COGNI_OPERATOR_API_KEY"
        );
      if (sha256(after) !== rule.after)
        throw new Error(`Output template drift: ${relative}`);
      const before = readFileSync(target);
      const beforeHash = sha256(before);
      if (beforeHash !== expected.before[relative] && beforeHash !== rule.after)
        throw new Error(`Unexpected content: ${name}/${relative}`);
      return {
        relative,
        target,
        before,
        after,
        beforeHash,
        afterHash: rule.after,
        changed: beforeHash !== rule.after,
      };
    });
    if (!repo.clean && files.some((file) => file.changed))
      throw new Error(`Target cleanliness failed: ${name}`);
    return {
      name,
      root,
      head: repo.head,
      origin: repo.origin,
      status: repo.status,
      sourceSha: expected.sourceSha,
      files,
    };
  });
}

/** Revalidate the whole plan, then replace files with rollback within each repository. */
export function applyFleet(plan, options = {}) {
  const rename = options.rename ?? renameSync;
  const verifyRepository = (repo) => {
    try {
      if (realpathSync(repo.root) !== repo.root)
        throw new Error("Repository root changed");
      const current = inspectRepository(repo.root);
      if (
        current.name !== repo.name ||
        current.origin !== repo.origin ||
        current.head !== repo.head ||
        current.status !== repo.status
      )
        throw new Error("Repository identity, HEAD or target status changed");
    } catch (error) {
      throw new Error(
        `Repository preflight changed before apply: ${repo.name}`,
        {
          cause: error,
        }
      );
    }
  };
  const verify = (repo, file) => {
    if (
      !lstatSync(file.target).isFile() ||
      realpathSync(file.target) !== file.target ||
      sha256(readFileSync(file.target)) !== file.beforeHash
    )
      throw new Error(
        `Preflight changed before apply: ${repo.name}/${file.relative}`
      );
  };
  for (const repo of plan) {
    verifyRepository(repo);
    for (const file of repo.files) verify(repo, file);
  }
  for (const repo of plan) {
    verifyRepository(repo);
    for (const file of repo.files) verify(repo, file);
    const changed = repo.files.filter((file) => file.changed);
    const staged = [];
    const replaced = [];
    try {
      for (const file of changed) {
        verify(repo, file);
        const temporary = `${file.target}.lifecycle-v1-${randomUUID()}`;
        staged.push(temporary);
        writeFileSync(temporary, file.after, {
          flag: "wx",
          mode: lstatSync(file.target).mode,
        });
        chmodSync(temporary, lstatSync(file.target).mode);
        rename(temporary, file.target);
        replaced.push(file);
      }
    } catch (error) {
      const failures = [error];
      for (const file of replaced.reverse()) {
        const temporary = `${file.target}.lifecycle-v1-${randomUUID()}`;
        staged.push(temporary);
        try {
          writeFileSync(temporary, file.before, {
            flag: "wx",
            mode: lstatSync(file.target).mode,
          });
          chmodSync(temporary, lstatSync(file.target).mode);
          rename(temporary, file.target);
        } catch (rollbackError) {
          failures.push(rollbackError);
        }
      }
      throw new AggregateError(
        failures,
        `Repository migration rolled back: ${repo.name}`
      );
    } finally {
      for (const temporary of staged) rmSync(temporary, { force: true });
    }
  }
}

export function report(plan) {
  return {
    version: 1,
    repositories: plan.map(({ name, head, sourceSha, files }) => ({
      name,
      head,
      sourceSha,
      files: files.map(({ relative, beforeHash, afterHash, changed }) => ({
        path: relative,
        before: beforeHash,
        after: afterHash,
        changed,
      })),
    })),
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const args = process.argv.slice(2);
    const apply = args[0] === "--apply";
    if (apply) args.shift();
    if (args.length !== 1)
      throw new Error(
        "Usage: lifecycle-hub-v1.mjs [--apply] <JSON map of all six repo names to local roots>"
      );
    const roots = JSON.parse(readFileSync(args[0], "utf8"));
    const manifest = JSON.parse(
      readFileSync(
        path.join(sourceRoot, "scripts/migrations/lifecycle-hub-v1.json"),
        "utf8"
      )
    );
    const plan = planFleet(roots, manifest);
    process.stdout.write(
      `${JSON.stringify({ mode: apply ? "apply" : "dry-run", ...report(plan) }, null, 2)}\n`
    );
    if (apply) applyFleet(plan);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
