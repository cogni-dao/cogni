#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/ci/detect-sync-drift`
 * Purpose: Walks every hub path the declared policy requires an artifact to carry, sha256-diffs each against a fresh clone, and reports ancestry plus path drift grouped by class.
 * Scope: Surfacing for every declared artifact including the `role: test-parent` mirror (task.5142); does not open the refresh PR — that is scripts/ci/sync-test-parent.mjs.
 * Invariants:
 *   - POLICY_HAS_ONE_READER: every glob decision comes from `lib/sync-policy.mjs`; this file owns
 *     no matching rules of its own.
 *   - MISSING_MAY_BE_FATAL: an artifact declaring `on_missing: fail` turns an UNDECLARED
 *     missing-on-artifact path into a non-zero exit. A canonical path the hub generates and the
 *     mirror lacks is a broken generator input, not a report — that absence is what 422'd
 *     spawny-boi's env activation (`missing the current node-endpoints patch`).
 *   - REPORT_ALWAYS_PRINTS: the markdown report is emitted on stdout even when the run fails, so
 *     the tracking issue is upserted BEFORE the workflow surfaces the failure.
 *   - Skips private artifacts (visibility=private) until v0.2 PAT plumbing lands; never mutates the
 *     hub or artifact working trees.
 * Side-effects: IO (clones artifacts into /tmp and reads the hub via git; prints markdown to stdout)
 * Notes: Drives sync-drift-detector.yml, which pipes stdout into `gh issue create` / `gh issue edit`
 *   for the ONE hub tracking issue.
 * Links: docs/spec/repo-sync-contract.md, .cogni/sync-manifest.yaml, scripts/ci/lib/sync-policy.mjs,
 *   scripts/ci/sync-test-parent.mjs, .github/workflows/sync-drift-detector.yml
 * @public
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { compileArtifactPolicy, readManifest } from "./lib/sync-policy.mjs";

const HUB_DIR = process.env.HUB_DIR ?? process.cwd();
/**
 * Narrow a run to one artifact (`owner/repo`). The contract test for MISSING_MAY_BE_FATAL has to
 * re-run the detector against a single mirror; cloning every artifact to assert one is waste.
 */
const ONLY = process.env.SYNC_DRIFT_ONLY ?? "";
const HUB_REF = process.env.HUB_REF ?? "HEAD";
const TMP_ROOT = "/tmp";
const MANIFEST = ".cogni/sync-manifest.yaml";

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

/**
 * ANCESTRY, not just paths. Path drift says WHAT differs; ancestry says how far the mirror has
 * fallen behind the lineage it is supposed to track, which is the signal that decays continuously
 * between explicit changes (the test parent sat 667 commits behind before anyone noticed).
 * Unauthenticated when no token is present — every declared public artifact is a public repo.
 */
