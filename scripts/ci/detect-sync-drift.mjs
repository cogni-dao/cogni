#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/ci/detect-sync-drift`
 * Purpose: Walks every hub file not covered by global exclude or per-artifact divergence; sha256-diffs each against a fresh clone of each public artifact; emits a markdown report grouped by drift class (different / missing-on-artifact / only-on-artifact).
 * Scope: Implements spec.repo-sync-contract S2 (drift surfacing). Forward + backflow detection; does NOT open auto-PRs on artifacts — that is v0.2.
 * Invariants: Skips private artifacts (visibility=private) until v0.2 PAT plumbing lands; never mutates the hub or artifact working trees.
 * Side-effects: IO (clones into /tmp/sync-drift-<repo>, reads hub via git show); prints markdown to stdout; exit 0 always (drift is data, not failure).
 * Notes: Drives the sync-drift-detector.yml workflow which pipes stdout into `gh issue create` / `gh issue edit` for the hub tracking issue.
 * Links: docs/spec/repo-sync-contract.md, .cogni/sync-manifest.yaml, .github/workflows/sync-drift-detector.yml
 * @public
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const HUB_DIR = process.env.HUB_DIR ?? process.cwd();
const HUB_REF = process.env.HUB_REF ?? "HEAD";
const TMP_ROOT = "/tmp";
const MANIFEST = ".cogni/sync-manifest.yaml";

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

const compileGlobs = (globs) => (globs ?? []).map(globToRegex);
const matchesAny = (path, regexes) => regexes.some((re) => re.test(path));

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

const cloneArtifact = (repo, dest) => {
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  execSync(
    `git clone --depth 1 --quiet https://github.com/${repo}.git ${dest}`,
    {
      stdio: ["ignore", "pipe", "inherit"],
    }
  );
};

const lsFiles = (dir, ref = "HEAD") =>
  execSync(`git -C "${dir}" ls-tree -r --name-only ${ref}`, {
    encoding: "utf8",
  })
    .split("\n")
    .filter((p) => p.length > 0);

const main = () => {
  const manifest = parseYaml(readFileSync(join(HUB_DIR, MANIFEST), "utf8"));
  const excludeRes = compileGlobs(manifest.exclude);

  const hubFiles = lsFiles(HUB_DIR, HUB_REF).filter(
    (p) => !matchesAny(p, excludeRes)
  );

  const lines = [];
  const out = (s) => lines.push(s);
  out(`# Sync-drift detector report`);
  out(`hub: ${manifest.hub} @ ${HUB_REF}`);
  out(`hub files in scope (after global excludes): ${hubFiles.length}`);
  out("");

  let totalReal = 0;

  for (const artifactSpec of manifest.artifacts) {
    const { repo, visibility } = artifactSpec;
    out(`## ${repo}  (\`${visibility}\`)`);

    if (visibility === "private") {
      out(
        `  ⏭️  skipped — visibility=private, v0.1 detector has no PAT plumbing yet.`
      );
      out("");
      continue;
    }

    const divergence =
      manifest.divergences.find((d) => d.artifact === repo) ?? {};
    const omitRes = compileGlobs(divergence.omit_from_artifact);
    const onlyRes = compileGlobs(divergence.artifact_only);

    const dest = join(TMP_ROOT, `sync-drift-${repo.replace("/", "_")}`);
    try {
      cloneArtifact(repo, dest);
    } catch (e) {
      out(`  ❌ clone failed: ${e.message.split("\n")[0]}`);
      out("");
      continue;
    }

    const artifactFiles = lsFiles(dest)
      .filter((p) => !matchesAny(p, excludeRes))
      .filter((p) => !matchesAny(p, onlyRes));

    const artifactSet = new Set(artifactFiles);
    const missing = [];
    const different = [];

    for (const path of hubFiles) {
      if (matchesAny(path, omitRes)) continue;
      if (!artifactSet.has(path)) {
        const fsPath = join(dest, path);
        // If it exists on disk as a non-file (dir/symlink) report as missing
        if (!existsSync(fsPath) || !statSync(fsPath).isFile()) {
          missing.push(path);
        }
        continue;
      }
      let hubBlob;
      try {
        hubBlob = execSync(`git -C "${HUB_DIR}" show ${HUB_REF}:"${path}"`, {
          encoding: "buffer",
          maxBuffer: 50 * 1024 * 1024,
          stdio: ["ignore", "pipe", "ignore"],
        });
      } catch {
        continue; // submodule/symlink-as-tree-entry
      }
      const fsPath = join(dest, path);
      if (!statSync(fsPath).isFile()) {
        missing.push(path);
        continue;
      }
      const artifactBlob = readFileSync(fsPath);
      if (sha256(hubBlob) !== sha256(artifactBlob)) {
        different.push({
          path,
          hubSize: hubBlob.length,
          artifactSize: artifactBlob.length,
        });
      }
    }

    const hubSet = new Set(hubFiles.filter((p) => !matchesAny(p, omitRes)));
    const onlyOnArtifact = artifactFiles.filter((p) => !hubSet.has(p));

    const realDriftCount =
      different.length + missing.length + onlyOnArtifact.length;
    totalReal += realDriftCount;

    out(`  matching: ${hubFiles.length - missing.length - different.length}`);
    out(`  🟡 different: ${different.length}`);
    out(`  🔴 missing-on-artifact: ${missing.length}`);
    out(`  🟣 only-on-artifact (backflow): ${onlyOnArtifact.length}`);
    out("");

    if (different.length > 0) {
      out(`  <details><summary>🟡 ${different.length} different</summary>`);
      out("");
      for (const d of different)
        out(
          `  - \`${d.path}\` — hub ${d.hubSize}B / artifact ${d.artifactSize}B`
        );
      out("");
      out(`  </details>`);
    }
    if (missing.length > 0) {
      out(
        `  <details><summary>🔴 ${missing.length} missing-on-artifact</summary>`
      );
      out("");
      for (const m of missing) out(`  - \`${m}\``);
      out("");
      out(`  </details>`);
    }
    if (onlyOnArtifact.length > 0) {
      out(
        `  <details><summary>🟣 ${onlyOnArtifact.length} only-on-artifact (backflow candidates)</summary>`
      );
      out("");
      for (const o of onlyOnArtifact) out(`  - \`${o}\``);
      out("");
      out(`  </details>`);
    }
    out("");
  }

  out(`## Total drift across all checked artifacts: **${totalReal}**`);
  console.log(lines.join("\n"));
};

main();
