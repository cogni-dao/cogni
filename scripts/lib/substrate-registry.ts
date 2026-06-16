// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO
/**
 * Module: `@scripts/lib/substrate-registry`
 * Purpose: Typed SSOT + contract for a node's deploy substrate dependencies.
 *   Declares what substrate a node needs, how each piece is reconciled, and how a
 *   flight proves it live — the control-plane half of substrate-completeness
 *   (story.5006 / task.5023). It pairs every reconcile with a matching live
 *   assertion so the two can never drift: you cannot register a dependency without
 *   declaring how a flight proves it usable.
 * Scope: Pure typed data + invariants. Does NOT shell out, SSH, or mutate any VM /
 *   cluster / git state. Reconcile EXECUTION lives where it idiomatically belongs
 *   (a declarative manifest, an in-lane script, or a CI script); this registry
 *   CATALOGS each one and owns the assertion seam. Live assertions are implemented
 *   by dev2 (Move 2) against this same registry.
 * Invariants:
 *   - TWO SCOPES. `leaf` = per-node state (this node's DB/roles/ExternalSecret, its
 *     edge route entry); reconciled once per node, failure is node-local.
 *     `env-singleton` = an env-global service whose desired state is a function of
 *     the node SET (scheduler-worker routing, the shared edge Caddy, observability
 *     scrape). A node-add changes its desired state, so it MUST be re-reconciled on
 *     every node flight — "affected-only" governs IMAGE BUILDS, never substrate.
 *   - THE SEAM. Every dependency declares BOTH `reconcile` and `assertLive`.
 *     assertLive starts as a fail-closed stub (throws) so a done-gate can never go
 *     green on an unverified reconcile. dev2 replaces the stub body; the gate then
 *     proves the live end state.
 *   - Names are unique; validateRegistry() runs at module load and fails loud.
 * Side-effects: none (validateRegistry throws on a malformed registry at import).
 * Links: docs/spec/node-baas-architecture.md, scripts/ci/reconcile-node-substrate.sh,
 *   scripts/ci/render-scheduler-worker-endpoints.sh,
 *   scripts/ci/reconcile-scheduler-worker-routing.sh (env-singleton deploy-branch propagation),
 *   infra/k8s/base/scheduler-worker/deployment.yaml (reloader annotation),
 *   knowledge: substrate-completeness-scorecard
 * @public
 */

export type SubstrateScope = "leaf" | "env-singleton";

/** Where a dependency's reconcile is actually implemented. The registry catalogs
 *  the mechanism; it never re-implements VM/cluster ops in TS. */
export type ReconcileMechanism =
  | "declarative" // a manifest/Argo/Reloader fact; the platform converges it
  | "lane-script" // run by the per-node flight lane (run-node-substrate.sh chain)
  | "ci-script"; // run from the CI runner (has GitHub-side secrets)

export interface ReconcileSpec {
  readonly mechanism: ReconcileMechanism;
  /** The file / annotation that performs the reconcile (the durable owner). */
  readonly owner: string;
  /** One line: what it does + any known gap a flight must still close. */
  readonly note: string;
}

/** Context a live assertion gets: which deployed env + node it must prove. */
export interface AssertLiveContext {
  readonly env: string; // candidate-a | preview | production
  readonly node: string; // catalog node name (e.g. beacon)
  readonly nodeId?: string; // repo-spec UUID, when the probe needs it
}

export interface AssertLiveResult {
  readonly ok: boolean;
  readonly detail: string;
}

/** A live end-state probe against the real deploy. Implemented by dev2 (Move 2). */
export type AssertLiveFn = (
  ctx: AssertLiveContext
) => Promise<AssertLiveResult>;

/** Marks an assertLive that is still a fail-closed stub (so the gate + tests can
 *  see what remains unimplemented without calling it). */
export type StubbableAssertLiveFn = AssertLiveFn & { readonly isStub?: true };