const compareAncestry = async (hub, artifact) => {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const headOwner = artifact.split("/")[0];
  const url = `https://api.github.com/repos/${artifact}/compare/${hub.replace("/", ":")}:main...${headOwner}:main`;
  try {
    const res = await fetch(url, {
      headers: {
        accept: "application/vnd.github+json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!res.ok) return { error: `compare ${res.status}` };
    const body = await res.json();
    return {
      status: body.status,
      ahead: body.ahead_by,
      behind: body.behind_by,
    };
  } catch (e) {
    // Ancestry is a reported signal, never a gate — an unreachable API must not mask path drift.
    return { error: String(e?.message ?? e) };
  }
};

const main = async () => {
  const manifest = readManifest(join(HUB_DIR, MANIFEST));

  const lines = [];
  const out = (s) => lines.push(s);
  out(`# Sync-drift detector report`);
  out(`hub: ${manifest.hub} @ ${HUB_REF}`);
  out("");

  let totalReal = 0;
  let fatal = 0;

  for (const artifactSpec of manifest.artifacts) {
    const { repo, visibility } = artifactSpec;
    if (ONLY && repo !== ONLY) continue;
    const policy = compileArtifactPolicy(manifest, repo);
    out(`## ${repo}  (\`${visibility}\`, role \`${policy.role}\`)`);

    if (visibility === "private") {
      out(
        `  ⏭️  skipped — visibility=private, v0.1 detector has no PAT plumbing yet.`
      );
      out("");
      continue;
    }

    const ancestry = await compareAncestry(manifest.hub, repo);
    out(
      ancestry.error
        ? `  🧬 ancestry: unavailable (${ancestry.error})`
        : `  🧬 ancestry vs hub main: **${ancestry.behind} behind / ${ancestry.ahead} ahead** (\`${ancestry.status}\`)`
    );

    const dest = join(TMP_ROOT, `sync-drift-${repo.replace("/", "_")}`);
    try {
      cloneArtifact(repo, dest);
    } catch (e) {
      out(`  ❌ clone failed: ${e.message.split("\n")[0]}`);
      out("");
      continue;
    }

    const hubFiles = lsFiles(HUB_DIR, HUB_REF).filter(
      (p) => !policy.excluded(p)
    );
    const artifactFiles = lsFiles(dest).filter((p) => !policy.excluded(p));
    const artifactSet = new Set(artifactFiles);

    const missing = [];
    const different = [];
    let contentFree = 0;
    let hubOnly = 0;
    let required = 0;

    for (const path of hubFiles) {
      const disposition = policy.hubDisposition(path);
      if (disposition === "hub_only") {
        hubOnly++;
        continue;
      }
      required++;
      const fsPath = join(dest, path);
      const presentAsFile =
        artifactSet.has(path) &&
        existsSync(fsPath) &&
        statSync(fsPath).isFile();
      if (!presentAsFile) {
        missing.push(path);
        continue;
      }
      if (disposition === "content_free") {
        contentFree++;
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
      const artifactBlob = readFileSync(fsPath);
      if (sha256(hubBlob) !== sha256(artifactBlob)) {
        different.push({
          path,
          hubSize: hubBlob.length,
          artifactSize: artifactBlob.length,
        });
      }
    }

    // Backflow: the hub does not require this path here, and no divergence declares it.
    const hubRequires = new Set(
      hubFiles.filter((p) => policy.hubDisposition(p) !== "hub_only")
    );
    const onlyOnArtifact = artifactFiles.filter(
      (p) => !hubRequires.has(p) && !policy.isArtifactOnlyDeclared(p)
    );

    const realDriftCount =
      different.length + missing.length + onlyOnArtifact.length;
    totalReal += realDriftCount;
    if (missing.length > 0 && policy.onMissing === "fail")
      fatal += missing.length;

    out(
      `  required by policy: ${required} (content-free: ${contentFree}) · declared hub-only: ${hubOnly}`
    );
    out(
      `  matching: ${required - missing.length - different.length - contentFree}`
    );
    out(`  🟡 different: ${different.length}`);
    out(
      `  🔴 missing-on-artifact: ${missing.length}${
        policy.onMissing === "fail" ? " ← **fatal** (`on_missing: fail`)" : ""
      }`
    );
    out(`  🟣 only-on-artifact (backflow): ${onlyOnArtifact.length}`);
    out("");

    const detail = (emoji, label, items, render) => {
      if (items.length === 0) return;
      out(`  <details><summary>${emoji} ${items.length} ${label}</summary>`);
      out("");
      for (const i of items) out(`  - ${render(i)}`);
      out("");
      out(`  </details>`);
    };
    detail(
      "🟡",
      "different",
      different,
      (d) => `\`${d.path}\` — hub ${d.hubSize}B / artifact ${d.artifactSize}B`
    );
    detail("🔴", "missing-on-artifact", missing, (m) => `\`${m}\``);
    detail(
      "🟣",
      "only-on-artifact (backflow candidates)",
      onlyOnArtifact,
      (o) => `\`${o}\``
    );
    out("");
  }

  out(`## Total drift across all checked artifacts: **${totalReal}**`);
  if (fatal > 0) {
    out("");
    out(
      `> ❌ **${fatal} required canonical path(s) are absent on an artifact declaring \`on_missing: fail\`.** ` +
        `A path the hub generates and the mirror lacks is a broken generator input — refresh the mirror ` +
        `(\`.github/workflows/test-parent-sync.yml\`) rather than declaring the absence away.`
    );
  }
  console.log(lines.join("\n"));
  if (fatal > 0) process.exitCode = 1;
};

await main();
