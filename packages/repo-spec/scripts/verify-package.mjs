#!/usr/bin/env node

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/repo-spec/scripts/verify-package`
 * Purpose: Build release evidence from the exact npm tarball and anonymous registry install.
 * Scope: Package-release CI only. Does not publish, mutate source, or use npm credentials.
 * Invariants: PACKED_ARTIFACT_IS_CONTRACT, ANONYMOUS_CONSUMER_PROOF, TESTING_SUBPATH_IS_TEST_ONLY.
 * Side-effects: Creates bounded temporary consumer directories and a requested tarball output directory.
 * Links: docs/spec/packages-architecture.md, task.5158
 * @internal
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  execPath,
  exit,
  env as processEnvironment,
  stderr,
  stdout,
} from "node:process";
import { fileURLToPath } from "node:url";

const REGISTRY = "https://registry.npmjs.org/";
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "../..");
const MANIFEST_PATH = join(PACKAGE_ROOT, "package.json");

function fail(message) {
  throw new Error(`[repo-spec-package] ${message}`);
}

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const values = new Map();
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      fail(`invalid argument sequence near ${key ?? "<end>"}`);
    }
    values.set(key.slice(2), value);
  }
  return { mode, values };
}

function readManifest(manifestPath = MANIFEST_PATH) {
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    fail(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

function validateManifest(manifest, expectedVersion) {
  assertEqual(manifest.name, "@cogni/repo-spec", "package name");
  if (expectedVersion) {
    assertEqual(manifest.version, expectedVersion, "requested version");
  }
  if (manifest.private === true) {
    fail("package remains private");
  }
  assertEqual(
    manifest.license,
    "SEE LICENSE IN LICENSE",
    "license declaration"
  );
  assertEqual(
    manifest.repository?.url,
    "git+https://github.com/Cogni-DAO/cogni.git",
    "repository URL"
  );
  assertEqual(
    manifest.repository?.directory,
    "packages/repo-spec",
    "repository directory"
  );
  assertEqual(manifest.publishConfig?.access, "public", "public access");
  assertEqual(manifest.publishConfig?.provenance, true, "provenance");
  assertEqual(manifest.publishConfig?.registry, REGISTRY, "registry");

  const files = [...(manifest.files ?? [])].sort();
  assertEqual(
    JSON.stringify(files),
    JSON.stringify(["LICENSE", "dist"]),
    "file allowlist"
  );

  for (const [subpath, jsFile, typesFile] of [
    [".", "./dist/index.js", "./dist/index.d.ts"],
    ["./testing", "./dist/testing.js", "./dist/testing.d.ts"],
  ]) {
    assertEqual(
      manifest.exports?.[subpath]?.import,
      jsFile,
      `${subpath} import export`
    );
    assertEqual(
      manifest.exports?.[subpath]?.types,
      typesFile,
      `${subpath} type export`
    );
  }
}

function anonymousNpmEnvironment(userConfigPath) {
  const environment = {
    ...processEnvironment,
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_REGISTRY: REGISTRY,
    NPM_CONFIG_USERCONFIG: userConfigPath,
    npm_config_userconfig: userConfigPath,
  };
  for (const name of ["NODE_AUTH_TOKEN", "NPM_TOKEN", "npm_config_token"]) {
    delete environment[name];
  }
  return environment;
}

function npmResult(args, workingDirectory, environment) {
  return spawnSync("npm", args, {
    cwd: workingDirectory,
    encoding: "utf8",
    env: environment,
  });
}

function tarEntries(tarballPath) {
  return execFileSync("tar", ["-tzf", tarballPath], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort();
}

function packedManifest(tarballPath) {
  const json = execFileSync(
    "tar",
    ["-xOzf", tarballPath, "package/package.json"],
    { encoding: "utf8" }
  );
  return JSON.parse(json);
}

function validateTarball(tarballPath, expectedVersion) {
  const entries = tarEntries(tarballPath);
  const required = [
    "package/LICENSE",
    "package/dist/index.d.ts",
    "package/dist/index.js",
    "package/dist/testing.d.ts",
    "package/dist/testing.js",
    "package/package.json",
  ];
  for (const entry of required) {
    if (!entries.includes(entry)) {
      fail(`tarball is missing ${entry}`);
    }
  }
  const unexpected = entries.filter(
    (entry) =>
      entry !== "package/package.json" &&
      entry !== "package/LICENSE" &&
      !entry.startsWith("package/dist/")
  );
  if (unexpected.length > 0) {
    fail(`tarball contains non-allowlisted files: ${unexpected.join(", ")}`);
  }
  validateManifest(packedManifest(tarballPath), expectedVersion);
  return entries;
}

function installAndProbe(packageSpec) {
  const consumerRoot = mkdtempSync(join(tmpdir(), "cogni-repo-spec-consumer-"));
  try {
    const userConfigPath = join(consumerRoot, ".npmrc");
    writeFileSync(userConfigPath, `registry=${REGISTRY}\n`, "utf8");
    writeFileSync(
      join(consumerRoot, "package.json"),
      JSON.stringify({
        name: "repo-spec-package-probe",
        private: true,
        type: "module",
      }),
      "utf8"
    );
    const install = npmResult(
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        packageSpec,
      ],
      consumerRoot,
      anonymousNpmEnvironment(userConfigPath)
    );
    if (install.status !== 0) {
      fail(`anonymous install failed:\n${install.stderr || install.stdout}`);
    }

    const probePath = join(consumerRoot, "probe.mjs");
    writeFileSync(
      probePath,
      `import assert from "node:assert/strict";
import { parseRepoSpec } from "@cogni/repo-spec";
import { buildTestRepoSpecYaml, TEST_NODE_IDS } from "@cogni/repo-spec/testing";

