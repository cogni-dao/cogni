#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/ci/sync-test-parent`
 * Purpose: Refresh the `role: test-parent` mirror from canonical hub main by opening or updating exactly ONE reviewed pull request on it.
 * Scope: The hub→test-parent repair axis of spec.repo-sync-contract; does not report drift and does not ever push or force-push the mirror's main.
 * Invariants:
 *   - POLICY_HAS_ONE_READER: the target tree is computed from `lib/sync-policy.mjs` — the SAME
 *     compiled policy the detector reports against, so "what drift says" and "what sync does" can
 *     never disagree.
 *   - HUB_MAIN_IS_CANONICAL: the tree STARTS as hub main's tree. Mirror content survives only where
 *     the policy declares it (`content_may_differ`, `artifact_only`); everything else — including
 *     paths the hub DELETED — converges. Preserve-by-default is what let 2,273 retired files rot on
 *     the mirror while it sat 667 commits behind.
 *   - SYNC_IS_A_REVIEWED_PR: never pushes `main`, never force-pushes `main`. The sync branch is a
 *     merge commit parented on [mirror main, hub main], so it is a descendant of the mirror's main
 *     and the PR is conflict-free by construction (the TIER2_IS_ALWAYS_MERGEABLE shape).
 *   - BRANCH_IS_IDEMPOTENCY_KEY: one living branch, so a re-run updates the same PR instead of
 *     opening a second one.
 *   - NO_SECRET_VALUES: `infra/k8s/secrets/{production,staging}/**` is declared hub-only, so hub
 *     secret material is never written into the mirror's tree by construction, not by convention.
 * Side-effects: IO (clones the mirror into a temp dir; pushes one branch and opens or updates one PR as the operator GitHub App)
 * Notes: git does the tree work (read-tree/checkout/commit-tree) — this file only decides WHICH
 *   paths, from the manifest. No bespoke tree-building, no merge-strategy plugin.
 * Links: docs/spec/repo-sync-contract.md, .cogni/sync-manifest.yaml, scripts/ci/lib/sync-policy.mjs,
 *   scripts/ci/detect-sync-drift.mjs, .github/workflows/test-parent-sync.yml
 * @public
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileArtifactPolicy, readManifest } from "./lib/sync-policy.mjs";

const HUB_DIR = process.env.HUB_DIR ?? process.cwd();
const HUB_REF = process.env.HUB_REF ?? "HEAD";
const MANIFEST = ".cogni/sync-manifest.yaml";
const BRANCH = process.env.SYNC_BRANCH ?? "cogni-operator/hub-sync";
const DRY_RUN = process.argv.includes("--dry-run");
const TOKEN = process.env.GH_SYNC_TOKEN ?? "";

const git = (cwd, args, opts = {}) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    ...opts,
  });

const lsTree = (cwd, ref) =>
  git(cwd, ["ls-tree", "-r", "--name-only", ref]).split("\n").filter(Boolean);

/** Tree entries of type `commit` (submodule gitlinks) — `git checkout --` cannot restore these. */
const lsGitlinks = (cwd, ref) =>
  git(cwd, ["ls-tree", "-r", ref])
    .split("\n")
    .filter((l) => l.includes(" commit "))
    .map((l) => l.split("\t")[1])
    .filter(Boolean);

const api = async (path, init = {}) => {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await res.text();
  if (!res.ok)
    throw new Error(
      `${init.method ?? "GET"} ${path} → ${res.status}: ${body.slice(0, 400)}`
    );
  return body ? JSON.parse(body) : {};
};

