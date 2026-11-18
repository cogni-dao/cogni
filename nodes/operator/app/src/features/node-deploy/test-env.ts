// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/test-env`
 * Purpose: Test envs on candidate-a (story.5159, `work/designs/test-env-v2.md`): a throwaway copy of a node's
 *   `app` at one SHA, on its own host, that never queues behind or supersedes another lane. A test env is one more
 *   desired row of the node whose workload key is `te<6 letters>`; its release spec is the node's declared `app`
 *   spec under that key and a sibling host `<slug>-<key>-test.<zone>`.
 * Scope: Pure derivations (key, spec, host, cap, slots, TTL, state) plus one read over `StorePort`. The writers
 *   stay where they were: `recordNodeRelease` records, `requestStop` stops, the sequencer drives.
 * Invariants:
 *   - ONE_KEY_SHAPE: a test env key is `isTestEnvKey` (`^te[a-z]{6}$`). A manifest may not declare such a name
 *     (`declarations.ts`), so a v1 POST can never name one (`workload_not_declared`) and a node cannot spoof one.
 *   - OWN_HOST_ONLY: the spec's host is `hostForEnv("<slug>-<key>.<zone>", "candidate-a")` and must pass the same
 *     `siblingLabel` + `hostOwnedBy` guard the sequencer applies, so a test env never holds the node's main host.
 *   - APP_COPY_ONLY: only a plain app is copied. A worker, a non-http app, an app with companions or with state
 *     bindings is refused: a bound state workload would be shared across envs.
 *   - CAP_FROM_THE_CATALOG: the cap is `catalog database.candidate-a.copies - APP_LANE_COPIES` (the app lane's
 *     live + spare), at most `MAX_TEST_ENVS_PER_NODE`. No `copies` means no test envs. The role caps that
 *     `copies` sizes are an operator-run provisioning input, not read here (bug.5637, tests/ci-invariants).
 *   - SLOTS_COUNT_OPEN_LEASES: a running te row counts, and so does a stopped one while an attempt of it is not
 *     terminal, because its lease still holds database connections.
 *   - TTL_STOPS_ONLY_TEST_ENVS: `expiredTestEnvs` never selects a row that is not a te key.
 * Side-effects: IO (read-only store port, in `testEnvSlots`)
 * Links: contracts/test-envs.v2.contract.ts, app/api/v2/test-envs/route.ts, edge.ts, stop-plan.ts,
 *   infra/catalog/_schema.json (`database.<env>.copies`), tests/ci-invariants/shared-db-budget-sum.spec.ts
 * @public
 */

import { randomInt } from "node:crypto";

import type { DeployReleaseState } from "@/contracts/deploy.workloads.v1.contract";
import {
  type AttemptRow,
  type DesiredRow,
  isTestEnvKey,
  type NodeWorkloadSpec,
  type StorePort,
} from "@/ports";
import type { WorkloadZoneBinding } from "@/shared/node-registry/fleet-ownership";

import { hostForEnv, hostOwnedBy, siblingLabel } from "./edge";
import { publicHostOf } from "./spec";
import { TERMINAL_ATTEMPT_PHASES } from "./stop-plan";

/** Test envs exist on one env only: the TEST operator's candidate-a. */
export const TEST_ENV_ENV = "candidate-a";
/** A test env closes this long after it was requested. */
export const TEST_ENV_TTL_MS = 4 * 3_600_000;
/** Copies the node's own `app` lane holds on the shared roles: one live plus one spare. */
export const APP_LANE_COPIES = 2;
/** Ceiling whatever the catalog says (more needs a bigger Postgres budget or a pooler, story.5166). */
export const MAX_TEST_ENVS_PER_NODE = 3;
/** The workload manifest every test env copies. */
export const TEST_ENV_SOURCE_WORKLOAD = "app";
/** Declared env var naming the optional label; non-secret and readable in the release spec. */
export const TEST_ENV_LABEL_ENV = "COGNI_TEST_ENV_LABEL";
export const TEST_ENV_LABEL_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

/** `te` + 6 random lowercase letters. The caller retries on a collision with an existing row. */
export function newTestEnvKey(pick: (max: number) => number = randomInt) {
  let key = "te";
  for (let i = 0; i < 6; i++) key += LETTERS[pick(LETTERS.length)];
  return key;
}

export class TestEnvRefusal extends Error {
  constructor(
    readonly code:
      | "test_env_unsupported"
      | "test_env_host_refused"
      | "test_env_node_refused",
    message: string
  ) {
    super(message);
    this.name = "TestEnvRefusal";
  }
}

/** The host a test env serves from: `<slug>-<key>-test.<zone>` (candidate-a adds `-test`). */
export function testEnvHost(
  slug: string,
  key: string,
  binding: WorkloadZoneBinding
): string {
  return hostForEnv(`${slug}-${key}.${binding.zoneName}`, TEST_ENV_ENV);
}

