// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/lifecycle-hub-migration`
 * Purpose: Prove the one-time lifecycle codemod fails before fleet writes and restores a failed repo.
 * Scope: Temporary filesystem and real Git fixtures. Does not access the network or start an application server.
 * Invariants: FLEET_PREFLIGHT, EXACT_CONTENT, IDEMPOTENT, REPO_ROLLBACK.
 * Side-effects: IO (isolated temporary directories, removed after each case).
 * Links: story.5113, scripts/migrations/lifecycle-hub-v1.mjs
 * @public
 */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
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
const repositoryFaults = [
  "origin",
  "origin URL",
  "HEAD",
  "target index",
  "root",
];
afterEach(() => {
  for (const root of temporary.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function git(root: string, ...args: string[]) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
  }).trim();
}

function commit(root: string, ...args: string[]) {
  git(
    root,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "fixture",
    ...args
  );
}

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
    roots[name] = path.join(realpathSync(root), name);
    inventory[name] = { sourceSha: "a".repeat(40), before: {} };
    for (const relative of paths as string[]) {
      const target = path.join(roots[name], relative);
      const before = `Original ${name}/${relative}\n`;
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, before);
      inventory[name].before[relative] = sha256(before);
    }
    git(roots[name], "init", "--quiet");
    git(
      roots[name],
      "remote",
      "add",
      "origin",
      `https://github.com/cogni-dao/${name}.git`
    );
    git(roots[name], "add", ".");
    commit(roots[name]);
  }
  const manifest = { version: 1, files, repositories: inventory };
  const inspect = (repoRoot: string) => ({
    name: path.basename(repoRoot),
    clean: true,
    head: "b".repeat(40),
  });
  const plan = () => planFleet(roots, manifest);
  const first = path.join(roots[repositories[0]], paths[0]);
  const last = path.join(roots[repositories.at(-1)], paths.at(-1));
  return { roots, manifest, inspect, plan, first, last };
}

function snapshot(roots: Record<string, string>) {
  return Object.values(roots).flatMap((root) =>
    (paths as string[]).map((relative) =>
      readFileSync(path.join(root, relative), "utf8")
    )
  );
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
    expect(() => applyFleet(plan)).toThrow(/(?:Preflight|preflight) changed/);
    expect(readFileSync(f.first, "utf8")).toBe(before);
  });

  it("rejects a late nested checkout root without touching any fleet target", () => {
    const f = fixture();
    const before = snapshot(f.roots);
    const root = f.roots.toks5;
    const nested = path.join(root, "unrelated-product-subdirectory");
    for (const relative of paths as string[]) {
      const target = path.join(nested, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(path.join(root, relative)));
    }
    git(root, "add", ".");
    commit(root);
    f.roots.toks5 = nested;
    const nestedBefore = snapshot({ nested });
    expect(() => applyFleet(f.plan())).toThrow("worktree root");
    expect(snapshot({ nested })).toEqual(nestedBefore);
    f.roots.toks5 = root;
    expect(snapshot(f.roots)).toEqual(before);
  });

  it("accepts actual linked worktree roots and a newer product HEAD at planning", () => {
    const f = fixture();
    const original = f.roots.toks5;
    const linked = `${original}-linked`;
    git(original, "worktree", "add", "--quiet", "--detach", linked);
    f.roots.toks5 = realpathSync(linked);
    writeFileSync(
      path.join(linked, "product.txt"),
      "unrelated product progress"
    );
    git(linked, "add", "product.txt");
    commit(linked);
    const plan = f.plan();
    expect(plan.at(-1).head).toBe(git(linked, "rev-parse", "HEAD"));
    expect(plan.at(-1).head).not.toBe(f.manifest.repositories.toks5.sourceSha);
    applyFleet(plan);
    expect(readFileSync(path.join(linked, paths[0]), "utf8")).toBe(
      f.manifest.files[paths[0]].content
    );
  });

  for (const fault of repositoryFaults) {
    it(`rejects late ${fault} drift with zero fleet writes`, () => {
      const f = fixture();
      const plan = f.plan();
      const before = snapshot(f.roots);
      const last = f.roots.toks5;
      if (fault === "origin") {
        git(
          last,
          "remote",
          "set-url",
          "origin",
          "https://github.com/unrelated/product.git"
        );
      } else if (fault === "origin URL") {
        git(
          last,
          "remote",
          "set-url",
          "origin",
          "git@github.com:cogni-dao/toks5.git"
        );
      } else if (fault === "root") {
        renameSync(last, `${last}-moved`);
        symlinkSync(`${last}-moved`, last, "dir");
      } else if (fault === "HEAD") {
        commit(last, "--allow-empty");
      } else {
        const target = path.join(last, paths[0]);
        const bytes = readFileSync(target);
        writeFileSync(target, "staged product-owned content");
        git(last, "add", paths[0]);
        writeFileSync(target, bytes);
      }
      let replacements = 0;
      expect(() =>
        applyFleet(plan, {
          rename: () => {
            replacements += 1;
            throw new Error("unexpected replacement");
          },
        })
      ).toThrow("Repository preflight changed");
      expect(replacements).toBe(0);
      expect(snapshot(f.roots)).toEqual(before);
    });
  }

  it("rechecks each repository after whole-fleet revalidation", () => {
    const f = fixture();
    const plan = f.plan();
    const lastBefore = readFileSync(f.last, "utf8");
    let changedOrigin = false;
    expect(() =>
      applyFleet(plan, {
        rename: (from: string, to: string) => {
          renameSync(from, to);
          if (!changedOrigin) {
            changedOrigin = true;
            git(
              f.roots.toks5,
              "remote",
              "set-url",
              "origin",
              "https://github.com/unrelated/product.git"
            );
          }
        },
      })
    ).toThrow("Repository preflight changed");
    expect(readFileSync(f.last, "utf8")).toBe(lastBefore);
  });

  it("applies once and treats an exact desired tree as an idempotent no-op", () => {
    const f = fixture();
    chmodSync(f.first, 0o664);
    applyFleet(f.plan());
    expect(lstatSync(f.first).mode & 0o777).toBe(0o664);
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