export interface SubstrateDependency {
  readonly name: string;
  readonly scope: SubstrateScope;
  /** Tracking ref(s) for the gap this dependency closes, when applicable. */
  readonly bug?: string;
  readonly description: string;
  readonly reconcile: ReconcileSpec;
  readonly assertLive: StubbableAssertLiveFn;
}

/** Thrown by every stubbed assertLive. The done-gate (dev2) treats this as a hard
 *  fail-closed: an unverified reconcile can NEVER be reported as deploy_verified. */
export class SubstrateAssertLiveNotImplementedError extends Error {
  constructor(
    public readonly dependency: string,
    public readonly ctx: AssertLiveContext
  ) {
    super(
      `substrate assertLive not implemented for '${dependency}' (env=${ctx.env} node=${ctx.node}) — fail-closed by contract (Move 2 / dev2)`
    );
    this.name = "SubstrateAssertLiveNotImplementedError";
  }
}

/** Build a fail-closed assertLive stub. NEVER soften this to resolve ok:true — that
 *  silently reopens the reconcile/assert drift the registry exists to close. dev2
 *  replaces the whole field with a real probe. */
function stubAssertLive(name: string): StubbableAssertLiveFn {
  const fn: StubbableAssertLiveFn = async (ctx: AssertLiveContext) => {
    throw new SubstrateAssertLiveNotImplementedError(name, ctx);
  };
  (fn as { isStub?: true }).isStub = true;
  return fn;
}

/**
 * THE REGISTRY. Adding a substrate = add one entry here (+ its reconcile owner +,
 * eventually, its real assertLive). The seam is enforced by substrate-registry.test.ts.
 */
export const SUBSTRATE_DEPENDENCIES: readonly SubstrateDependency[] = [
  {
    name: "node-db",
    scope: "leaf",
    description:
      "Per-node Postgres database cogni_<node> + app_/service_ roles, owned + RLS-scoped.",
    reconcile: {
      mechanism: "lane-script",
      owner: "scripts/ci/reconcile-node-substrate.sh (db-provision)",
      note: "Node-scoped via -e COGNI_NODE_DBS; per-node role passwords read from OpenBao (Inv15).",
    },
    assertLive: stubAssertLive("node-db"),
  },
  {
    name: "knowledge-db",
    scope: "leaf",
    bug: "bug.5033",
    description:
      "Per-node Doltgres database knowledge_<node> on the shared doltgres server.",
    reconcile: {
      mechanism: "lane-script",
      owner: "scripts/ci/reconcile-node-substrate.sh (doltgres-provision)",
      note: "FIX: doltgres-provision now node-scoped via -e COGNI_NODE_DBS=<node_db>, symmetric with db-provision — was env-file-only behind a silently-skippable gate, leaving the DB absent → node-app Init:CrashLoopBackOff. Superuser cred is OpenBao operator SSOT (DOLTGRES_PASSWORD), fail-loud if absent.",
    },
    assertLive: stubAssertLive("knowledge-db"),
  },
  {
    name: "edge-route",
    scope: "env-singleton",
    bug: "bug.5031",
    description:
      "The flighted node's route on the shared edge Caddy (host → node service).",
    reconcile: {
      mechanism: "lane-script",
      owner:
        "scripts/ci/reconcile-node-substrate.sh + scripts/ci/reconcile-edge-caddy.remote.sh",
      note: "Hash-gated reload+verify of the running Caddy config (#1697) — a no-op when unchanged so sibling flights don't bounce the shared edge.",
    },
    assertLive: stubAssertLive("edge-route"),
  },
  {
    name: "scheduler-worker-routing",
    scope: "env-singleton",
    bug: "bug.5035/bug.5021",
    description:
      "The scheduler-worker must poll one Temporal task queue per node, driven by COGNI_NODE_ENDPOINTS in the catalog-rendered ConfigMap. Absent → graph /chat/completions hangs.",
    reconcile: {
      mechanism: "ci-script",
      owner: "scripts/ci/reconcile-scheduler-worker-routing.sh",
      note: "TWO HALVES, both now wired (task.5026). DELIVERY: a per-env-singleton flight job propagates the catalog-rendered base/scheduler-worker (env-invariant, gated against catalog by render-scheduler-worker-endpoints.sh --check) onto deploy/<env>-scheduler-worker — the branch the worker's Argo app actually syncs, which a node-add never refreshed before (this was the manual heal). ROLL: base/scheduler-worker/deployment.yaml carries reloader.stakater.com/auto (#1609), so Argo syncing the changed ConfigMap auto-rolls the worker. Idempotent (no-op when the routing CSV is unchanged); the env overlay's pinned digest is never touched. assertLive proves the worker actually polls the new node's queue (a graph run completes).",
    },
    assertLive: stubAssertLive("scheduler-worker-routing"),
  },
  {
    name: "observability-scrape",
    scope: "env-singleton",
    bug: "bug.5035",
    description:
      "The flighted node's data is queryable: pods scraped into Loki, per-node DB exposed as a Grafana datasource.",
    reconcile: {
      mechanism: "ci-script",
      owner: "scripts/ci/provision-grafana-postgres-datasources.sh",
      note: "Loki scrapes the env namespace cogni-<env> (env-scoped — auto-covers every node's pods). The per-node Postgres datasource is provisioned from CI (has the Grafana + readonly creds). Wiring this into the per-node flight is the remaining reconcile work.",
    },
    assertLive: stubAssertLive("observability-scrape"),
  },
] as const;

