#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/run-scoped-package-build`
 * Purpose: Emit only workspace package declarations needed for local affected checks.
 * Scope: Local check orchestration only; does not build JavaScript artifacts.
 * Invariants: Changed packages always refresh declarations; missing declaration outputs are detected regardless of git diff.
 * Side-effects: IO (spawns tsc subprocesses and writes package declaration outputs)
 * Links: scripts/check-fast.sh, scripts/run-turbo-checks.sh, tsconfig.json
 * @internal
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";

const rootDir = process.cwd();
const dryRun = process.argv.includes("--dry-run");
const red = process.stderr.isTTY ? "\u001b[31m" : "";
const reset = process.stderr.isTTY ? "\u001b[0m" : "";

const currentBranch = gitStdout(["branch", "--show-current"], true).trim();
let upstreamRef = process.env.TURBO_SCM_BASE ?? "";
const headRef = process.env.TURBO_SCM_HEAD ?? "HEAD";
const explicitScope =
  Boolean(process.env.TURBO_SCM_BASE) || Boolean(process.env.TURBO_SCM_HEAD);

if (
  !upstreamRef &&
  gitOk(["show-ref", "--verify", "--quiet", "refs/remotes/origin/main"])
) {
  upstreamRef = "origin/main";
}

if (!upstreamRef) {
  upstreamRef = gitStdout(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    true
  ).trim();
}

const useAffected =
  explicitScope || (upstreamRef.length > 0 && currentBranch !== "main");

if (!useAffected) {
  const workspaceGraph = loadWorkspaceGraph();
  const targets = allBuildableWorkspaces(workspaceGraph);
  console.log("Package declaration scope: full");
  if (!dryRun) {
    runBuildTargets(targets);
    validateDeclarationOutputs(targets);
  }
  process.exit(0);
}

const scopeBase = upstreamRef;
const scopeHead = headRef;

const globalBuildInputsTouched = didTouchGlobalBuildInputs(
  scopeBase,
  scopeHead
);
if (globalBuildInputsTouched) {
  console.error(
    `${red}WARN(task.0306): global build inputs changed (${scopeBase}...${scopeHead}); refreshing all package declarations.${reset}`
  );
  const workspaceGraph = loadWorkspaceGraph();
  const targets = allBuildableWorkspaces(workspaceGraph);
  console.log(
    `Package declaration scope: full (global inputs changed: ${scopeBase}...${scopeHead})`
  );
  if (!dryRun) {
    runBuildTargets(targets);
    validateDeclarationOutputs(targets);
  }
  process.exit(0);
}

const workspaceGraph = loadWorkspaceGraph();
const changedWorkspaceNames = getChangedWorkspaceNames(
  scopeBase,
  scopeHead,
  workspaceGraph
);

const buildPlan = createBuildPlan(changedWorkspaceNames, workspaceGraph);

if (buildPlan.targets.length === 0) {
  console.log(`Package declaration scope: none (${scopeBase}...${scopeHead})`);
  console.log("All required package declarations already exist.");
  process.exit(0);
}

printBuildPlan(scopeBase, scopeHead, buildPlan);

if (dryRun) {
  process.exit(0);
}

runBuildTargets(buildPlan.targets);
validateDeclarationOutputs(buildPlan.targets);

function createBuildPlan(changedNames, workspaceGraph) {
  const affectedBuildables = uniqueWorkspaces(
    changedNames
      .map((name) => workspaceGraph.byName.get(name))
      .filter((workspace) => workspace?.buildable)
  );

  const closureBuildables = uniqueWorkspaces(
    collectLocalDependencyClosure(changedNames, workspaceGraph)
      .map((name) => workspaceGraph.byName.get(name))
      .filter((workspace) => workspace?.buildable)
  );

  const affectedBuildableNames = new Set(affectedBuildables.map((w) => w.name));
  const closureMissing = closureBuildables.filter(
    (workspace) =>
      !affectedBuildableNames.has(workspace.name) &&
      !hasDeclarationOutput(workspace)
  );

  // Always refresh any buildable workspace whose declaration output is missing,
  // even outside the changed-set closure. Catches fresh-worktree bootstrap where
  // no source changed vs upstream but no packages have ever been built locally.
  const closureMissingNames = new Set(closureMissing.map((w) => w.name));
  const orphanMissing = [...workspaceGraph.byName.values()]
    .filter((workspace) => workspace.buildable)
    .filter(
      (workspace) =>
        !affectedBuildableNames.has(workspace.name) &&
        !closureMissingNames.has(workspace.name) &&
        !hasDeclarationOutput(workspace)
    );

  const missingBootstrapDeps = sortWorkspaces(
    uniqueWorkspaces([...closureMissing, ...orphanMissing])
  );

  const targets = sortWorkspaces(
    uniqueWorkspaces([...affectedBuildables, ...missingBootstrapDeps])
  );

  return {
    affectedBuildables: sortWorkspaces(affectedBuildables),
    bootstrapDeps: missingBootstrapDeps,
    targets,
  };
}

