// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `scripts/vitest/workspace-source-aliases`
 * Purpose: Resolve local workspace packages to source during Vitest runs.
 * Scope: Test/dev tooling only.
 * Invariants: Vitest tasks must not import ignored `dist` artifacts.
 * Side-effects: FS reads of workspace package manifests at config-load time.
 * @internal
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AliasOptions } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

type PackageJson = {
  name?: string;
  exports?: unknown;
};

type ExportTarget =
  | string
  | {
      development?: string;
      types?: string;
      import?: string;
      default?: string;
    };

export function workspaceSourceAliases(rootDir = repoRoot): AliasOptions {
  const exactAliases: { find: string; replacement: string }[] = [];

  for (const packageDir of discoverWorkspacePackageDirs(rootDir)) {
    const packageJson = readPackageJson(packageDir, rootDir);
    if (!packageJson.name?.startsWith("@cogni/")) {
      continue;
    }

    const packageRoot = path.resolve(rootDir, packageDir);
    const packageName = packageJson.name;
    const exported = normalizeExports(packageJson.exports);

    for (const [exportPath, target] of exported) {
      const sourceRel = sourceTargetFor(packageRoot, target);
      if (!sourceRel) {
        continue;
      }

      const specifier =
        exportPath === "."
          ? packageName
          : `${packageName}/${exportPath.replace(/^\.\//, "")}`;
      const replacement = path.resolve(packageRoot, sourceRel);

      if (specifier.includes("*")) {
        exactAliases.push(
          ...expandWildcardAliases(packageRoot, specifier, sourceRel)
        );
      } else {
        exactAliases.push({ find: specifier, replacement });
      }
    }
  }

  return exactAliases.sort(
    (left, right) => right.find.length - left.find.length
  );
}

function discoverWorkspacePackageDirs(rootDir: string): string[] {
  return [
    ...listChildren(rootDir, "packages"),
    ...listNodeWorkspaces(rootDir),
    ...listChildren(rootDir, "services"),
  ];
}

function listChildren(rootDir: string, relDir: string): string[] {
  const absDir = path.resolve(rootDir, relDir);
  if (!existsSync(absDir)) {
    return [];
  }

  return readdirSync(absDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.posix.join(relDir, entry.name))
    .filter((child) =>
      existsSync(path.resolve(rootDir, child, "package.json"))
    );
}

function listNodeWorkspaces(rootDir: string): string[] {
  const nodesRoot = path.resolve(rootDir, "nodes");
  if (!existsSync(nodesRoot)) {
    return [];
  }

  const dirs: string[] = [];
  for (const nodeEntry of readdirSync(nodesRoot, { withFileTypes: true })) {
    if (!nodeEntry.isDirectory()) {
      continue;
    }

    const nodeRel = path.posix.join("nodes", nodeEntry.name);
    for (const child of ["graphs"]) {
      const relDir = path.posix.join(nodeRel, child);
      if (existsSync(path.resolve(rootDir, relDir, "package.json"))) {
        dirs.push(relDir);
      }
    }

    dirs.push(...listChildren(rootDir, path.posix.join(nodeRel, "packages")));
  }

  return dirs;
}

function readPackageJson(packageDir: string, rootDir = repoRoot): PackageJson {
  return JSON.parse(
    readFileSync(path.resolve(rootDir, packageDir, "package.json"), "utf8")
  );
}

function normalizeExports(exportsField: unknown): [string, ExportTarget][] {
  if (!exportsField) {
    return [];
  }

  if (typeof exportsField === "string") {
    return [[".", exportsField]];
  }

  if (typeof exportsField !== "object" || Array.isArray(exportsField)) {
    return [];
  }

  return Object.entries(exportsField).filter(
    (entry): entry is [string, ExportTarget] =>
      typeof entry[1] === "string" ||
      (typeof entry[1] === "object" && entry[1] !== null)
  );
}

function sourceTargetFor(
  packageRoot: string,
  target: ExportTarget
): string | null {
  const rawTarget =
    typeof target === "string"
      ? target
      : (target.development ?? target.types ?? target.import ?? target.default);
  if (!rawTarget) {
    return null;
  }

  if (rawTarget.startsWith("./src/")) {
    return rawTarget;
  }

  if (!rawTarget.startsWith("./dist/")) {
    return null;
  }

  const withoutDist = rawTarget
    .replace(/^\.\//, "./")
    .replace(/^\.\/dist\//, "./src/")
    .replace(/\.d\.ts$/, ".ts")
    .replace(/\.js$/, ".ts");

  return resolveExistingSource(packageRoot, withoutDist);
}

function resolveExistingSource(
  packageRoot: string,
  sourceRel: string
): string | null {
  const candidates = sourceRel.endsWith(".ts")
    ? [
        sourceRel,
        sourceRel.replace(/\.ts$/, ".tsx"),
        sourceRel.replace(/\.ts$/, "/index.ts"),
        sourceRel.replace(/\.ts$/, "/index.tsx"),
      ]
    : [sourceRel];

  return (
    candidates.find((candidate) =>
      existsSync(path.resolve(packageRoot, candidate))
    ) ?? null
  );
}

function expandWildcardAliases(
  packageRoot: string,
  specifier: string,
  sourceRel: string
): { find: string; replacement: string }[] {
  const [specifierPrefix, specifierSuffix] = specifier.split("*");
  const [sourcePrefix, sourceSuffix] = sourceRel.split("*");
  if (
    specifierPrefix === undefined ||
    specifierSuffix === undefined ||
    sourcePrefix === undefined ||
    sourceSuffix === undefined
  ) {
    return [];
  }

  const sourceDir = path.resolve(packageRoot, sourcePrefix);
  if (!existsSync(sourceDir)) {
    return [];
  }

  return readdirSync(sourceDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((fileName) => fileName.endsWith(sourceSuffix))
    .map((fileName) => fileName.slice(0, -sourceSuffix.length))
    .map((wildcardValue) => ({
      find: `${specifierPrefix}${wildcardValue}${specifierSuffix}`,
      replacement: path.resolve(
        packageRoot,
        `${sourcePrefix}${wildcardValue}${sourceSuffix}`
      ),
    }));
}
