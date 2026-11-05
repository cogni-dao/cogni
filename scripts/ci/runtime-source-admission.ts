// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/**
 * Module: `scripts/ci/runtime-source-admission`
 * Purpose: Reject runtime writers predating the shared guard before source checkout.
 * Scope: Trusted-main transport; native Git only, no target credentials.
 * Invariants: The protected marker's first merged commit is the source floor;
 *   an unqualified source must rebase, never silently execute newer code.
 * Side-effects: Local Git reads only.
 * Links: bug.5570
 * @internal
 */
import { execFileSync } from "node:child_process";

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

if (process.argv[1]?.endsWith("runtime-source-admission.ts")) {
  try {
    if (process.argv.length !== 3)
      throw new Error("runtime_guard_source_required");
    console.log(assertRuntimeSource(process.argv[2] ?? ""));
  } catch {
    console.error("runtime_guard_source_refused_rebase_required");
    process.exitCode = 1;
  }
}
