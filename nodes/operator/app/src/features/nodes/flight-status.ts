// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/nodes/flight-status`
 * Purpose: The substrate VERIFICATION GATE — prove a node is not just deployed but actually carries a
 *   real graph run, per node per env. Catches the "green-but-dead" silent-failure class (200-but-no-poller,
 *   stale Temporal routing, worker-401) that Argo health + /readyz cannot see.
 * Scope: Pure orchestration + host derivation. All I/O is injected via NodeProber (no fetch/db here).
 * Invariants:
 *   - RUNGS_ARE_ORDERED: serving precedes run-carries; a failed serving rung short-circuits run-carries
 *     (no chat probe against a 525 edge).
 *   - HOST_CONVENTION mirrors hostForNode() (resolve.ts) + the env→subdomain map (candidate-a→test).
 *   - NO_CLUSTER_AUTH: verification is external + Cogni-token only — never GH/kubectl/Argo creds.
 * Side-effects: none (prober injected)
 * Links: src/ports/node-flight.port.ts, src/shared/node-registry/resolve.ts, task.5021
 * @public
 */

import type {
  AssertLiveResult,
  EnvFlightStatus,
  FlightEnv,
  NodeFlightStatus,
  NodeProber,
  RunCarriesResult,
} from "@/ports";

/** The three deploy envs a node flights through. Mirrors RENDER_ENVS (node-app-scaffold/gens/appset.ts). */
export const FLIGHT_ENVS: readonly FlightEnv[] = [
  "candidate-a",
  "preview",
  "production",
];

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

const okRun = (s: string) => s === "pass" || s === "degraded";

/**
 * Fail-loud LIVENESS gate for ONE (node, env), proven by the two PUBLIC rungs: `serving` (`/readyz`)
 * and `run-carries` (a real graph run completes). A completed run transitively proves the substrate —
 * the scheduler-worker polled `scheduler-tasks-<nodeId>`, the `SCHEDULER_API_TOKEN` matched (no 401),
 * the graph ran, and the run was written — so the verdict needs no cluster/Grafana auth. `live` is true
 * iff serving passes AND the run carries (pass|degraded); a failed serving short-circuits run-carries.
 */
export async function assertLive(
  params: {
    readonly slug: string;
    readonly nodeId: string | undefined;
    readonly primary: boolean;
    readonly env: FlightEnv;
    readonly baseDomain: string;
  },
  prober: NodeProber
): Promise<AssertLiveResult> {
  const { slug, nodeId, primary, env, baseDomain } = params;
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

  const failures: string[] = [];
  if (serving.status !== "pass") failures.push(`serving:${serving.readyzCode}`);
  if (!okRun(runCarries.status))
    failures.push(`run-carries:${runCarries.detail}`);

  return {
    nodeId,
    slug,
    env,
    host,
    live: failures.length === 0,
    probes: { serving, runCarries },
    failures,
  };
}
