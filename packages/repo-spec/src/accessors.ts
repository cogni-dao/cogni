// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/repo-spec/accessors`
 * Purpose: Pure typed accessor functions that extract specific config sections from a parsed RepoSpec.
 * Scope: Maps raw YAML structures to app-friendly typed objects. Chain ID is always a parameter, not imported from app code.
 * Invariants: REPO_SPEC_AUTHORITY, NO_CROSS_IMPORTS. All functions are pure — no I/O, no caching, no side effects.
 * Side-effects: none
 * Links: .cogni/repo-spec.yaml, docs/spec/node-operator-contract.md
 * @public
 */

import type {
  GateConfig,
  NodeRegistryEntry,
  OperatorWalletSpec,
  RepoSpec,
} from "./schema.js";

// ---------------------------------------------------------------------------
// Accessor result types
// ---------------------------------------------------------------------------

export interface GovernanceSchedule {
  charter: string;
  cron: string;
  timezone: string;
  entrypoint: string;
}

export interface LedgerPoolConfig {
  baseIssuanceCredits: bigint;
}

export interface LedgerConfig {
  scopeId: string;
  scopeKey: string;
  epochLengthDays: number;
  activitySources: Record<
    string,
    {
      attributionPipeline: string;
      sourceRefs: string[];
      excludedLogins?: string[];
    }
  >;
  poolConfig: LedgerPoolConfig;
  /** base_issuance_credits as string (bigint serialized) for schedule payload. */
  baseIssuanceCredits?: string;
  /** EVM approver addresses from repo-spec. */
  approvers?: string[];
}

export interface GovernanceConfig {
  schedules: GovernanceSchedule[];
  ledger?: LedgerConfig;
}

export interface InboundPaymentConfig {
  chainId: number;
  receivingAddress: string;
  provider: string;
}

// ---------------------------------------------------------------------------
// Identity accessors
// ---------------------------------------------------------------------------

/** Extract node_id from parsed repo-spec. */
export function extractNodeId(spec: RepoSpec): string {
  return spec.node_id;
}

/**
 * Extract scope_id from parsed repo-spec.
 * Throws if scope_id is not present (required for ledger scope gating).
 */
export function extractScopeId(spec: RepoSpec): string {
  if (!spec.scope_id) {
    throw new Error(
      "[repo-spec] Missing scope_id — required for ledger scope gating"
    );
  }
  return spec.scope_id;
}

/**
 * Extract numeric chain_id from cogni_dao section.
 * Handles both string and number representations from YAML.
 */
export function extractChainId(spec: RepoSpec): number {
  const raw = spec.cogni_dao.chain_id;
  const chainId = typeof raw === "string" ? Number(raw) : raw;

  if (!Number.isFinite(chainId)) {
    throw new Error(
      "[repo-spec] Invalid cogni_dao.chain_id; expected numeric chain ID"
    );
  }

  return chainId;
}

// ---------------------------------------------------------------------------
// Config section accessors
// ---------------------------------------------------------------------------

/**
 * Extract and validate inbound payment config.
 * Chain ID is passed as parameter (not imported from app code) and validated against repo-spec's declared chain.
 */
export function extractPaymentConfig(
  spec: RepoSpec,
  expectedChainId: number
): InboundPaymentConfig | undefined {
  if (!spec.payments_in?.credits_topup) return undefined;

  const chainId = extractChainId(spec);

  if (chainId !== expectedChainId) {
    throw new Error(
      `[repo-spec] Chain mismatch: repo-spec declares ${chainId}, app requires ${expectedChainId}`
    );
  }

  const topup = spec.payments_in.credits_topup;

  return {
    chainId,
    receivingAddress: topup.receiving_address.trim(),
    provider: topup.provider.trim(),
  };
}