// ── Helpers (the typed orchestration surface the lane + the done-gate consume) ──

export function getDependency(name: string): SubstrateDependency | undefined {
  return SUBSTRATE_DEPENDENCIES.find((d) => d.name === name);
}

export function dependenciesByScope(
  scope: SubstrateScope
): readonly SubstrateDependency[] {
  return SUBSTRATE_DEPENDENCIES.filter((d) => d.scope === scope);
}

export const leafDependencies = (): readonly SubstrateDependency[] =>
  dependenciesByScope("leaf");

export const envSingletonDependencies = (): readonly SubstrateDependency[] =>
  dependenciesByScope("env-singleton");

/** The dependencies whose live assertion is still a fail-closed stub. dev2's gate
 *  uses this to report exactly what remains unproven (and to refuse green). */
export function stubbedAssertions(): readonly SubstrateDependency[] {
  return SUBSTRATE_DEPENDENCIES.filter((d) => d.assertLive.isStub === true);
}

/** Fail-loud structural validation, run at import (mirrors secrets-catalog-loader). */
export function validateRegistry(
  deps: readonly SubstrateDependency[] = SUBSTRATE_DEPENDENCIES
): void {
  const scopes: readonly SubstrateScope[] = ["leaf", "env-singleton"];
  const mechanisms: readonly ReconcileMechanism[] = [
    "declarative",
    "lane-script",
    "ci-script",
  ];
  const seen = new Set<string>();
  for (const d of deps) {
    if (!d.name) throw new Error("substrate-registry: dependency missing name");
    if (seen.has(d.name))
      throw new Error(`substrate-registry: duplicate dependency '${d.name}'`);
    seen.add(d.name);
    if (!scopes.includes(d.scope))
      throw new Error(
        `substrate-registry: '${d.name}' has invalid scope '${d.scope}'`
      );
    if (!d.reconcile || !mechanisms.includes(d.reconcile.mechanism))
      throw new Error(
        `substrate-registry: '${d.name}' has invalid reconcile.mechanism`
      );
    if (!d.reconcile.owner || !d.reconcile.note)
      throw new Error(
        `substrate-registry: '${d.name}' reconcile must declare owner + note`
      );
    if (typeof d.assertLive !== "function")
      throw new Error(
        `substrate-registry: '${d.name}' must declare an assertLive (stub or real)`
      );
  }
}

validateRegistry();