/**
 * The release spec of a test env: the node's resolved `app` spec under a new name and host. Throws
 * `TestEnvRefusal` for anything that is not a plain, stateless http app (APP_COPY_ONLY, OWN_HOST_ONLY).
 */
export function testEnvSpec(
  app: NodeWorkloadSpec,
  input: {
    readonly key: string;
    readonly slug: string;
    readonly binding: WorkloadZoneBinding;
    readonly label?: string | undefined;
  }
): NodeWorkloadSpec {
  const { key, slug, binding, label } = input;
  if (!isTestEnvKey(key))
    throw new TestEnvRefusal("test_env_unsupported", "not a test env key");
  if (slug === "operator")
    throw new TestEnvRefusal(
      "test_env_node_refused",
      "the operator's own lane has no test envs"
    );
  if (
    app.kind !== "app" ||
    app.runtimeProfile === "worker" ||
    publicHostOf(app) === undefined
  )
    throw new TestEnvRefusal(
      "test_env_unsupported",
      "a test env copies a plain http app"
    );
  if (app.bindings.length > 0 || (app.companions?.length ?? 0) > 0)
    throw new TestEnvRefusal(
      "test_env_unsupported",
      "an app with state bindings or companions cannot be copied: its state would be shared"
    );
  const host = testEnvHost(slug, key, binding);
  const sibling = siblingLabel({
    binding,
    host,
    env: TEST_ENV_ENV,
    slug,
    workload: key,
    worker: false,
  });
  if (
    sibling !== key ||
    !hostOwnedBy(binding, host, TEST_ENV_ENV, slug, sibling)
  )
    throw new TestEnvRefusal(
      "test_env_host_refused",
      "the derived host is not one this node may claim"
    );
  return {
    ...app,
    name: key,
    expose: { http: { host } },
    env: {
      ...app.env,
      ...(label !== undefined ? { [TEST_ENV_LABEL_ENV]: label } : {}),
    },
  };
}

/**
 * How many test envs a node may hold at once: the catalog's `database.<env>.copies` minus the app lane's own
 * copies, at most `MAX_TEST_ENVS_PER_NODE`. A row with no valid `copies` allows none.
 */
export function testEnvCap(catalogRow: unknown, env = TEST_ENV_ENV): number {
  const copies = (
    catalogRow as {
      database?: Record<string, { copies?: unknown } | undefined>;
    } | null
  )?.database?.[env]?.copies;
  if (typeof copies !== "number" || !Number.isInteger(copies)) return 0;
  return Math.max(
    0,
    Math.min(MAX_TEST_ENVS_PER_NODE, copies - APP_LANE_COPIES)
  );
}

const hasOpenLease = (attempts: readonly Pick<AttemptRow, "phase">[]) =>
  attempts.some((a) => !TERMINAL_ATTEMPT_PHASES.includes(a.phase));

/**
 * The test envs of one node that hold a slot, oldest first: every running te row, and every stopped te row
 * whose lease is still open (SLOTS_COUNT_OPEN_LEASES). The order (`updatedAt`, key) ranks racing requests.
 */
export async function testEnvSlots(
  store: Pick<StorePort, "listDesired" | "attemptsFor">,
  nodeId: string,
  env = TEST_ENV_ENV
): Promise<DesiredRow[]> {
  const rows = (await store.listDesired(env)).filter(
    (d) => d.nodeId === nodeId && d.env === env && isTestEnvKey(d.workload)
  );
  const held: DesiredRow[] = [];
  for (const row of rows)
    if (row.state === "running" || hasOpenLease(await store.attemptsFor(row)))
      held.push(row);
  return held.sort(
    (a, b) =>
      a.updatedAt.getTime() - b.updatedAt.getTime() ||
      a.workload.localeCompare(b.workload)
  );
}

/** Running te rows past their TTL. Never selects a row that is not a te key (TTL_STOPS_ONLY_TEST_ENVS). */
export function expiredTestEnvs(
  rows: readonly DesiredRow[],
  nowMs: number,
  ttlMs: number = TEST_ENV_TTL_MS
): DesiredRow[] {
  return rows.filter(
    (d) =>
      isTestEnvKey(d.workload) &&
      d.state === "running" &&
      nowMs - d.updatedAt.getTime() > ttlMs
  );
}

export type TestEnvState =
  | "requested"
  | "deploying"
  | "ready"
  | "failed"
  | "closing"
  | "closed";

/** The v2 state of a test env from the release view the v1 reads already use (no second state machine). */
export function testEnvState(input: {
  readonly desiredState: DesiredRow["state"];
  readonly releaseState: DeployReleaseState;
  readonly attempts: readonly Pick<AttemptRow, "phase">[];
}): TestEnvState {
  if (input.desiredState === "stopped")
    return hasOpenLease(input.attempts) ? "closing" : "closed";
  switch (input.releaseState) {
    case "queued":
      return "requested";
    case "active":
      return "ready";
    case "failed":
    case "parked":
      return "failed";
    default:
      return "deploying";
  }
}
