#!/usr/bin/env tsx
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/ci/check-resource-fit`
 * Purpose: CI entrypoint for rendered Kubernetes resource-fit admission.
 * Scope: Renders or reads manifests and writes JSON/markdown reports; does not
 *   mutate deploy branches, apply AppSets, or query live clusters.
 * Invariants:
 *   - Workflows call this as one guard; no resource math belongs in YAML/bash.
 *   - Baseline comparison renders a separate tree, typically origin/main.
 * Side-effects: IO (filesystem reads/writes, child-process Kustomize and Conftest invocations)
 * Links: docs/design/operator-fleet-safety.md, infra/capacity/envs.yaml
 * @internal
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  evaluateResourceFit,
  extractKubernetesWorkloads,
  loadEnvBudgetsFromYaml,
  parseKubernetesDocuments,
  type ResourceFitReport,
  type WorkloadDemand,
} from "../../packages/deploy-policy/src/index";

interface CliOptions {
  readonly env: string;
  readonly budgetPath: string;
  readonly overlayRoot: string;
  readonly baselineOverlayRoot?: string;
  readonly baselineRef?: string;
  readonly targets?: readonly string[];
  readonly manifestPaths: readonly string[];
  readonly baselineManifestPaths: readonly string[];
  readonly policyPath: string;
  readonly conftestInputOut: string;
  readonly jsonOut?: string;
  readonly markdownOut?: string;
  readonly githubStepSummary: boolean;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const budgetYaml = readFileSync(options.budgetPath, "utf8");
  const budget = loadEnvBudgetsFromYaml(budgetYaml)[options.env];
  if (!budget) {
    throw new Error(`no capacity budget found for env ${options.env}`);
  }

  const manifests =
    options.manifestPaths.length > 0
      ? readManifestFiles(options.manifestPaths)
      : renderOverlaySet(options.overlayRoot, options.env, options.targets);
  const workloads = workloadsFromRendered(
    manifests,
    budget.rollout.includeMaxSurge
  );

  const baselineRoot = baselineOverlayRoot(options);
  const baselineManifests =
    options.baselineManifestPaths.length > 0
      ? readManifestFiles(options.baselineManifestPaths)
      : baselineRoot
        ? renderOverlaySet(baselineRoot, options.env, options.targets)
        : undefined;
  const baselineWorkloads = baselineManifests
    ? workloadsFromRendered(baselineManifests, budget.rollout.includeMaxSurge)
    : undefined;

  const report = evaluateResourceFit({
    env: options.env,
    budget,
    workloads,
    ...(baselineWorkloads ? { baselineWorkloads } : {}),
  });
  const conftestInput = JSON.stringify(report, null, 2);
  writeOutput(options.conftestInputOut, `${conftestInput}\n`);

  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.jsonOut) {
    writeOutput(options.jsonOut, json);
  } else {
    process.stdout.write(json);
  }
  const markdown = renderMarkdown(report);
  if (options.markdownOut) {
    writeOutput(options.markdownOut, markdown);
  }
  if (options.githubStepSummary) {
    appendGithubStepSummary(markdown);
  }

  const conftest = runConftest({
    inputPath: options.conftestInputOut,
    policyPath: options.policyPath,
  });
  if (!conftest.allowed) {
    process.stderr.write(conftest.output);
    process.stderr.write(`resource-fit denied by Conftest: ${report.reason}\n`);
    process.exitCode = 1;
    return;
  }

  if (!report.allowed) {
    process.stderr.write(`resource-fit denied: ${report.reason}\n`);
    process.exitCode = 1;
  }
}

function parseArgs(args: readonly string[]): CliOptions {
  const values = new Map<string, string[]>();
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token?.startsWith("--")) {
      throw new Error(`unexpected argument ${token}`);
    }
    const key = token.slice(2);
    const next = args[i + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`missing value for --${key}`);
    }
    values.set(key, [...(values.get(key) ?? []), next]);
    i += 1;
  }

  const env = one(values, "env") ?? "production";
  const targets = splitCsv(one(values, "targets"));
  const jsonOut = one(values, "json-out");
  const markdownOut = one(values, "markdown-out");
  const baselineOverlayRootValue = one(values, "baseline-overlay-root");
  const baselineRef = one(values, "baseline-ref");
  const conftestInputOut =
    one(values, "conftest-input-out") ??
    path.join(".context", "resource-fit", `${env}.input.json`);

  return {
    env,
    budgetPath: one(values, "budget") ?? "infra/capacity/envs.yaml",
    overlayRoot: one(values, "overlay-root") ?? "infra/k8s/overlays",
    policyPath: one(values, "policy") ?? "infra/policy/resource-fit",
    conftestInputOut,
    ...(baselineOverlayRootValue
      ? { baselineOverlayRoot: baselineOverlayRootValue }
      : {}),
    ...(baselineRef ? { baselineRef } : {}),
    ...(targets ? { targets } : {}),
    manifestPaths: values.get("manifest") ?? [],
    baselineManifestPaths: values.get("baseline-manifest") ?? [],
    ...(jsonOut ? { jsonOut } : {}),
    ...(markdownOut ? { markdownOut } : {}),
    githubStepSummary: values.has("github-step-summary"),
  };
}

function renderOverlaySet(
  overlayRoot: string,
  env: string,
  targets?: readonly string[]
): string {
  const envRoot = path.join(overlayRoot, env);
  const selectedTargets =
    targets && targets.length > 0
      ? targets
      : readdirSync(envRoot, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort();

  return selectedTargets
    .map((target) => {
      const overlay = path.join(envRoot, target);
      if (!existsSync(path.join(overlay, "kustomization.yaml"))) {
        throw new Error(`missing ${overlay}/kustomization.yaml`);
      }
      return renderKustomize(overlay);
    })
    .join("\n---\n");
}

function renderKustomize(overlay: string): string {
  const command = commandForKustomize(overlay);
  try {
    return execFileSync(command.bin, command.args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`failed to render ${overlay}: ${message}`);
  }
}

function commandForKustomize(overlay: string): {
  readonly bin: string;
  readonly args: readonly string[];
} {
  try {
    execFileSync("kubectl", ["version", "--client"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { bin: "kubectl", args: ["kustomize", overlay] };
  } catch {
    try {
      execFileSync("kustomize", ["version"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      return { bin: "kustomize", args: ["build", overlay] };
    } catch {
      try {
        execFileSync("docker", ["version"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
        const repoRoot = process.cwd();
        return {
          bin: "docker",
          args: [
            "run",
            "--rm",
            "-v",
            `${repoRoot}:${repoRoot}`,
            "-w",
            repoRoot,
            "bitnami/kubectl:1.30",
            "kubectl",
            "kustomize",
            overlay,
          ],
        };
      } catch {
        throw new Error(
          "kubectl, kustomize, or docker is required to render overlays"
        );
      }
    }
  }
}

function baselineOverlayRoot(options: CliOptions): string | undefined {
  if (options.baselineOverlayRoot) {
    return options.baselineOverlayRoot;
  }
  if (!options.baselineRef) {
    return undefined;
  }
  const dir = path.join(
    ".context",
    "resource-fit-baseline",
    options.baselineRef.replace(/[^a-zA-Z0-9_.-]/g, "_")
  );
  try {
    execFileSync("git", ["worktree", "remove", "--force", dir], {
      encoding: "utf8",
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    // Absent worktree is fine; `prune` below clears stale registrations.
  }
  execFileSync("git", ["worktree", "prune"], {
    encoding: "utf8",
    stdio: ["ignore", "ignore", "ignore"],
  });
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.dirname(dir), { recursive: true });
  execFileSync(
    "git",
    ["worktree", "add", "--detach", dir, options.baselineRef],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  return path.join(dir, options.overlayRoot);
}

function readManifestFiles(paths: readonly string[]): string {
  return paths.map((file) => readFileSync(file, "utf8")).join("\n---\n");
}

function runConftest(input: {
  readonly inputPath: string;
  readonly policyPath: string;
}): { readonly allowed: boolean; readonly output: string } {
  const args = [
    "test",
    "--policy",
    input.policyPath,
    "--namespace",
    "resource_fit",
    "--output",
    "json",
    input.inputPath,
  ];
  try {
    const output = execFileSync("conftest", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { allowed: true, output };
  } catch (err) {
    if (isMissingCommand(err)) {
      return runConftestWithDocker(args);
    }
    return {
      allowed: false,
      output: commandOutput(err),
    };
  }
}

function runConftestWithDocker(conftestArgs: readonly string[]): {
  readonly allowed: boolean;
  readonly output: string;
} {
  const repoRoot = process.cwd();
  const args = [
    "run",
    "--rm",
    "-v",
    `${repoRoot}:${repoRoot}`,
    "-w",
    repoRoot,
    "openpolicyagent/conftest:v0.62.0",
    ...conftestArgs,
  ];
  try {
    const output = execFileSync("docker", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { allowed: true, output };
  } catch (err) {
    return {
      allowed: false,
      output: commandOutput(err),
    };
  }
}

function workloadsFromRendered(
  rendered: string,
  includeMaxSurge: boolean
): readonly WorkloadDemand[] {
  return extractKubernetesWorkloads(parseKubernetesDocuments(rendered), {
    includeMaxSurge,
  });
}

function renderMarkdown(report: ResourceFitReport): string {
  const verdict = report.allowed ? "PASS" : "FAIL";
  const lines = [
    `# Resource Fit: ${report.env}`,
    "",
    `**Verdict:** ${verdict}`,
    "",
    `Reason: ${report.reason}`,
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| Requested memory | ${report.totals.requestedMemoryMi}Mi |`,
    `| Available memory | ${report.totals.availableMemoryMi}Mi |`,
    `| Requested CPU | ${report.totals.requestedCpuMilli}m |`,
    `| Available CPU | ${report.totals.availableCpuMilli}m |`,
    "",
  ];

  if (report.violations.length > 0) {
    lines.push("## Violations", "");
    for (const violation of report.violations) {
      lines.push(`- \`${violation.code}\`: ${violation.message}`);
    }
    lines.push("");
  }

  lines.push("## Workloads", "");
  lines.push(
    "| Workload | Replicas | Surge | Pod Memory | Pod CPU | Effective Memory | Effective CPU |"
  );
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const workload of report.workloads) {
    lines.push(
      `| ${workload.kind}/${workload.name} | ${workload.replicas} | ${workload.rolloutExtraReplicas} | ${workload.podRequestMemoryMi}Mi | ${workload.podRequestCpuMilli}m | ${workload.effectiveMemoryMi}Mi | ${workload.effectiveCpuMilli}m |`
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function writeOutput(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function appendGithubStepSummary(markdown: string): void {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }
  writeFileSync(summaryPath, markdown, { flag: "a" });
}

function one(values: Map<string, string[]>, key: string): string | undefined {
  const all = values.get(key);
  if (!all || all.length === 0) return undefined;
  if (all.length > 1) throw new Error(`--${key} may only be supplied once`);
  return all[0];
}

function splitCsv(value: string | undefined): readonly string[] | undefined {
  if (!value) return undefined;
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isMissingCommand(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

function commandOutput(err: unknown): string {
  if (typeof err !== "object" || err === null) {
    return `${String(err)}\n`;
  }
  const output = err as {
    stdout?: unknown;
    stderr?: unknown;
    message?: unknown;
  };
  return [
    typeof output.stdout === "string" ? output.stdout : "",
    typeof output.stderr === "string" ? output.stderr : "",
    typeof output.message === "string" ? output.message : "",
  ]
    .filter(Boolean)
    .join("\n");
}

main();
