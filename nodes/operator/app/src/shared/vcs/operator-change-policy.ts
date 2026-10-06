// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Pure, fail-closed policy for the internal operator-generated-change merge lane.
 * GitHub webhook/check data is never an authorization input here; the adapter
 * supplies freshly fetched PR, commit, file, and trusted-main registry facts.
 */

import { createHash } from "node:crypto";

export const OPERATOR_CHANGE_TYPE = "cogni.operator-change.v1";

export type OperatorChangeOperation =
  | "env.membership"
  | "env.placement"
  | "env.region"
  | "node.register"
  | "deployment.declare";

export interface OperatorChangeRegistry {
  readonly version: typeof OPERATOR_CHANGE_TYPE;
  readonly repositories: Readonly<
    Record<string, { readonly botLogin: string; readonly botId: number }>
  >;
  /** Signer identity only; never operation eligibility. */
  readonly childRepositoryApps: Readonly<
    Record<string, { readonly botLogin: string; readonly botId: number }>
  >;
  readonly operations: Readonly<
    Record<
      OperatorChangeOperation,
      {
        readonly enabledRepositories: readonly string[];
        /** deployment.declare only; exact child repo still comes from base repo-spec. */
        readonly enabledChildOwners?: readonly string[];
        readonly verifier: string;
      }
    >
  >;
}

export interface OperatorChangeFacts {
  readonly repository: string;
  /** `intent.name` independently read from the current base repo-spec. */
  readonly repositoryNode: string | null;
  readonly expectedHeadSha: string;
  readonly pr: {
    readonly state: string;
    readonly draft: boolean;
    readonly baseRef: string;
    readonly baseSha: string;
    readonly headRef: string;
    readonly headSha: string;
    readonly headRepoFullName: string | null;
    readonly commitCount: number;
    readonly userLogin: string | null;
    readonly userId: number | null;
    readonly userType: string | null;
  };
  readonly commit: {
    readonly sha: string;
    readonly message: string;
    readonly verified: boolean;
    readonly verificationReason: string | null;
    readonly authorLogin: string | null;
    readonly authorId: number | null;
    readonly parents: readonly string[];
  };
  readonly files: readonly {
    readonly filename: string;
    readonly previousFilename: string | null;
    readonly status: string;
  }[];
  readonly registry: OperatorChangeRegistry;
  readonly operationReplayVerified: boolean;
}

export interface OperatorChangeClassification {
  readonly eligible: boolean;
  readonly reason: string;
  readonly headSha: string;
  readonly baseSha: string;
  readonly operation?: OperatorChangeOperation;
  readonly node?: string;
}

const SHA = /^[0-9a-f]{40}$/;
const PATH_SHA = /^[0-9a-f]{64}$/;
const NODE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const OPERATIONS = new Set<OperatorChangeOperation>([
  "env.membership",
  "env.placement",
  "env.region",
  "node.register",
  "deployment.declare",
]);

function reject(
  facts: OperatorChangeFacts,
  reason: string,
  operation?: OperatorChangeOperation,
  node?: string
): OperatorChangeClassification {
  return {
    eligible: false,
    reason,
    headSha: facts.pr.headSha,
    baseSha: facts.pr.baseSha,
    ...(operation ? { operation } : {}),
    ...(node ? { node } : {}),
  };
}

function singleTrailer(message: string, key: string): string | null {
  const prefix = `${key}: `;
  const values = trailerValues(message, key);
  return values.length === 1 ? (values[0] ?? null) : null;
}

function trailerValues(message: string, key: string): string[] {
  const prefix = `${key}: `;
  return message
    .split("\n")
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length));
}

function trailerCount(message: string): number {
  return message.split("\n").filter((line) => line.startsWith("Cogni-")).length;
}

function canonicalPathHash(paths: readonly string[]): string {
  return createHash("sha256")
    .update(`${[...paths].sort().join("\n")}\n`)
    .digest("hex");
}