function printBuildPlan(scopeBase, scopeHead, buildPlan) {
  console.log(
    `Package declaration scope: affected (${scopeBase}...${scopeHead})`
  );
  console.log(
    `Package declaration refreshes selected: ${buildPlan.targets.length}`
  );

  if (buildPlan.affectedBuildables.length > 0) {
    console.log(
      `Refresh changed package declarations: ${buildPlan.affectedBuildables
        .map((workspace) => workspace.name)
        .join(", ")}`
    );
  }

  if (buildPlan.bootstrapDeps.length > 0) {
    console.log(
      `Bootstrap missing declarations: ${buildPlan.bootstrapDeps
        .map((workspace) => workspace.name)
        .join(", ")}`
    );
  }
}

function runBuildTargets(targets) {
  const refs = targets.map((workspace) => {
    if (!workspace.refPath) {
      throw new Error(
        `Missing tsconfig reference for buildable workspace ${workspace.name} (${workspace.relDir})`
      );
    }

    return workspace.refPath;
  });

  runPnpm(["exec", "tsc", "-b", "--force", "--emitDeclarationOnly", ...refs]);
}

function allBuildableWorkspaces(workspaceGraph) {
  return sortWorkspaces(
    [...workspaceGraph.byName.values()].filter(
      (workspace) => workspace.buildable
    )
  );
}

function validateDeclarationOutputs(targets) {
  const missing = targets.filter(
    (workspace) => !hasDeclarationOutput(workspace)
  );

  if (missing.length > 0) {
    const details = missing
      .map(
        (workspace) =>
          `${workspace.name}: missing ${workspace.typePath ?? "types export"}`
      )
      .join("\n");

    throw new Error(`Declaration validation failed:\n${details}`);
  }
}

function loadWorkspaceGraph() {
  const tsconfig = JSON.parse(
    readFileSync(resolve(rootDir, "tsconfig.json"), "utf8")
  );
  const refByDir = new Map(
    (tsconfig.references ?? []).map((reference) => {
      const refPath = normalizeRelPath(reference.path);
      const relDir = refPath.endsWith(".json")
        ? posix.dirname(refPath)
        : refPath;
      return [relDir, refPath];
    })
  );

  const workspaces = discoverWorkspaceDirs().map((relDir) => {
    const absDir = resolve(rootDir, relDir);
    const packageJson = JSON.parse(
      readFileSync(join(absDir, "package.json"), "utf8")
    );
    const typePath = resolveTypesPath(packageJson);
    const buildable =
      hasBuildScript(packageJson) && isPrebuiltPackageDir(relDir);

    return {
      name: packageJson.name,
      relDir,
      absDir,
      packageJson,
      refPath: refByDir.get(relDir) ?? null,
      typePath,
      buildable,
      localDeps: [],
    };
  });

  const byName = new Map(
    workspaces.map((workspace) => [workspace.name, workspace])
  );
  for (const workspace of workspaces) {
    const dependencyNames = new Set([
      ...Object.keys(workspace.packageJson.dependencies ?? {}),
      ...Object.keys(workspace.packageJson.devDependencies ?? {}),
      ...Object.keys(workspace.packageJson.peerDependencies ?? {}),
      ...Object.keys(workspace.packageJson.optionalDependencies ?? {}),
    ]);

    workspace.localDeps = [...dependencyNames].filter((name) =>
      byName.has(name)
    );
  }

  return {
    byName,
    byRelDir: new Map(
      workspaces.map((workspace) => [workspace.relDir, workspace])
    ),
    relDirs: workspaces.map((workspace) => workspace.relDir),
  };
}

function discoverWorkspaceDirs() {
  return [
    ...listWorkspaceChildren("packages"),
    ...listNodeWorkspaceDirs(),
    ...listWorkspaceChildren("services"),
  ];
}

function listWorkspaceChildren(rootRelDir) {
  const absRoot = resolve(rootDir, rootRelDir);
  if (!existsSync(absRoot)) {
    return [];
  }

  return readdirSync(absRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => normalizeRelPath(join(rootRelDir, entry.name)))
    .filter((relDir) => existsSync(resolve(rootDir, relDir, "package.json")));
}

