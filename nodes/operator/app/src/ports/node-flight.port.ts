// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/node-flight`
 * Purpose: Contract + data types for the substrate VERIFICATION GATE — probe a node's public surface
 *   to prove it serves AND carries a real graph run, per env. Implemented by an adapter; consumed by
 *   the flight-status feature. No implementation here.
 * Scope: Types + the NodeProber port only. No I/O.
 * Side-effects: none
 * Links: src/features/nodes/flight-status.ts, src/adapters/server/node-flight/node-prober.adapter.ts, task.5021
 * @public
 */

/** The three deploy envs a node flights through. */
export type FlightEnv = "candidate-a" | "preview" | "production";

/** A single rung verdict. `skip` = an upstream rung failed so this one was not probed. */
export type RungStatus = "pass" | "degraded" | "fail" | "skip";

/** serving: the node answers /readyz 200 and exposes a /version buildSha. */
export interface ServingResult {
  readonly status: RungStatus;
  readonly readyzCode: number;
  readonly buildSha: string | null;
}

/**
 * run-carries: a freshly-registered agent's graph completion actually produces a run.
 * `pass` = run created AND a normal completion. `degraded` = run created but the completion errored
 * DOWNSTREAM of creation (e.g. insufficient_quota) — the substrate carried the run, the failure moved
 * past it. `fail` = no run created (hang / no Temporal poller / worker-401).
 */
export interface RunCarriesResult {
  readonly status: RungStatus;
  readonly durationMs: number;
  readonly runs: number;
  /** human-readable: "poem", "insufficient_quota", "hang:no-run", "register-failed", … */
  readonly detail: string;
}

export interface EnvFlightStatus {
  readonly env: FlightEnv;
  readonly host: string;
  readonly serving: ServingResult;
  readonly runCarries: RunCarriesResult;
}

export interface NodeFlightStatus {
  readonly nodeId: string;
  readonly slug: string;
  readonly envs: readonly EnvFlightStatus[];
  /** true iff EVERY env carries a run (degraded counts — the substrate works, billing is separate). */
  readonly allEnvsCarry: boolean;
}

/**
 * A node's SELF-DESCRIBED display identity, read from its public
 * `/.well-known/agent.json` `identity` block (a projection of its own repo-spec
 * `intent`). The operator holds ZERO per-node identity literals — every gallery
 * card's title/tagline/thumbnail/color comes from THIS, so a node customizes
 * itself by editing its repo-spec, never operator code.
 *
 * `brand.thumbnail` is the ABSOLUTE URL the prober resolved (the node publishes a
 * host-relative path like `/showcase/x.png`; the prober joins it against the
 * node's own host so it loads per-env). `null` for any field a node has not yet
 * declared — a fork that has not projected identity yields no `identity` block at
 * all (the prober returns `null` for the whole identity, and the gallery falls
 * back to a titleCase(slug) monogram).
 */
export interface NodeIdentity {
  // 1-1 with repo-spec `intent.name` — the field is `name` in repo-spec, in the well-known projection,
  // and here (NO split-brain). It is the node's canonical handle (== the addressing slug).
  readonly name: string;
  readonly hook: string | null;
  readonly mission: string | null;
  readonly brand: {
    /** Lucide icon NAME (PascalCase) — the SSOT for the node's gallery mark, or null. */
    readonly icon: string | null;
    /** Absolute, host-resolved thumbnail URL, or null when undeclared. */
    readonly thumbnail: string | null;
    readonly color: string | null;
  };
}

/** Injected I/O. The adapter exercises a node's PUBLIC surface only — no cluster/GH/Grafana auth. */
export interface NodeProber {
  /** GET https://<host>/readyz + /version. */
  serving(host: string): Promise<ServingResult>;
  /** Register a throwaway agent, run the free `poet` graph, read back the run count. */
  runCarries(host: string): Promise<RunCarriesResult>;
  /**
   * GET https://<host>/.well-known/agent.json and return its `identity` block,
   * Zod-parsed defensively. Returns `null` when the host is unreachable OR when the
   * document carries no (valid) `identity` block — e.g. a fork that has not yet
   * projected its repo-spec intent. `brand.thumbnail` is resolved to an absolute URL
   * against `https://<host>`.
   */
  identity(host: string): Promise<NodeIdentity | null>;
}

/** The two PUBLIC live rungs for one node in one env. */
export interface LiveProbes {
  readonly serving: ServingResult;
  readonly runCarries: RunCarriesResult;
}

/**
 * Fail-loud liveness verdict for one (node, env). `live` is true ONLY when serving passes AND the run
 * carries (pass|degraded). Both rungs are PUBLIC — a completed run transitively proves the substrate
 * (worker polled the queue, token matched, run written), so no Grafana token is needed for the verdict.
 */
export interface AssertLiveResult {
  readonly nodeId: string | undefined;
  readonly slug: string;
  readonly env: FlightEnv;
  readonly host: string;
  readonly live: boolean;
  readonly probes: LiveProbes;
  readonly failures: readonly string[];
}