export function parseOperatorChangeRegistry(
  value: unknown
): OperatorChangeRegistry | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== OPERATOR_CHANGE_TYPE) return null;
  const repositories = candidate.repositories;
  const childRepositoryApps = candidate.childRepositoryApps;
  const operations = candidate.operations;
  if (
    repositories === null ||
    typeof repositories !== "object" ||
    Array.isArray(repositories) ||
    childRepositoryApps === null ||
    typeof childRepositoryApps !== "object" ||
    Array.isArray(childRepositoryApps) ||
    operations === null ||
    typeof operations !== "object" ||
    Array.isArray(operations)
  ) {
    return null;
  }
  for (const identity of Object.values(repositories)) {
    if (
      identity === null ||
      typeof identity !== "object" ||
      Array.isArray(identity) ||
      typeof (identity as Record<string, unknown>).botLogin !== "string" ||
      !Number.isInteger((identity as Record<string, unknown>).botId)
    ) {
      return null;
    }
  }
  for (const identity of Object.values(childRepositoryApps)) {
    if (
      identity === null ||
      typeof identity !== "object" ||
      Array.isArray(identity) ||
      typeof (identity as Record<string, unknown>).botLogin !== "string" ||
      !Number.isInteger((identity as Record<string, unknown>).botId)
    ) {
      return null;
    }
  }
  for (const operation of OPERATIONS) {
    const entry = (operations as Record<string, unknown>)[operation];
    if (
      entry === null ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      !Array.isArray((entry as Record<string, unknown>).enabledRepositories) ||
      !(entry as { enabledRepositories: unknown[] }).enabledRepositories.every(
        (repo) => typeof repo === "string"
      ) ||
      typeof (entry as Record<string, unknown>).verifier !== "string"
    ) {
      return null;
    }
    const enabledChildOwners = (entry as Record<string, unknown>)
      .enabledChildOwners;
    if (
      (operation === "deployment.declare" &&
        (!Array.isArray(enabledChildOwners) ||
          !enabledChildOwners.every((owner) => typeof owner === "string"))) ||
      (operation !== "deployment.declare" && enabledChildOwners !== undefined)
    ) {
      return null;
    }
  }
  return value as OperatorChangeRegistry;
}

/**
 * Reclassify one exact PR head from independently fetched GitHub facts.
 * `operationReplayVerified` is supplied only by an operation-specific verifier
 * running inside the trusted operator service; a check name can never set it.
 */