/** Charter that routes a schedule to CollectEpochWorkflow (epoch ingest/roll). */
const LEDGER_INGEST_CHARTER = "LEDGER_INGEST";
/**
 * Cron for the synthesized ledger-ingest schedule. Daily — the cron controls how often
 * collection runs, NOT the epoch length (the window is derived from epoch_length_days by
 * CollectEpochWorkflow). Daily ingest + timely roll at window boundaries.
 */
const LEDGER_INGEST_CRON = "0 0 * * *";

/**
 * Extract governance config including schedules and optional ledger config.
 * Ledger config is only included when activity_ledger + scope identity are both present.
 *
 * When an activity ledger is configured but no LEDGER_INGEST charter is declared, a
 * ledger-ingest schedule is SYNTHESIZED from activity_ledger. This makes any node with an
 * activity ledger self-sufficient for epochs — no separate `governance.schedules` entry to
 * declare or keep in sync with `epoch_length_days`.
 */
export function extractGovernanceConfig(spec: RepoSpec): GovernanceConfig {
  const declared = spec.governance?.schedules ?? [];
  const ledger = extractLedgerConfig(spec);

  const schedules = [...declared];
  const hasLedgerSchedule = declared.some(
    (s) => s.charter.toUpperCase() === LEDGER_INGEST_CHARTER
  );
  if (ledger && !hasLedgerSchedule) {
    schedules.push({
      charter: LEDGER_INGEST_CHARTER,
      cron: LEDGER_INGEST_CRON,
      timezone: "UTC",
      entrypoint: LEDGER_INGEST_CHARTER,
    });
  }

  const config: GovernanceConfig = { schedules };
  if (ledger) {
    config.ledger = ledger;
  }

  return config;
}

/**
 * Extract ledger config from repo-spec.
 * Returns null if activity_ledger or scope identity (scope_id + scope_key) is missing.
 */
export function extractLedgerConfig(spec: RepoSpec): LedgerConfig | null {
  if (!spec.activity_ledger || !spec.scope_id || !spec.scope_key) {
    return null;
  }

  const sources: LedgerConfig["activitySources"] = {};
  for (const [name, src] of Object.entries(
    spec.activity_ledger.activity_sources
  )) {
    sources[name] = {
      attributionPipeline: src.attribution_pipeline,
      sourceRefs: src.source_refs,
      excludedLogins: src.excluded_logins,
    };
  }

  const poolCfg = spec.activity_ledger.pool_config;
  const baseIssuanceCredits = poolCfg
    ? BigInt(poolCfg.base_issuance_credits)
    : 0n;

  return {
    scopeId: spec.scope_id,
    scopeKey: spec.scope_key,
    epochLengthDays: spec.activity_ledger.epoch_length_days,
    activitySources: sources,
    poolConfig: {
      baseIssuanceCredits,
    },
    baseIssuanceCredits: baseIssuanceCredits.toString(),
    approvers: spec.activity_ledger.approvers,
  };
}

/**
 * Extract ledger approver allowlist from repo-spec.
 * Returns lowercased EVM addresses for case-insensitive comparison.
 * Returns empty array if ledger config is not present.
 */
export function extractLedgerApprovers(spec: RepoSpec): string[] {
  return (spec.activity_ledger?.approvers ?? []).map((a) => a.toLowerCase());
}

// ---------------------------------------------------------------------------
// Gate config accessors
// ---------------------------------------------------------------------------

export interface GatesConfig {
  gates: GateConfig[];
  failOnError: boolean;
}

/**
 * Extract gates configuration from parsed repo-spec.
 * Returns empty gates array if no gates are configured.
 */
export function extractGatesConfig(spec: RepoSpec): GatesConfig {
  return {
    gates: spec.gates ?? [],
    failOnError: spec.fail_on_error ?? false,
  };
}

// ---------------------------------------------------------------------------
// DAO config
// ---------------------------------------------------------------------------

export interface DaoConfig {
  readonly dao_contract: string;
  readonly plugin_contract: string;
  readonly signal_contract: string;
  readonly chain_id: string;
  readonly base_url: string;
}

