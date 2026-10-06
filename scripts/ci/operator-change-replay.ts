// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/ci/operator-change-replay`
 * Purpose: Provide the zero-install Git transport for canonical operator-change replay.
 * Scope: Trusted CI checkout; reads exact base and head files with Git; does not access the network or write files.
 * Invariants: The bundle calls the deployed operator's semantic core and accepts only immutable workflow inputs.
 * Side-effects: IO (read-only Git subprocesses and stderr/exit), process.env (immutable workflow inputs)
 * Links: docs/spec/merge-queue-config.md, task.5185
 * @internal
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import {
  type OperatorChangeReplayReader,
  replayOperatorChange,
} from "../../nodes/operator/app/src/shared/vcs/operator-change-replay";

const operation = requiredEnv("OPERATOR_CHANGE_OPERATION");
const node = requiredEnv("OPERATOR_CHANGE_NODE");
const baseSha = requiredSha("OPERATOR_CHANGE_BASE_SHA");
const headSha = requiredSha("OPERATOR_CHANGE_HEAD_SHA");
const repository = requiredEnv("REPOSITORY");
const paths = readFileSync(requiredEnv("OPERATOR_CHANGE_PATHS_FILE"), "utf8")
  .split("\n")
  .filter(Boolean);

const reader: OperatorChangeReplayReader = {
  readFile: async (ref, path) => fileAt(ref, path),
  listPaths: async (ref, prefix) =>
    gitText(["ls-tree", "-r", "--name-only", ref, "--", prefix])
      .split("\n")
      .filter(Boolean),
};

const result = await replayOperatorChange({
  operation,
  node,
  baseSha,
  headSha,
  repository,
  paths,
  message: gitText(["show", "-s", "--format=%B", headSha]),
  fleetControlEnv: process.env.FLEET_CONTROL_ENV,
  forkDomainRoot: process.env.FORK_DOMAIN_ROOT,
  reader,
});
if (!result.verified) {
  process.stderr.write(`operator-change replay failed: ${result.reason}\n`);
  process.exit(1);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing env: ${name}`);
  return value;
}

function requiredSha(name: string): string {
  const value = requiredEnv(name);
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error(`invalid sha: ${name}`);
  return value;
}

function fileAt(ref: string, path: string): string | null {
  try {
    return gitText(["show", `${ref}:${path}`]);
  } catch {
    return null;
  }
}

function gitText(args: readonly string[]): string {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
}
