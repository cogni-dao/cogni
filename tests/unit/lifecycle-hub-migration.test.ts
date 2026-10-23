// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/lifecycle-hub-migration`
 * Purpose: Prove the one-time lifecycle codemod fails before fleet writes and restores a failed repo.
 * Scope: Temporary filesystem fixtures, no Git/network/process operations.
 * Invariants: FLEET_PREFLIGHT, EXACT_CONTENT, IDEMPOTENT, REPO_ROLLBACK.
 * Side-effects: IO (isolated temporary directories, removed after each case).
 * Links: story.5113, scripts/migrations/lifecycle-hub-v1.mjs
 * @public
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error Deliberately test the dependency-free executable migration directly.
import {
  applyFleet,
  paths,
  planFleet,
  repositories,
  sha256,
} from "../../scripts/migrations/lifecycle-hub-v1.mjs";

const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "lifecycle-v1-"));
  temporary.push(root);
  const roots: Record<string, string> = {};
  const files: Record<string, { content: string; after: string }> = {};
  const inventory: Record<
    string,
    { sourceSha: string; before: Record<string, string> }
  > = {};
  for (const relative of paths as string[]) {
    const content = `Reviewed operator reader for ${relative}\n`;
    files[relative] = { content, after: sha256(content) };
  }
  for (const name of repositories as string[]) {
    roots[name] = path.join(root, name);
    inventory[name] = { sourceSha: "a".repeat(40), before: {} };
    for (const relative of paths as string[]) {
      const target = path.join(roots[name], relative);
      const before = `Original ${name}/${relative}\n`;
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, before);
      inventory[name].before[relative] = sha256(before);
    }
  }
  const manifest = { version: 1, files, repositories: inventory };
  const inspect = (repoRoot: string) => ({
    name: path.basename(repoRoot),
    clean: true,
    head: "b".repeat(40),
  });
  const plan = () => planFleet(roots, manifest, { inspect });
  const first = path.join(roots[repositories[0]], paths[0]);
  const last = path.join(roots[repositories.at(-1)], paths.at(-1));
  return { roots, manifest, inspect, plan, first, last };
}

describe("one-time lifecycle fleet migration", () => {
  it("dry-runs the complete fleet without changing a byte", () => {
    const f = fixture();
    const before = readFileSync(f.first, "utf8");
    const plan = f.plan();
    expect(plan).toHaveLength(6);
    expect(
      plan.every(
        (repo: { files: { changed: boolean }[] }) =>
          repo.files.length === 6 && repo.files.every((file) => file.changed)
      )
    ).toBe(true);
    expect(readFileSync(f.first, "utf8")).toBe(before);
  });

  it("rejects omitted repos, unexpected identities and dirty target files", () => {
    const f = fixture();
    const missing = { ...f.roots };
    delete missing.toks5;
    expect(() =>
      planFleet(missing, f.manifest, { inspect: f.inspect })
    ).toThrow("exactly");
    expect(() =>
      planFleet(f.roots, f.manifest, {
        inspect: () => ({ name: "unknown", clean: true }),
      })
    ).toThrow("identity");
    expect(() =>
      planFleet(f.roots, f.manifest, {
        inspect: (root: string) => ({ ...f.inspect(root), clean: false }),
      })
    ).toThrow("cleanliness");
  });

  it("a divergent last repo prevents changes to every earlier repo", () => {
    const f = fixture();
    const before = readFileSync(f.first, "utf8");
    writeFileSync(f.last, "node-local addition outside the inspected source");
    expect(() => applyFleet(f.plan())).toThrow("Unexpected content");
    expect(readFileSync(f.first, "utf8")).toBe(before);
  });

  it("revalidates every repo before applying an already prepared plan", () => {
    const f = fixture();
    const plan = f.plan();
    const before = readFileSync(f.first, "utf8");
    writeFileSync(f.last, "changed after dry-run");
    expect(() => applyFleet(plan)).toThrow("Preflight changed");
    expect(readFileSync(f.first, "utf8")).toBe(before);
  });

  it("applies once and treats an exact desired tree as an idempotent no-op", () => {
    const f = fixture();
    applyFleet(f.plan());
    const after = readFileSync(f.first, "utf8");
    const repeat = f.plan();
    expect(
      repeat.every((repo: { files: { changed: boolean }[] }) =>
        repo.files.every((file) => !file.changed)
      )
    ).toBe(true);
    applyFleet(repeat);
    expect(readFileSync(f.first, "utf8")).toBe(after);
  });

  it("restores earlier files in a repo if a later atomic replacement fails", () => {
    const f = fixture();
    const before = readFileSync(f.first, "utf8");
    let calls = 0;
    expect(() =>
      applyFleet(f.plan(), {
        rename: (from: string, to: string) => {
          calls += 1;
          if (calls === 2) throw new Error("injected rename failure");
          renameSync(from, to);
        },
      })
    ).toThrow("rolled back");
    expect(readFileSync(f.first, "utf8")).toBe(before);
    expect(
      f
        .plan()
        .every((repo: { files: { changed: boolean }[] }) =>
          repo.files.every((file) => file.changed)
        )
    ).toBe(true);
  });
});