const main = async () => {
  const manifest = readManifest(join(HUB_DIR, MANIFEST));
  const target = manifest.artifacts.find((a) => a.role === "test-parent");
  if (!target) {
    console.error(
      "no artifact declares `role: test-parent` — nothing to sync."
    );
    process.exitCode = 1;
    return;
  }
  const policy = compileArtifactPolicy(manifest, target.repo);
  const [mirrorOwner] = target.repo.split("/");
  const hubSha = git(HUB_DIR, ["rev-parse", HUB_REF]).trim();

  console.log(`hub      ${manifest.hub} @ ${hubSha}`);
  console.log(`mirror   ${target.repo} (role ${policy.role})`);

  const work = mkdtempSync(join(tmpdir(), "test-parent-sync-"));
  const clone = join(work, "mirror");
  const remote = TOKEN
    ? `https://x-access-token:${TOKEN}@github.com/${target.repo}.git`
    : `https://github.com/${target.repo}.git`;
  try {
    execFileSync("git", ["clone", "--quiet", remote, clone], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    // The hub is public — fetch it directly rather than relying on fork-network reachability, which
    // is a server-side setting, not a contract.
    git(clone, [
      "remote",
      "add",
      "hub",
      `https://github.com/${manifest.hub}.git`,
    ]);
    git(clone, ["fetch", "--quiet", "--no-tags", "hub", hubSha]);
    git(clone, ["config", "user.name", "cogni-operator"]);
    git(clone, [
      "config",
      "user.email",
      "cogni-operator@users.noreply.github.com",
    ]);

    const mirrorSha = git(clone, ["rev-parse", "origin/HEAD"]).trim();
    const mirrorFiles = lsTree(clone, mirrorSha).filter(
      (p) => !policy.excluded(p)
    );
    const hubFiles = lsTree(clone, hubSha).filter((p) => !policy.excluded(p));
    const hubSet = new Set(hubFiles);

    // HUB_MAIN_IS_CANONICAL — start from hub main's tree, then restore exactly what policy declares.
    const keepFromMirror = mirrorFiles.filter((p) => {
      if (policy.isArtifactOnlyDeclared(p)) return true; // mirror-owned (roster, pins, legacy lanes)
      if (hubSet.has(p) && policy.hubDisposition(p) === "content_free")
        return true; // identity / desired state
      return false;
    });
    const dropFromHub = hubFiles.filter(
      (p) => policy.hubDisposition(p) === "hub_only"
    );
    const gitlinks = lsGitlinks(clone, mirrorSha).filter((p) =>
      policy.isArtifactOnlyDeclared(p)
    );

    console.log(`  hub tree            ${hubFiles.length} paths`);
    console.log(
      `  restored from mirror ${keepFromMirror.length} (declared identity / roster / pins)`
    );
    console.log(`  dropped as hub-only  ${dropFromHub.length}`);
    console.log(`  gitlinks preserved   ${gitlinks.length}`);

    git(clone, ["checkout", "--quiet", "-B", BRANCH, mirrorSha]);
    // index := hub tree, worktree follows; then re-apply the declared divergences on top.
    git(clone, ["read-tree", "--reset", "-u", hubSha]);
    const applyPaths = (args, paths) => {
      for (let i = 0; i < paths.length; i += 200) {
        git(clone, [...args, "--", ...paths.slice(i, i + 200)]);
      }
    };
    if (dropFromHub.length)
      applyPaths(["rm", "-rq", "--cached", "--ignore-unmatch"], dropFromHub);
    if (keepFromMirror.length)
      applyPaths(["checkout", mirrorSha], keepFromMirror);
    for (const path of gitlinks) {
      const line = git(clone, ["ls-tree", mirrorSha, "--", path]).trim();
      const sha = line.split(/\s+/)[2];
      git(clone, [
        "update-index",
        "--add",
        "--cacheinfo",
        `160000,${sha},${path}`,
      ]);
    }

    const tree = git(clone, ["write-tree"]).trim();
    if (tree === git(clone, ["rev-parse", `${mirrorSha}^{tree}`]).trim()) {
      console.log("✅ mirror already matches policy — up_to_date, no PR.");
      return;
    }

    const message =
      `chore(sync): refresh test parent from ${manifest.hub}@${hubSha.slice(0, 8)}\n\n` +
      `Policy: .cogni/sync-manifest.yaml (default-deny divergence). Hub main is canonical for all\n` +
      `CI/CD infrastructure; ${keepFromMirror.length} declared path(s) kept at the mirror's version\n` +
      `(test identity, fixture roster + source pins, environment-specific desired state) and\n` +
      `${dropFromHub.length} declared hub-only path(s) omitted.\n`;
    // SYNC_IS_A_REVIEWED_PR — parented on the mirror's main FIRST, so the PR is a fast-forwardable
    // descendant and no reviewer ever resolves a conflict.
    const commit = git(clone, [
      "commit-tree",
      tree,
      "-p",
      mirrorSha,
      "-p",
      hubSha,
      "-m",
      message,
    ]).trim();
    git(clone, ["update-ref", `refs/heads/${BRANCH}`, commit]);

    if (DRY_RUN) {
      console.log(`--dry-run: would push ${BRANCH} → ${commit}`);
      const stat = git(
        clone,
        ["diff", "--numstat", `${mirrorSha}..${commit}`],
        {
          stdio: ["ignore", "pipe", "ignore"],
        }
      )
        .split("\n")
        .filter(Boolean);
      console.log(`  diff vs mirror main: ${stat.length} path(s) changed`);
      const planFile = process.env.SYNC_PLAN_FILE;
      if (planFile) {
        writeFileSync(
          planFile,
          git(clone, ["diff", "--name-status", `${mirrorSha}..${commit}`], {
            stdio: ["ignore", "pipe", "ignore"],
          })
        );
        console.log(`  plan written → ${planFile}`);
      }
      return;
    }
    if (!TOKEN)
      throw new Error("GH_SYNC_TOKEN is required for a non-dry-run sync");

    git(clone, [
      "push",
      "--quiet",
      "--force-with-lease",
      "origin",
      `refs/heads/${BRANCH}:refs/heads/${BRANCH}`,
    ]);

    const open = await api(
      `/repos/${target.repo}/pulls?state=open&head=${mirrorOwner}:${BRANCH}&base=main`
    );
    const body =
      `Automated refresh of this test parent from canonical \`${manifest.hub}\` main ` +
      `@ \`${hubSha}\`.\n\n` +
      `**Canonical wins by default.** The tree is hub main's tree with exactly the divergences ` +
      `declared in \`.cogni/sync-manifest.yaml\` re-applied:\n\n` +
      `- \`${keepFromMirror.length}\` path(s) kept at this repo's version — test identity, fixture ` +
      `roster + source pins, environment-specific desired state\n` +
      `- \`${dropFromHub.length}\` path(s) omitted as hub-only (incl. hub production/staging secret ` +
      `material, which never leaves the hub)\n` +
      `- \`${gitlinks.length}\` submodule pin(s) preserved\n\n` +
      `Everything else converges on canonical main — including paths the hub deleted.\n\n` +
      `Opened by \`.github/workflows/test-parent-sync.yml\` as the operator GitHub App. ` +
      `\`main\` is never pushed or force-pushed. Review and merge as normal.`;

    if (open.length > 0) {
      await api(`/repos/${target.repo}/pulls/${open[0].number}`, {
        method: "PATCH",
        body: JSON.stringify({ body }),
      });
      console.log(`✏️  updated ${open[0].html_url}`);
    } else {
      const pr = await api(`/repos/${target.repo}/pulls`, {
        method: "POST",
        body: JSON.stringify({
          title: `chore(sync): refresh test parent from ${manifest.hub}@${hubSha.slice(0, 8)}`,
          head: BRANCH,
          base: "main",
          body,
          maintainer_can_modify: false,
        }),
      });
      console.log(`🆕 opened ${pr.html_url}`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
};

await main();
