// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO
/**
 * Module: `@scripts/ci/runtime-source-admission`
 * Purpose: Admit guarded runtime sources and repair partial ordinary enrollment.
 * Scope: Dependency-free source admission and shared fixed native staging transport.
 * Invariants: The protected marker's first merged commit is the source floor;
 *   an unqualified source must rebase, never silently execute newer code.
 * Side-effects: IO (Git reads, private SSH staging and guarded helper publication)
 * Links: bug.5570
 * @internal
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
export const ROOT = "/var/lib/cogni/runtime-maintenance";
export const LIB = "scripts/ci/lib";
export const FILES = [
  "runtime-maintenance-guard.py",
  "runtime-recovery-receipt.py",
  "gateway-activation-host.py",
  "runtime-recovery-host.py",
  "runtime-guard-install.py",
] as const;
export const ADMISSION_INPUTS = {
  enrollmentAdapter: `${LIB}/gateway-install-host.py`,
  sourceAdmission: "scripts/ci/runtime-source-admission.ts",
  writerPolicy: ".cogni/runtime-maintenance.v1.json",
  dependencyLock: "pnpm-lock.yaml",
  rootManifest: "package.json",
  workspaceManifest: "pnpm-workspace.yaml",
  gatewayManifest: "nodes/operator/packages/gateway-activation/package.json",
  nodeVersion: ".nvmrc",
} as const;

const need = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message);
};
const command = (file: string, args: string[]) =>
  execFileSync(file, args, {
    encoding: "utf8",
    timeout: 30000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const marker = ".cogni/runtime-maintenance.v1.json";
const git = (...args: string[]) =>
  execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

export function runtimeSourceFloor(): string {
  const floor = git(
    "log",
    "origin/main",
    "--first-parent",
    "--diff-filter=A",
    "--format=%H",
    "-1",
    "--",
    marker
  );
  if (!/^[a-f0-9]{40}$/.test(floor))
    throw new Error("runtime_guard_floor_missing");
  return floor;
}

export function assertRuntimeSource(source: string): string {
  if (!/^[a-f0-9]{40}$/.test(source))
    throw new Error("runtime_guard_source_not_exact");
  const floor = runtimeSourceFloor();
  git("merge-base", "--is-ancestor", floor, source);
  return floor;
}

export function sshArgs(): string[] {
  const host = process.env.VM_HOST ?? "";
  need(
    /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(host),
    "gateway_vm_host_invalid"
  );
  const repair = process.argv[2] === "repair-installed-guard";
  const repairKey = process.env.SSH_KEY_PATH;
  const key = repair
    ? repairKey && existsSync(repairKey)
      ? repairKey
      : undefined
    : process.env.GITHUB_ACTIONS !== "true" &&
        process.argv[2] === "bootstrap-candidate"
      ? process.env.GATEWAY_CANDIDATE_SSH_KEY
      : join(homedir(), ".ssh/deploy_key");
  need(key || repair, "gateway_ssh_identity_missing");
  return [
    ...(key ? ["-i", key] : []),
    "-o",
    "BatchMode=yes",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=10",
    "-o",
    "ServerAliveCountMax=6",
  ];
}

export function assertCheckout(source: string): void {
  need(
    command("git", ["rev-parse", "HEAD"]) === source,
    "gateway_checkout_source_mismatch"
  );
  const protectedPaths = [
    ...FILES.map((f) => `${LIB}/${f}`),
    ...Object.values(ADMISSION_INPUTS),
    "scripts/ci/gateway-activation.ts",
    "nodes/operator/packages/gateway-activation/src/index.ts",
  ];
  command("git", ["diff", "--exit-code", source, "--", ...protectedPaths]);
  for (const path of protectedPaths) {
    need(
      command("git", ["rev-parse", `${source}:${path}`]) ===
        command("git", ["hash-object", "--no-filters", path]),
      "gateway_checkout_bytes_changed"
    );
  }
}

export function withStagedLibrary(
  effect: (host: string, stage: string) => void
): void {
  const args = sshArgs();
  const host = `root@${process.env.VM_HOST}`;
  const stage = `${ROOT}/staging/${randomUUID()}`;
  command("ssh", [
    ...args,
    host,
    `umask 077; install -d -m 700 ${ROOT}/staging ${stage}`,
  ]);
  try {
    command("scp", [
      ...args,
      ...FILES.map((f) => `${LIB}/${f}`),
      `${LIB}/gateway-install-host.py`,
      `${host}:${stage}/`,
    ]);
    effect(host, stage);
  } finally {
    command("ssh", [...args, host, `rm -rf -- ${stage}`]);
  }
}

/** Repair incomplete ordinary enrollment before custody-free recovery can run. */
function repairInstalledGuard(): void {
  need(
    /^candidate-[a-z0-9-]+$/.test(process.env.DEPLOY_ENVIRONMENT ?? ""),
    "gateway_guard_repair_candidate_only"
  );
  const source = command("git", ["rev-parse", "HEAD"]);
  assertRuntimeSource(source);
  assertCheckout(source);
  withStagedLibrary((host, stage) => {
    // The admitted staged installer acquires the shared guard and refuses any
    // pending activation. No installed helper is trusted to repair itself.
    command("ssh", [
      ...sshArgs(),
      host,
      `python3 ${stage}/runtime-guard-install.py install ${source}`,
    ]);
    command("ssh", [
      ...sshArgs(),
      host,
      `python3 ${stage}/runtime-maintenance-guard.py exec-installed true`,
    ]);
  });
}

if (process.argv[1]?.endsWith("runtime-source-admission.ts")) {
  try {
    if (process.argv.length !== 3)
      throw new Error("runtime_guard_source_required");
    if (process.argv[2] === "repair-installed-guard") repairInstalledGuard();
    else console.log(assertRuntimeSource(process.argv[2] ?? ""));
  } catch {
    console.error(
      process.argv[2] === "repair-installed-guard"
        ? "runtime_guard_repair_unavailable"
        : "runtime_guard_source_refused_rebase_required"
    );
    process.exitCode = 1;
  }
}