function listNodeWorkspaceDirs() {
  const nodesRoot = resolve(rootDir, "nodes");
  if (!existsSync(nodesRoot)) {
    return [];
  }

  const workspaceDirs = [];
  for (const nodeEntry of readdirSync(nodesRoot, { withFileTypes: true })) {
    if (!nodeEntry.isDirectory()) {
      continue;
    }

    const nodeRelDir = normalizeRelPath(join("nodes", nodeEntry.name));

    for (const child of ["app", "graphs"]) {
      const relDir = normalizeRelPath(join(nodeRelDir, child));
      if (existsSync(resolve(rootDir, relDir, "package.json"))) {
        workspaceDirs.push(relDir);
      }
    }

    const packagesRelDir = normalizeRelPath(join(nodeRelDir, "packages"));
    workspaceDirs.push(...listWorkspaceChildren(packagesRelDir));
  }

  return workspaceDirs;
}

function collectLocalDependencyClosure(startNames, workspaceGraph) {
  const visited = new Set();
  const stack = [...startNames];

  while (stack.length > 0) {
    const name = stack.pop();
    if (!name || visited.has(name)) {
      continue;
    }

    visited.add(name);
    const workspace = workspaceGraph.byName.get(name);
    if (!workspace) {
      continue;
    }

    for (const depName of workspace.localDeps) {
      if (!visited.has(depName)) {
        stack.push(depName);
      }
    }
  }

  return [...visited];
}

function getChangedWorkspaceNames(scopeBase, scopeHead, workspaceGraph) {
  const diffOutput = getChangedPaths(scopeBase, scopeHead);

  if (diffOutput.length === 0) {
    return [];
  }

  const matched = new Set();
  const relDirs = [...workspaceGraph.relDirs].sort(
    (left, right) => right.length - left.length
  );

  for (const rawPath of diffOutput.split("\n")) {
    const relPath = normalizeRelPath(rawPath.trim());
    if (!relPath) {
      continue;
    }

    const relDir = relDirs.find(
      (candidate) =>
        relPath === candidate || relPath.startsWith(`${candidate}/`)
    );

    if (!relDir) {
      continue;
    }

    const workspace = workspaceGraph.byRelDir.get(relDir);
    if (workspace) {
      matched.add(workspace.name);
    }
  }

  return [...matched];
}

function didTouchGlobalBuildInputs(scopeBase, scopeHead) {
  const changedPaths = getChangedPaths(scopeBase, scopeHead);
  if (changedPaths.length === 0) {
    return false;
  }

  const paths = new Set(changedPaths.split("\n").map((line) => line.trim()));
  const globalInputs = new Set([
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.json",
    "tsconfig.base.json",
    "tsconfig.app.json",
    "tsconfig.scripts.json",
  ]);

  for (const path of paths) {
    if (globalInputs.has(path)) {
      return true;
    }
  }

  return false;
}

function getChangedPaths(scopeBase, scopeHead) {
  const paths = new Set();
  const outputs = [
    gitStdout(["diff", "--name-only", `${scopeBase}...${scopeHead}`], false),
    gitStdout(["diff", "--name-only"], true),
    gitStdout(["diff", "--cached", "--name-only"], true),
    gitStdout(["ls-files", "--others", "--exclude-standard"], true),
  ];

  for (const output of outputs) {
    for (const line of output.replace(/\r\n/g, "\n").split("\n")) {
      const path = normalizeRelPath(line.trim());
      if (path) {
        paths.add(path);
      }
    }
  }

  return [...paths].sort().join("\n");
}

function resolveTypesPath(packageJson) {
  const dotExport = packageJson.exports?.["."];
  if (typeof dotExport === "object" && dotExport?.types) {
    return dotExport.types;
  }

  return typeof packageJson.types === "string" ? packageJson.types : null;
}

function hasDeclarationOutput(workspace) {
  if (!workspace.typePath) {
    return false;
  }

  return existsSync(join(workspace.absDir, workspace.typePath));
}

function hasBuildScript(packageJson) {
  return typeof packageJson.scripts?.build === "string";
}

function isPrebuiltPackageDir(relDir) {
  return (
    /^packages\/[^/]+$/.test(relDir) ||
    /^nodes\/[^/]+\/packages\/[^/]+$/.test(relDir)
  );
}

function sortWorkspaces(workspaces) {
  return [...workspaces].sort((left, right) =>
    left.relDir.localeCompare(right.relDir)
  );
}

function uniqueWorkspaces(workspaces) {
  const byName = new Map();
  for (const workspace of workspaces) {
    if (workspace) {
      byName.set(workspace.name, workspace);
    }
  }
  return [...byName.values()];
}

function normalizeRelPath(filePath) {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

function gitStdout(args, allowFailure = false) {
  try {
    return execFileSync("git", args, {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (allowFailure) {
      return "";
    }
    throw error;
  }
}

function gitOk(args) {
  try {
    execFileSync("git", args, {
      cwd: rootDir,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function runPnpm(args) {
  execFileSync("pnpm", args, {
    cwd: rootDir,
    env: process.env,
    stdio: "inherit",
  });
}
