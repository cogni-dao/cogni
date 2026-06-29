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
 * - Exact fast-check devtools files: app Vitest source-resolution is repo
 *   tooling, but some legacy in-tree app config entrypoints are duplicated.
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

const DEVTOOLS_OPERATOR_PATTERNS: ReadonlyArray<(p: string) => boolean> = [
  (p) => p === ".github/workflows/ci.yaml",
  (p) => p === "docs/guides/new-worktree-setup.md",
  (p) => p === "nodes/operator/app/vitest.config.mts",
  (p) => p === "packages/langgraph-graphs/vitest.config.ts",
  (p) => p === "packages/repo-spec/AGENTS.md",
  (p) => p === "packages/repo-spec/src/accessors.ts",
  (p) => p === "scripts/AGENTS.md",
  (p) => p === "scripts/check-fast.sh",
  (p) => p === "scripts/run-scoped-package-build.mjs",
  (p) => p.startsWith("scripts/vitest/"),
  (p) => p === "scripts/worktree-check.sh",
  (p) => p === "tests/ci-invariants/classify.ts",
  (p) => p.startsWith("tests/ci-invariants/fixtures/single-node-scope/"),
  (p) => p === "tests/ci-invariants/single-node-scope-meta.spec.ts",
  (p) => p === "vitest.config.mts",
];

function isDevtoolsOperatorPath(path: string): boolean {
  return DEVTOOLS_OPERATOR_PATTERNS.some((m) => m(path));
}

function isRootAppVitestConfig(path: string, nonOperatorNodes: Set<string>) {
  const match = path.match(/^nodes\/([^/]+)\/app\/vitest\.config\.mts$/);
  const node = match?.[1];
  return Boolean(node && nonOperatorNodes.has(node));
}

/**
 * NODE_FORMATION ride-along (bug.5086): a node may carry its OWN deploy wiring —
 * the operator-owned files that exist only to make `nodes/<node>/` deployable.
 * This lets a single welcome PR create + wire a node in one PR (the
 * CATALOG_IS_SSOT / create-node.md contract) without splitting node app from
 * its catalog/overlays/AppSet. Bounded to the node's OWN slug — a node PR
 * still cannot touch another node's catalog/overlay.
 *
 * The AppSet files are now per-node (`<env>-<node>-applicationset.yaml`, one
 * object per (env, node) for LANE_ISOLATION), so a node-wiring PR can only touch
 * its OWN lane's AppSet — the prior shared-file residual is closed structurally.
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
    // Per-(env, node) AppSet now lives at appsets/<env>/<env>-<node>-applicationset.yaml
    // (story.5020 per-env app-of-apps). Node-scoped — a node PR may only touch its lane.
    const appsetsPrefix = "appsets/";
    const rest = path.slice(argocdPrefix.length);
    if (!rest.startsWith(appsetsPrefix)) return false;
    const afterEnv = rest.slice(appsetsPrefix.length);
    const slash = afterEnv.indexOf("/");
    if (slash <= 0) return false;
    const name = afterEnv.slice(slash + 1);
    return (
      !name.includes("/") &&
      (name.endsWith(`-${node}-applicationset.yaml`) ||
        name.endsWith(`-${node}-applicationset.yml`))
    );
  }
  // scheduler-worker configmap + edge Caddyfile.tmpl are both catalog-derived
  // regen artifacts (gen:scheduler-worker-endpoints / gen:caddyfile): a node
  // birth that adds a `type: node` catalog entry regenerates both, so they must
  // ride along the node's own welcome PR (bug.5086). Not slug-pathed (one shared
  // file each), so bounded by intent, not by path — reviewed at PR time.
  return (
    path === `infra/catalog/${node}.yaml` ||
    path === "infra/k8s/base/scheduler-worker/configmap.yaml" ||
    path === "infra/compose/edge/configs/Caddyfile.tmpl"
  );
}

/**
 * Classify a list of changed paths against the set of known non-operator nodes.
 * The rule:
 *   domain(path) = X         if path starts with `nodes/<X>/` for X in nonOperatorNodes
 *                = "operator" otherwise
 * Ride-along: if every operator-domain entry matches a RIDE_ALONG_PATTERNS
 * predicate and exactly one non-operator domain is also present, drop
 * "operator" from the set.
 *
 * NODE_RETIREMENT is intentionally NOT modeled here. Whether a node is "fully
 * retired" depends on git state (no tracked file left on HEAD), which this pure,
 * path-only classifier cannot observe. A pure retirement also drops the node
 * from the generated dorny filter (render-scope-filters.sh keys on surviving
 * nodes/*), so it collapses to operator-domain before classify is even reached.
 * The bash gate in ci.yaml owns the residual still-filtered-but-wholly-removed
 * case via `git ls-files`; see that step's NODE_RETIREMENT branch.
 */
export function classify(
  changedPaths: string[],
  nonOperatorNodes: string[]
): ClassifyResult {
  const nodes = new Set(nonOperatorNodes);
  const domains = new Set<Domain>();
  const operatorPaths: string[] = [];
  const nonOperatorPaths: string[] = [];

  for (const p of changedPaths) {
    let assigned: Domain = OPERATOR_NODE;
    if (p.startsWith(NODES_PREFIX)) {
      const rest = p.slice(NODES_PREFIX.length);
      const slash = rest.indexOf("/");
      // SUBMODULE_GITLINK_IS_OPERATOR_PIN (spec: node-ci-cd-contract): a bare
      // `nodes/<slug>` with NO trailing segment is a submodule gitlink — the
      // control plane's *pin*, not the node's code intent (the code was reviewed
      // in the node repo's own PR). `slash > 0` is false here, so it falls through
      // to operator-domain. Do NOT "fix" this to treat a bare path as node-domain:
      // a submodule birth PR (gitlink + its catalog/overlays/appset) must classify
      // as ONE operator domain, not be rejected as cross-domain. Only a real
      // in-tree node directory (`nodes/<slug>/...`) is node-domain.
      if (slash > 0) {
        const candidate = rest.slice(0, slash);
        if (nodes.has(candidate)) {
          assigned = candidate;
        }
      }
    }
    domains.add(assigned);
    if (assigned === OPERATOR_NODE) {
      operatorPaths.push(p);
    } else {
      nonOperatorPaths.push(p);
    }
  }

  // The single non-operator node (if exactly one) — used for the NODE_FORMATION
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

  if (
    domains.size > 1 &&
    domains.has(OPERATOR_NODE) &&
    nonOperatorPaths.length > 0 &&
    nonOperatorPaths.every((p) => isRootAppVitestConfig(p, nodes)) &&
    operatorPaths.every((p) => isDevtoolsOperatorPath(p))
  ) {
    domains.clear();
    domains.add(OPERATOR_NODE);
    rideAlongApplied = true;
  }

  const sorted = [...domains].sort();
  return {
    domains: sorted,
    pass: sorted.length <= 1,
    rideAlongApplied,
  };
}