/**
 * Extract DAO governance configuration from parsed repo-spec.
 * Returns null if cogni_dao is missing or any required field is absent.
 * All five fields (dao_contract, plugin_contract, signal_contract, chain_id, base_url)
 * must be present for the config to be valid.
 */
export function extractDaoConfig(spec: RepoSpec): DaoConfig | null {
  const dao = spec.cogni_dao;
  if (
    !dao?.dao_contract ||
    !dao.plugin_contract ||
    !dao.signal_contract ||
    !dao.chain_id ||
    !dao.base_url
  ) {
    return null;
  }

  return {
    dao_contract: dao.dao_contract,
    plugin_contract: dao.plugin_contract,
    signal_contract: dao.signal_contract,
    chain_id: String(dao.chain_id),
    base_url: dao.base_url,
  };
}

/**
 * Extract operator wallet config from repo-spec.
 * Returns undefined if operator_wallet section is not present.
 */
export function extractOperatorWalletConfig(
  spec: RepoSpec
): OperatorWalletSpec | undefined {
  return spec.operator_wallet;
}

/**
 * Extract DAO treasury address from repo-spec.
 * Returns undefined if cogni_dao.dao_contract is not present.
 */
export function extractDaoTreasuryAddress(spec: RepoSpec): string | undefined {
  return spec.cogni_dao.dao_contract;
}

// ---------------------------------------------------------------------------
// Node registry accessors (operator-only)
// ---------------------------------------------------------------------------

/**
 * Extract node registry from operator repo-spec.
 * Returns empty array if nodes[] is not present (non-operator repo-specs).
 */
export function extractNodes(spec: RepoSpec): readonly NodeRegistryEntry[] {
  return spec.nodes ?? [];
}

/**
 * Resolve a node UUID to its relative path declared in the operator's nodes[] registry.
 *
 * Returns null if the registry has no entry for nodeId (caller decides fallback policy).
 * Empty/missing nodes[] → always null.
 *
 * Duplicate-tolerance: if multiple entries share the same node_id, the first match wins
 * (registry uniqueness is not this function's job; tighten via schema refinement upstream).
 *
 * Path safety: returns the path string from the registry verbatim — no normalization,
 * no traversal sanitization. The caller MUST validate before joining to a filesystem
 * root (e.g., reject paths containing "..", absolute paths, or null bytes).
 */
export function extractNodePath(spec: RepoSpec, nodeId: string): string | null {
  const entry = (spec.nodes ?? []).find((n) => n.node_id === nodeId);
  return entry?.path ?? null;
}

// ---------------------------------------------------------------------------
// Owning-node resolution (paths → owning domain)
// ---------------------------------------------------------------------------

/**
 * Discriminated outcome of `extractOwningNode`. The reviewer dispatches on `kind`:
 *
 * - `single`   — exactly one domain owns every path. When `nodeId` is the operator,
 *                this is an "operator-only" PR — `nodes/operator/**` ∪ `packages/**` ∪
 *                `.github/**` ∪ `docs/**` ∪ root configs are all the operator's territory.
 *                `rideAlongApplied: true` flags a bounded carve-out where operator-domain
 *                paths matching the ride-along whitelist (`pnpm-lock.yaml`, `work/**`,
 *                `docs/**`, `.claude/skills/poly-dev-manager/SKILL.md`) tagged
 *                along a single non-operator node PR.
 * - `conflict` — two or more domains touched. Refuse to review (post diagnostic).
 * - `miss`     — empty input. The reviewer surfaces a no-op neutral check.
 *
 * Mirrors `tests/ci-invariants/classify.ts` (the CI gate's reference classifier);
 * locked by `tests/ci-invariants/single-node-scope-parity.spec.ts`.
 */