const parsed = parseRepoSpec(buildTestRepoSpecYaml());
assert.equal(parsed.node_id, TEST_NODE_IDS.operator);
console.log("repo-spec package probe passed");
`,
      "utf8"
    );
    execFileSync(execPath, [probePath], {
      cwd: consumerRoot,
      encoding: "utf8",
      stdio: "inherit",
    });
  } finally {
    rmSync(consumerRoot, { recursive: true, force: true });
  }
}

function writeEvidence({ phase, version, tarballPath, fileCount }) {
  const lines = [
    `### @cogni/repo-spec ${phase}`,
    "",
    `- version: \`${version}\``,
    `- source: \`${processEnvironment.GITHUB_SHA ?? "local"}\``,
    `- registry: \`${REGISTRY}\``,
  ];
  if (tarballPath) {
    lines.push(`- tarball: \`${tarballPath}\``);
  }
  if (fileCount !== undefined) {
    lines.push(`- packed files: \`${fileCount}\``);
  }
  lines.push(
    "- root export: verified",
    "- test-only `/testing` export: verified",
    ""
  );
  if (processEnvironment.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      processEnvironment.GITHUB_STEP_SUMMARY,
      `${lines.join("\n")}\n`,
      "utf8"
    );
  }
}

function packAndVerify(outputDirectory, expectedVersion) {
  const manifest = readManifest();
  validateManifest(manifest, expectedVersion);
  for (const relativePath of [
    "dist/index.js",
    "dist/index.d.ts",
    "dist/testing.js",
    "dist/testing.d.ts",
  ]) {
    if (!existsSync(join(PACKAGE_ROOT, relativePath))) {
      fail(`build output is missing ${relativePath}`);
    }
  }

  const absoluteOutput = resolve(REPO_ROOT, outputDirectory);
  mkdirSync(absoluteOutput, { recursive: true });
  const packJson = execFileSync(
    "npm",
    [
      "pack",
      PACKAGE_ROOT,
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      absoluteOutput,
    ],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
  const result = JSON.parse(packJson)[0];
  if (!result?.filename) {
    fail("npm pack did not report a tarball filename");
  }
  const tarballPath = join(absoluteOutput, result.filename);
  const entries = validateTarball(
    tarballPath,
    expectedVersion ?? manifest.version
  );
  installAndProbe(tarballPath);

  if (processEnvironment.GITHUB_OUTPUT) {
    appendFileSync(
      processEnvironment.GITHUB_OUTPUT,
      `tarball=${tarballPath}\n`,
      "utf8"
    );
    appendFileSync(
      processEnvironment.GITHUB_OUTPUT,
      `version=${manifest.version}\n`,
      "utf8"
    );
  }
  writeEvidence({
    phase: "packed artifact",
    version: manifest.version,
    tarballPath,
    fileCount: entries.length,
  });
  stdout.write(
    `${JSON.stringify({
      tarballPath,
      version: manifest.version,
      files: entries.length,
    })}\n`
  );
}

function assertUnpublished(name, version) {
  const configRoot = mkdtempSync(join(tmpdir(), "cogni-npm-view-"));
  try {
    const userConfigPath = join(configRoot, ".npmrc");
    writeFileSync(userConfigPath, `registry=${REGISTRY}\n`, "utf8");
    const result = npmResult(
      ["view", `${name}@${version}`, "version", "--json"],
      configRoot,
      anonymousNpmEnvironment(userConfigPath)
    );
    if (result.status === 0) {
      fail(`${name}@${version} already exists; npm versions are immutable`);
    }
    const diagnostic = `${result.stderr}\n${result.stdout}`;
    if (!diagnostic.includes("E404")) {
      fail(
        `registry preflight failed for a reason other than absence:\n${diagnostic}`
      );
    }
    stdout.write(`${name}@${version} is unpublished\n`);
  } finally {
    rmSync(configRoot, { recursive: true, force: true });
  }
}

async function verifyRegistry(name, version) {
  const configRoot = mkdtempSync(join(tmpdir(), "cogni-npm-registry-"));
  try {
    const userConfigPath = join(configRoot, ".npmrc");
    writeFileSync(userConfigPath, `registry=${REGISTRY}\n`, "utf8");
    let resolved = false;
    for (let attempt = 1; attempt <= 18; attempt += 1) {
      const result = npmResult(
        ["view", `${name}@${version}`, "version", "--json"],
        configRoot,
        anonymousNpmEnvironment(userConfigPath)
      );
      if (result.status === 0 && JSON.parse(result.stdout) === version) {
        resolved = true;
        break;
      }
      if (attempt < 18) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000));
      }
    }
    if (!resolved) {
      fail(
        `${name}@${version} did not become anonymously resolvable within 90 seconds`
      );
    }
    installAndProbe(`${name}@${version}`);
    writeEvidence({ phase: "registry proof", version });
  } finally {
    rmSync(configRoot, { recursive: true, force: true });
  }
}

async function main() {
  const { mode, values } = parseArgs(process.argv.slice(2));
  const manifest = readManifest();
  const expectedVersion = values.get("expected-version") || manifest.version;
  validateManifest(manifest, expectedVersion);

  if (mode === "pack") {
    packAndVerify(
      values.get("output-dir") ?? "package-artifact",
      expectedVersion
    );
    return;
  }
  if (mode === "assert-unpublished") {
    assertUnpublished(manifest.name, expectedVersion);
    return;
  }
  if (mode === "verify-registry") {
    await verifyRegistry(manifest.name, expectedVersion);
    return;
  }
  fail("mode must be pack, assert-unpublished, or verify-registry");
}

main().catch((error) => {
  stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  exit(1);
});
