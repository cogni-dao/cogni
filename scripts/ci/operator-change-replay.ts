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

import { parseRepoSpec } from "../../packages/repo-spec/src";
import {
  type OperatorChangeReplayReader,
  replayOperatorChange,
} from "../../nodes/operator/app/src/shared/vcs/operator-change-replay";
import {
  classifyOperatorChangeForMerge,
  type OperatorChangeFacts,
  parseOperatorChangeRegistry,
} from "../../nodes/operator/app/src/shared/vcs/operator-change-policy";

const reader: OperatorChangeReplayReader = {
  readFile: async (ref, path) => fileAt(ref, path),
  listPaths: async (ref, prefix) =>
    gitText(["ls-tree", "-r", "--name-only", ref, "--", prefix])
      .split("\n")
      .filter(Boolean),
};

interface PullRequestJson {
  readonly state?: string;
  readonly draft?: boolean;
  readonly commits?: number;
  readonly base?: { readonly ref?: string; readonly sha?: string };
  readonly head?: {
    readonly ref?: string;
    readonly sha?: string;
    readonly repo?: { readonly full_name?: string } | null;
  };
  readonly user?: {
    readonly login?: string;
    readonly id?: number;
    readonly type?: string;
  } | null;
}

interface CommitJson {
  readonly sha?: string;
  readonly author?: { readonly login?: string; readonly id?: number } | null;
  readonly parents?: ReadonlyArray<{ readonly sha?: string }>;
  readonly commit?: {
    readonly message?: string;
    readonly verification?: {
      readonly verified?: boolean;
      readonly reason?: string;
    } | null;
  };
}

interface FileJson {
  readonly filename?: string;
  readonly previous_filename?: string | null;
  readonly status?: string;
}

async function replayFromEnvironment(): Promise<void> {
  const operation = requiredEnv("OPERATOR_CHANGE_OPERATION");
  const node = requiredEnv("OPERATOR_CHANGE_NODE");
  const baseSha = requiredSha("OPERATOR_CHANGE_BASE_SHA");
  const headSha = requiredSha("OPERATOR_CHANGE_HEAD_SHA");
  const repository = requiredEnv("REPOSITORY");
  const paths = readFileSync(requiredEnv("OPERATOR_CHANGE_PATHS_FILE"), "utf8")
    .split("\n")
    .filter(Boolean);
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
    throw new Error(`operator-change replay failed: ${result.reason}`);
  }
}

async function classifyFromEnvironment(): Promise<void> {
  const repository = requiredEnv("REPOSITORY");
  const expectedHeadSha = requiredSha("PR_HEAD_SHA_PR");
  const pr = readJson<PullRequestJson>(requiredEnv("OPERATOR_CHANGE_PR_JSON"));
  const commit = readJson<CommitJson>(
    requiredEnv("OPERATOR_CHANGE_COMMIT_JSON")
  );
  const files = readJson<readonly FileJson[]>(
    requiredEnv("OPERATOR_CHANGE_FILES_JSON")
  );
  if (!Array.isArray(files)) throw new Error("invalid pull request files JSON");
  const registry = parseOperatorChangeRegistry(
    readJson<unknown>(requiredEnv("OPERATOR_CHANGE_REGISTRY_JSON"))
  );
  if (!registry) throw new Error("invalid trusted operator-change registry");

  const baseSha = pr.base?.sha ?? "";
  let repositoryNode: string | null = null;
  const baseRepoSpec = fileAt(baseSha, ".cogni/repo-spec.yaml");
  if (baseRepoSpec !== null) {
    try {
      repositoryNode = parseRepoSpec(baseRepoSpec).intent.name;
    } catch {
      repositoryNode = null;
    }
  }
  const facts: OperatorChangeFacts = {
    repository,
    repositoryNode,
    expectedHeadSha,
    pr: {
      state: pr.state ?? "",
      draft: pr.draft ?? true,
      baseRef: pr.base?.ref ?? "",
      baseSha,
      headRef: pr.head?.ref ?? "",
      headSha: pr.head?.sha ?? "",
      headRepoFullName: pr.head?.repo?.full_name ?? null,
      commitCount: pr.commits ?? -1,
      userLogin: pr.user?.login ?? null,
      userId: pr.user?.id ?? null,
      userType: pr.user?.type ?? null,
    },
    commit: {
      sha: commit.sha ?? "",
      message: commit.commit?.message ?? "",
      verified: commit.commit?.verification?.verified === true,
      verificationReason: commit.commit?.verification?.reason ?? null,
      authorLogin: commit.author?.login ?? null,
      authorId: commit.author?.id ?? null,
      parents: (commit.parents ?? []).map((parent) => parent.sha ?? ""),
    },
    files: files.map((file) => ({
      filename: file.filename ?? "",
      previousFilename: file.previous_filename ?? null,
      status: file.status ?? "",
    })),
    registry,
    operationReplayVerified: false,
  };

  let classification = classifyOperatorChangeForMerge(facts);
  if (
    classification.reason === "operation-replay-failed" &&
    classification.operation &&
    classification.node
  ) {
    const replay = await replayOperatorChange({
      operation: classification.operation,
      node: classification.node,
      baseSha: classification.baseSha,
      headSha: classification.headSha,
      repository,
      paths: facts.files.map((file) => file.filename),
      message: facts.commit.message,
      fleetControlEnv: process.env.FLEET_CONTROL_ENV,
      forkDomainRoot: process.env.FORK_DOMAIN_ROOT,
      reader,
    });
    classification = classifyOperatorChangeForMerge({
      ...facts,
      operationReplayVerified: replay.verified,
    });
  }

  const claimed = classification.reason !== "reserved-envelope-not-claimed";
  const invalid =
    claimed &&
    classification.reason !== "operation-disabled" &&
    classification.reason !== "eligible";
  process.stdout.write(
    [
      `eligible=${String(classification.eligible)}`,
      `claimed=${String(claimed)}`,
      `invalid=${String(invalid)}`,
      `operation=${classification.operation ?? "none"}`,
      `reason=${classification.reason}`,
    ].join("\n") + "\n"
  );
}

async function main(): Promise<void> {
  if (process.argv[2] === "classify") {
    await classifyFromEnvironment();
    return;
  }
  await replayFromEnvironment();
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
});

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
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
