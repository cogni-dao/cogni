// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/nodes/flight-status`
 * Purpose: The substrate VERIFICATION GATE — prove a node is not just deployed but actually carries a
 *   real graph run, per node per env. Catches the "green-but-dead" silent-failure class (200-but-no-poller,
 *   stale Temporal routing, worker-401) that Argo health + /readyz cannot see.
 * Scope: Pure orchestration + host derivation. All I/O is injected via NodeProber (no fetch/db here).
 * Invariants:
 *   - RUNGS_ARE_ORDERED: serving precedes run-carries precedes logs-in-loki; a failed rung short-circuits
 *     the rungs that depend on it (no run-carries probe against a 525 edge).
 *   - HOST_CONVENTION mirrors hostForNode() (resolve.ts) + the env→subdomain map (candidate-a→test).
 *   - NO_CLUSTER_AUTH: verification is external + Cogni-token only — never GH/kubectl/Argo creds.
 * Side-effects: none (prober injected)
 * Links: src/shared/node-registry/resolve.ts, task.5021, docs/guides/agent-api-validation.md
 * @public
 */

/** The three deploy envs a node flights through. Mirrors RENDER_ENVS (node-app-scaffold/gens/appset.ts). */
export const FLIGHT_ENVS = ["candidate-a", "preview", "production"] as const;
export type FlightEnv = (typeof FLIGHT_ENVS)[number];

/** candidate-a serves at `<host>-test`, preview at `<host>-preview`, production bare. */
const ENV_SUBDOMAIN: Record<FlightEnv, string> = {
  "candidate-a": "test",
  preview: "preview",
  production: "",
};

/**
 * Derive the public host a node serves at, per env. Primary node (operator) serves the env apex
 * (test./preview./bare); others prefix the slug (`<slug>-test.<base>`, prod `<slug>.<base>`).
 */
export function hostForEnv(
  slug: string,
  primary: boolean,
  env: FlightEnv,
  baseDomain: string
): string {
  const sub = ENV_SUBDOMAIN[env];
  if (primary) return sub ? `${sub}.${baseDomain}` : baseDomain;
  return sub ? `${slug}-${sub}.${baseDomain}` : `${slug}.${baseDomain}`;
}

/**
 * The verifier probes ALL envs (test./preview./bare), so it needs the ROOT zone, not the operator's
 * own env apex. Strip a leading env subdomain: `test.cognidao.org` / `preview.cognidao.org` → `cognidao.org`.
 */
export function rootDomain(apex: string): string {
  return apex.replace(/^(test|preview)\./, "");
}

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
 * `pass` = run created AND a normal completion (poem/text). `degraded` = run created but the
 * completion errored DOWNSTREAM of run-creation (e.g. insufficient_quota) — the substrate carried
 * the run, the failure moved past it. `fail` = no run created (hang / no Temporal poller / worker-401).
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

/**
 * Verify a node's flight status across all envs. Pure orchestration: derive hosts, run the ordered
 * rungs via the injected prober, and short-circuit run-carries when serving fails (don't probe chat
 * against a dead/edge-broken host).
 */
export async function verifyFlightStatus(
  params: {
    readonly nodeId: string;
    readonly slug: string;
    readonly primary: boolean;
    readonly baseDomain: string;
  },
  prober: NodeProber
): Promise<NodeFlightStatus> {
  const { nodeId, slug, primary, baseDomain } = params;

  const envs = await Promise.all(
    FLIGHT_ENVS.map(async (env): Promise<EnvFlightStatus> => {
      const host = hostForEnv(slug, primary, env, baseDomain);
      const serving = await prober.serving(host);
      const runCarries: RunCarriesResult =
        serving.status === "pass"
          ? await prober.runCarries(host)
          : {
              status: "skip",
              durationMs: 0,
              runs: 0,
              detail: `skipped:serving-${serving.status}`,
            };
      return { env, host, serving, runCarries };
    })
  );

  const allEnvsCarry = envs.every(
    (e) => e.runCarries.status === "pass" || e.runCarries.status === "degraded"
  );

  return { nodeId, slug, envs, allEnvsCarry };
}
