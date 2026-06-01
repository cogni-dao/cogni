// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/classify`
 * Purpose: Reference TypeScript implementation of the single-node-scope policy.
 *          Mirrors the bash logic in `.github/workflows/ci.yaml#single-node-scope`
 *          and is the surface task.0382's runtime resolver must match.
 * Scope: Pure function used by parity tests. Does NOT read the filesystem or invoke git.
 * Invariants: SINGLE_DOMAIN_HARD_FAIL, OPERATOR_IS_A_NODE, RIDE_ALONG (see work/items/task.0381.* §Invariants).
 * Side-effects: none
 * Notes: When task.0382 lands, it should import this same function (or replicate
 *        it identically) and run the same fixtures.
 * Links: tests/ci-invariants/fixtures/single-node-scope/, work/items/task.0382.*
 * @public
 */

export type Domain = "operator" | string;

export interface ClassifyResult {
  /** Distinct domains touched by the diff, post-exception. Sorted, lowercase. */
  domains: Domain[];
  /** True iff the gate would pass. */
  pass: boolean;
  /** Set when RIDE_ALONG bumped a 2-domain diff down to 1. */
  rideAlongApplied: boolean;
}

const NODES_PREFIX = "nodes/";
const OPERATOR_NODE = "operator";

/**
 * Operator-domain paths that may ride along a single non-operator node PR.
 * These are mechanical side-effects or cross-cutting node intent that lives
 * outside `nodes/<X>/` only because we have not yet migrated it (work items
 * → Dolt). Adding to this list weakens the gate; do so deliberately.
 *
 * - `pnpm-lock.yaml`: mechanical side-effect of node-level package.json edits.
 * - `work/**`: per-task work items, projects, charters; high merge-conflict +
 *   index-regen churn. Ride-along until task tracking moves to Dolt.
 * - `docs/**`: cross-cutting prose updates that accompany a node change.
 * - `.claude/skills/**`: agent-facing skill docs that frequently codify the
 *   exact principle a node-scoped fix demonstrates. Treat like docs/ —
 *   prose that travels with the implementing code.
 * - Exact single-node-scope policy maintenance files: the workflow gate,
 *   reference classifier, repo-spec resolver, parity fixtures, and narrow tests.
 */
const RIDE_ALONG_PATTERNS: ReadonlyArray<(p: string) => boolean> = [
  (p) => p === "pnpm-lock.yaml",
  (p) => p.startsWith("work/"),
  (p) => p.startsWith("docs/"),
  (p) => p.startsWith(".claude/skills/"),
  (p) => p === ".github/workflows/ci.yaml",
  (p) => p === "packages/repo-spec/AGENTS.md",
  (p) => p === "packages/repo-spec/src/accessors.ts",
  (p) => p === "tests/ci-invariants/classify.ts",
  (p) => p.startsWith("tests/ci-invariants/fixtures/single-node-scope/"),
  (p) => p === "tests/ci-invariants/single-node-scope-meta.spec.ts",
  (p) => p === "tests/unit/packages/repo-spec/accessors.test.ts",
];

function isRideAlong(path: string): boolean {
  return RIDE_ALONG_PATTERNS.some((m) => m(path));
}

/**
 * NODE_BIRTH ride-along (bug.5086): a node may carry its OWN deploy wiring —
 * the operator-owned files that exist only to make `nodes/<node>/` deployable.
 * This lets a single welcome PR create + wire a node in one PR (the
 * CATALOG_IS_SSOT / create-node.md contract) without splitting node app from
 * its catalog/overlays/AppSet. Bounded to the node's OWN slug — a node PR
 * still cannot touch another node's catalog/overlay.
 *
 * RESIDUAL: the AppSet files are shared (one per env, not slug-pathed), so a
 * node-wiring PR could in principle also alter another node's generator block
 * in them. Tighten later via a content check or a glob-based AppSet (the per-
 * node `revision:` blocks are why they aren't a glob today). Reviewed at PR time.
 */
function isNodeWiring(path: string, node: string): boolean {
  if (node === "") return false;
  const overlayPrefix = "infra/k8s/overlays/";
  const argocdPrefix = "infra/k8s/argocd/";
  if (path.startsWith(overlayPrefix)) {
    const rest = path.slice(overlayPrefix.length);
    const slash = rest.indexOf("/");
    return slash > 0 && rest.slice(slash + 1).startsWith(`${node}/`);
  }
  if (path.startsWith(argocdPrefix)) {
    const file = path.slice(argocdPrefix.length);
    return (
      !file.includes("/") &&
      file.includes("applicationset") &&
      (file.endsWith(".yaml") || file.endsWith(".yml"))
    );
  }
  return path === `infra/catalog/${node}.yaml`;
}

/**
 * Classify a list of changed paths against the set of known non-operator nodes.
 * The rule:
 *   domain(path) = X         if path starts with `nodes/<X>/` for X in nonOperatorNodes
 *                = "operator" otherwise
 * Ride-along: if every operator-domain entry matches a RIDE_ALONG_PATTERNS
 * predicate and exactly one non-operator domain is also present, drop
 * "operator" from the set.
 */
export function classify(
  changedPaths: string[],
  nonOperatorNodes: string[]
): ClassifyResult {
  const nodes = new Set(nonOperatorNodes);
  const domains = new Set<Domain>();
  const operatorPaths: string[] = [];

  for (const p of changedPaths) {
    let assigned: Domain = OPERATOR_NODE;
    if (p.startsWith(NODES_PREFIX)) {
      const rest = p.slice(NODES_PREFIX.length);
      const slash = rest.indexOf("/");
      if (slash > 0) {
        const candidate = rest.slice(0, slash);
        if (nodes.has(candidate)) {
          assigned = candidate;
        }
      }
    }
    domains.add(assigned);
    if (assigned === OPERATOR_NODE) operatorPaths.push(p);
  }

  // The single non-operator node (if exactly one) — used for the NODE_BIRTH
  // wiring carve-out so a node may ride along its OWN catalog/overlays/AppSet.
  const nonOperator = [...domains].filter((d) => d !== OPERATOR_NODE);
  const theNode = nonOperator.length === 1 ? nonOperator[0] : "";

  let rideAlongApplied = false;
  if (
    domains.size === 2 &&
    domains.has(OPERATOR_NODE) &&
    operatorPaths.length > 0 &&
    operatorPaths.every((p) => isRideAlong(p) || isNodeWiring(p, theNode))
  ) {
    domains.delete(OPERATOR_NODE);
    rideAlongApplied = true;
  }

  const sorted = [...domains].sort();
  return {
    domains: sorted,
    pass: sorted.length <= 1,
    rideAlongApplied,
  };
}
