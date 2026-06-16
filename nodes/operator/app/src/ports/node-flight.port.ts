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

/** Injected I/O. Implemented by an adapter that does real fetch against the node's public surface. */
export interface NodeProber {
  /** GET https://<host>/readyz + /version. */
  serving(host: string): Promise<ServingResult>;
  /** Register a throwaway agent, run the free `poet` graph, read back the run count. */
  runCarries(host: string): Promise<RunCarriesResult>;
}