export function classifyOperatorChangeForMerge(
  facts: OperatorChangeFacts
): OperatorChangeClassification {
  const repo = facts.repository.toLowerCase();
  const message = facts.commit.message;
  const changeTypes = trailerValues(message, "Cogni-Change-Type");
  if (changeTypes.length === 0) {
    return reject(facts, "reserved-envelope-not-claimed");
  }
  if (changeTypes.length !== 1 || changeTypes[0] !== OPERATOR_CHANGE_TYPE) {
    return reject(facts, "invalid-change-type");
  }
  const operationValue = singleTrailer(message, "Cogni-Operation");
  if (
    !operationValue ||
    !OPERATIONS.has(operationValue as OperatorChangeOperation)
  ) {
    return reject(facts, "duplicate-or-unlisted-operation");
  }
  const operation = operationValue as OperatorChangeOperation;
  const node = singleTrailer(message, "Cogni-Node");
  const baseSha = singleTrailer(message, "Cogni-Base-SHA");
  const signedPathHash = singleTrailer(message, "Cogni-Changed-Paths-SHA256");
  if (!node || !NODE.test(node))
    return reject(facts, "invalid-node", operation);

  let identity = facts.registry.repositories[repo];
  let childRepositoryBound = false;
  if (!identity && operation === "deployment.declare") {
    const parts = repo.split("/");
    const owner = parts[0];
    const repoName = parts[1];
    if (
      parts.length === 2 &&
      owner &&
      repoName === node &&
      facts.repositoryNode === node
    ) {
      identity = facts.registry.childRepositoryApps[owner];
      childRepositoryBound = identity !== undefined;
    }
  }
  if (!identity) return reject(facts, "untrusted-repository", operation, node);

  if (!baseSha || !SHA.test(baseSha)) {
    return reject(facts, "invalid-base-sha", operation, node);
  }
  if (!signedPathHash || !PATH_SHA.test(signedPathHash)) {
    return reject(facts, "invalid-path-hash", operation, node);
  }

  if (
    facts.pr.state !== "open" ||
    facts.pr.draft !== false ||
    facts.pr.baseRef !== "main" ||
    facts.pr.baseSha !== baseSha ||
    facts.pr.headSha !== facts.expectedHeadSha ||
    facts.commit.sha !== facts.expectedHeadSha ||
    facts.pr.headRepoFullName?.toLowerCase() !== repo ||
    facts.pr.commitCount !== 1 ||
    facts.pr.userLogin !== identity.botLogin ||
    facts.pr.userId !== identity.botId ||
    facts.pr.userType !== "Bot"
  ) {
    return reject(facts, "invalid-pr-identity", operation, node);
  }
  if (
    facts.commit.verified !== true ||
    facts.commit.verificationReason !== "valid" ||
    facts.commit.authorLogin !== identity.botLogin ||
    facts.commit.authorId !== identity.botId ||
    facts.commit.parents.length !== 1 ||
    facts.commit.parents[0] !== baseSha
  ) {
    return reject(facts, "invalid-commit-signature", operation, node);
  }

  const subject = message.split("\n", 1)[0] ?? "";
  let expectedTrailerCount: number;
  switch (operation) {
    case "env.membership": {
      expectedTrailerCount = 8;
      const env = singleTrailer(message, "Cogni-Environment");
      const action = singleTrailer(message, "Cogni-Action");
      const generation = singleTrailer(message, "Cogni-Lease-Generation");
      if (
        !env?.match(/^(candidate-a|preview|production)$/) ||
        !action?.match(/^(add|remove)$/) ||
        !generation?.match(/^\d+$/) ||
        facts.pr.headRef !== `cogni-operator/node-env-${node}-${env}` ||
        subject !==
          `feat(node): ${action} ${node} ${action === "add" ? "to" : "from"} ${env}`
      ) {
        return reject(facts, "invalid-membership-envelope", operation, node);
      }
      break;
    }
    case "env.placement": {
      expectedTrailerCount = 7;
      const env = singleTrailer(message, "Cogni-Environment");
      const provider = singleTrailer(message, "Cogni-Provider");
      if (
        !env?.match(/^(candidate-a|preview|production)$/) ||
        !provider?.match(/^(k3s|akash)$/) ||
        facts.pr.headRef !== `cogni-operator/node-placement-${node}-${env}` ||
        subject !== `feat(node): place ${node} ${env} on ${provider}`
      ) {
        return reject(facts, "invalid-placement-envelope", operation, node);
      }
      break;
    }
    case "env.region": {
      expectedTrailerCount = 8;
      const env = singleTrailer(message, "Cogni-Environment");
      const countries = singleTrailer(message, "Cogni-Countries");
      const generation = singleTrailer(message, "Cogni-Lease-Generation");
      if (
        !env?.match(/^(candidate-a|preview|production)$/) ||
        !countries?.match(/^[A-Z]{2}(,[A-Z]{2})*$/) ||
        !generation?.match(/^\d+$/) ||
        facts.pr.headRef !== `cogni-operator/node-region-${node}-${env}` ||
        subject !==
          `feat(node): require ${node} ${env} placement in ${countries.replaceAll(",", ", ")}`
      ) {
        return reject(facts, "invalid-region-envelope", operation, node);
      }
      break;
    }
    case "node.register": {
      expectedTrailerCount = 9;
      const nodeId = singleTrailer(message, "Cogni-Node-Id");
      const sourceRepo = singleTrailer(message, "Cogni-Source-Repo");
      const sourceSha = singleTrailer(message, "Cogni-Source-SHA");
      const ownerWallet = singleTrailer(message, "Cogni-Owner-Wallet");
      const fleetOwner = repo.split("/", 1)[0];
      if (
        !nodeId?.match(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
        ) ||
        !sourceSha?.match(SHA) ||
        !ownerWallet?.match(/^0x[0-9a-fA-F]{40}$/) ||
        sourceRepo?.toLowerCase() !==
          `https://github.com/${fleetOwner}/${node}.git` ||
        facts.pr.headRef !== `cogni-operator/node-register-${node}` ||
        subject !== `feat(node): register ${node}`
      ) {
        return reject(facts, "invalid-register-envelope", operation, node);
      }
      break;
    }
    case "deployment.declare":
      expectedTrailerCount = 5;
      if (
        facts.pr.headRef !== `cogni-operator/declare-deployment-${node}` ||
        subject !== `feat(deploy): declare ${node} node deployment`
      ) {
        return reject(facts, "invalid-deployment-envelope", operation, node);
      }
      break;
  }
  if (trailerCount(message) !== expectedTrailerCount) {
    return reject(facts, "unexpected-or-duplicate-trailer", operation, node);
  }

  if (
    facts.files.length === 0 ||
    facts.files.length > 32 ||
    facts.files.some(
      (file) =>
        file.previousFilename !== null ||
        !["added", "modified", "removed"].includes(file.status)
    )
  ) {
    return reject(facts, "invalid-file-metadata", operation, node);
  }
  const paths = facts.files.map((file) => file.filename);
  if (new Set(paths).size !== paths.length) {
    return reject(facts, "duplicate-file", operation, node);
  }
  if (canonicalPathHash(paths) !== signedPathHash) {
    return reject(facts, "changed-path-hash-mismatch", operation, node);
  }

  const operationPolicy = facts.registry.operations[operation];
  const enabled =
    operationPolicy.enabledRepositories.some(
      (enabledRepo) => enabledRepo.toLowerCase() === repo
    ) ||
    (operation === "deployment.declare" &&
      childRepositoryBound &&
      operationPolicy.enabledChildOwners?.some(
        (owner) => owner.toLowerCase() === repo.split("/", 1)[0]
      ) === true);
  if (!enabled) return reject(facts, "operation-disabled", operation, node);
  if (!facts.operationReplayVerified) {
    return reject(facts, "operation-replay-failed", operation, node);
  }
  return {
    eligible: true,
    reason: "eligible",
    headSha: facts.pr.headSha,
    baseSha: facts.pr.baseSha,
    operation,
    node,
  };
}