export type OwningNode =
  | {
      kind: "single";
      nodeId: string;
      path: string;
      rideAlongApplied?: true;
    }
  | {
      kind: "conflict";
      nodes: ReadonlyArray<{ nodeId: string; path: string }>;
      /**
       * Operator-territory paths in the changed-file set, populated when the
       * operator node is one of the conflicting domains. Empty array when
       * operator is not involved in the conflict. Lets the diagnostic-comment
       * formatter show contributors which paths triggered the operator domain
       * match — see docs/spec/node-ci-cd-contract.md § Diagnostic contract.
       */
      operatorPaths: readonly string[];
      /** nodeId of the operator entry when operator is one of the conflicting domains, else undefined. */
      operatorNodeId?: string;
    }
  | { kind: "miss" };

const OPERATOR_TOP = "operator";
const NODES_PREFIX = "nodes/";

/**
 * Operator-domain paths that may ride along a single non-operator node PR.
 * Mirrors `tests/ci-invariants/classify.ts` `RIDE_ALONG_PATTERNS`. Adding to
 * this list weakens the gate; do so deliberately and only for mechanical
 * side-effects or cross-cutting node intent that hasn't yet been migrated out
 * of operator territory.
 *
 * - `pnpm-lock.yaml`: mechanical side-effect of node-level package.json edits.
 * - `work/**`: per-task work items, projects, charters; high merge-conflict +
 *   index-regen churn. Ride-along until task tracking moves to Dolt.
 * - `docs/**`: cross-cutting prose updates that accompany a node change.
 * - `.claude/skills/**`: agent-facing skill docs that codify the principle a
 *   node-scoped fix demonstrates; treated like docs/ — prose riding along
 *   with the implementing code.
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

function isRideAlong(p: string): boolean {
  return RIDE_ALONG_PATTERNS.some((m) => m(p));
}

/**
 * NODE_BIRTH ride-along: a node may carry its OWN deploy wiring — the
 * operator-owned files that exist only to make `nodes/<node>/` deployable.
 * Keep this in parity with `tests/ci-invariants/classify.ts` and the
 * `single-node-scope` bash gate.
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

/** Top-level segment under `nodes/`, or null if the path is not under `nodes/<x>/`. */
function topUnderNodes(p: string): string | null {
  if (!p.startsWith(NODES_PREFIX)) return null;
  const rest = p.slice(NODES_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  return rest.slice(0, slash);
}

/**
 * Resolve which domain owns a set of changed paths. Pure — no I/O, no env, no logging.
 * Implements `SINGLE_DOMAIN_HARD_FAIL` from
 * `docs/spec/node-ci-cd-contract.md § Single-Domain Scope`:
 *
 * - `domain(path) = X`         if path starts with `nodes/<X>/` for X in non-operator registry entries
 * - `domain(path) = operator`  otherwise (includes `nodes/operator/**`, `packages/`, `.github/`, etc.)
 *
 * Aggregation:
 * - empty input → `miss` (CI passes; the reviewer has nothing to dispatch on)
 * - exactly one distinct domain → `single`
 * - two or more → `conflict` (sorted by `nodeId.localeCompare`)
 *
 * `RIDE_ALONG` exception: when domains is exactly `{operator, X}` and every operator-domain
 * path matches the ride-along whitelist (`pnpm-lock.yaml`, `work/**`, `docs/**`,
 * `.claude/skills/poly-dev-manager/SKILL.md`), drop operator →
 * `single { X, rideAlongApplied: true }`.
 *
 * Path safety: paths are consumed verbatim — no `..` rejection. Same boundary as `extractNodePath`.
 *
 * Registry mirror invariant: per the spec, `spec.nodes` mirrors the `nodes/*` filesystem
 * listing (meta-test enforces both directions). Paths under an unregistered `nodes/<x>/`
 * fall through to the operator-domain default — matching the bash gate. The meta-test
 * catches the underlying registry/filesystem drift; this function does not defend against it.
 */
export function extractOwningNode(
  spec: RepoSpec,
  paths: readonly string[]
): OwningNode {
  if (paths.length === 0) return { kind: "miss" };

  const registry = spec.nodes ?? [];
  const operatorEntry = registry.find(
    (e) => topUnderNodes(`${e.path}/`) === OPERATOR_TOP
  );

  // Index non-operator registry entries by their top-level segment under nodes/.
  const nonOperatorByTop = new Map<string, NodeRegistryEntry>();
  for (const e of registry) {
    if (e === operatorEntry) continue;
    const top = topUnderNodes(`${e.path}/`);
    if (top != null) nonOperatorByTop.set(top, e);
  }

  const sovereigns = new Map<string, { nodeId: string; path: string }>();
  const operatorPaths: string[] = [];

  for (const p of paths) {
    const top = topUnderNodes(p);
    const sov = top != null ? nonOperatorByTop.get(top) : undefined;
    if (sov) {
      sovereigns.set(sov.node_id, { nodeId: sov.node_id, path: sov.path });
    } else {
      operatorPaths.push(p);
    }
  }

  // Ride-along exception: drop operator from a 2-domain {operator, X} diff
  // when EVERY operator-domain path matches the ride-along whitelist or X's
  // own deploy wiring.
  let rideAlongApplied = false;
  let operatorTouched = operatorPaths.length > 0;
  const [onlySovereign] = sovereigns.values();
  const sovereignTop =
    onlySovereign != null ? topUnderNodes(`${onlySovereign.path}/`) : null;
  if (
    sovereigns.size === 1 &&
    operatorPaths.length > 0 &&
    sovereignTop != null &&
    operatorPaths.every((p) => isRideAlong(p) || isNodeWiring(p, sovereignTop))
  ) {
    operatorTouched = false;
    rideAlongApplied = true;
  }

  const totalDomains = sovereigns.size + (operatorTouched ? 1 : 0);

  if (totalDomains === 1) {
    if (sovereigns.size === 1) {
      const [only] = sovereigns.values();
      const owner = only as { nodeId: string; path: string };
      return rideAlongApplied
        ? {
            kind: "single",
            nodeId: owner.nodeId,
            path: owner.path,
            rideAlongApplied: true,
          }
        : { kind: "single", nodeId: owner.nodeId, path: owner.path };
    }
    // Operator-only PR. Requires the operator to be in the registry.
    if (!operatorEntry) {
      throw new Error(
        "[repo-spec] extractOwningNode: operator entry missing from nodes registry; meta-test invariant violated"
      );
    }
    return {
      kind: "single",
      nodeId: operatorEntry.node_id,
      path: operatorEntry.path,
    };
  }

  // totalDomains >= 2 → conflict
  const all: Array<{ nodeId: string; path: string }> = [];
  if (operatorTouched && operatorEntry) {
    all.push({ nodeId: operatorEntry.node_id, path: operatorEntry.path });
  }
  for (const s of sovereigns.values()) all.push(s);
  all.sort((a, b) => a.nodeId.localeCompare(b.nodeId));
  return {
    kind: "conflict",
    nodes: all,
    operatorPaths: operatorTouched ? operatorPaths : [],
    ...(operatorTouched && operatorEntry
      ? { operatorNodeId: operatorEntry.node_id }
      : {}),
  };
}

/**
 * Resolve the rule-file directory for a `single`-kind owning domain.
 * Pure — no I/O. The single source of truth for "where does this node's
 * `.cogni/rules/` live"; routing code (e.g. `fetchPrContextActivity`) must
 * call this rather than build paths inline.
 *
 * Returns `<owningNode.path>/.cogni/rules` for every domain — operator and
 * sovereign nodes alike. There is no special-case branch; per the
 * node-ci-cd-contract principle, routing code never special-cases a
 * particular node.
 *
 * Throws on `conflict` / `miss` — callers should branch on `kind` first.
 */
export function resolveRulePath(owningNode: OwningNode): string {
  if (owningNode.kind !== "single") {
    throw new Error(
      `[repo-spec] resolveRulePath: only valid for kind=single, got ${owningNode.kind}`
    );
  }
  return `${owningNode.path}/.cogni/rules`;
}
