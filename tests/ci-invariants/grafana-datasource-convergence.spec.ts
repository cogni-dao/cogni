// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/grafana-datasource-convergence`
 * Purpose: Prove the Grafana Postgres datasource provisioner converges on the catalog-derived set rather than only ever creating, and that its prune cannot reach past that set.
 * Scope: Runs the real provision and verify scripts against a PATH-injected `curl` shim backed by a JSON file; does not reach the network, Grafana, or Postgres.
 * Invariants:
 *   - DECLARED_SET_IS_THE_WHOLE_SET: a `cogni-<env>-*-postgres` datasource outside the
 *     catalog-derived roster is deleted, not left to rot.
 *   - PRUNE_SCOPE_IS_NARROW: other environments and non-Postgres datasources are never touched.
 *   - EMPTY_ROSTER_NEVER_PRUNES: an empty derived set aborts instead of deleting everything.
 *   - HTTP_200_IS_NOT_SUCCESS: the verify layer fails when a 200 envelope carries the
 *     datasource's own error (SQLSTATE 28P01), not just when the status code is non-200.
 * Side-effects: IO (mktemp sandbox; spawns bash)
 * Links: bug.5117, docs/spec/cicd-platform-boundary.md, infra/grafana/AGENTS.md
 * @public
 *
 * WHY THIS EXISTS. Measured 2026-10-08: 55 live Grafana Postgres datasources against a
 * catalog-derived set of 21, and ~420 `FATAL: password authentication failed for user
 * "app_readonly"` per hour on the production Postgres — every one of them from a datasource
 * outside the roster, retried forever on Grafana's own schedule. The provisioner declared
 * state correctly and still drifted, because it only ever created or updated: nothing in the
 * repo ever enumerated what already existed, so nothing could delete. The 28P01 stream was the
 * bill for that, and it was dense enough to manufacture a false crash-causation story first.
 *
 * WHY TYPESCRIPT AND NOT A BASH TEST. Same reason as `alloy-config-parses.spec.ts`: adding
 * `scripts/ci/run-shell-tests.sh` to the diff would make the PR undispatchable through the
 * compose-lane gate, which refuses a review containing any non-lane path.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../..");
const PROVISION = path.join(
  REPO_ROOT,
  "scripts/ci/provision-grafana-postgres-datasources.sh"
);
const VERIFY = path.join(
  REPO_ROOT,
  "scripts/ci/verify-grafana-postgres-datasources.sh"
);
const SHIM = path.join(__dirname, "fixtures/grafana-api-curl-shim.sh");

const ENV_UNDER_TEST = "production";

interface Datasource {
  readonly uid: string;
  readonly type: string;
}

/** A sandbox with the `curl` shim first on PATH and a seeded datasource store. */
function sandbox(seed: readonly Datasource[]) {
  const root = mkdtempSync(path.join(tmpdir(), "grafana-converge-"));
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  execFileSync("cp", [SHIM, path.join(bin, "curl")]);
  execFileSync("chmod", ["+x", path.join(bin, "curl")]);

  const state = path.join(root, "state.json");
  const log = path.join(root, "requests.log");
  writeFileSync(state, JSON.stringify(seed));
  writeFileSync(log, "");

  const run = (
    script: string,
    extraEnv: Record<string, string> = {}
  ): { readonly status: number; readonly output: string } => {
    try {
      const output = execFileSync("bash", [script], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          SHIM_STATE: state,
          SHIM_LOG: log,
          DEPLOY_ENVIRONMENT: ENV_UNDER_TEST,
          POSTGRES_ROOT_PASSWORD: "test-root-password",
          GRAFANA_URL: "http://fake-grafana",
          GRAFANA_SERVICE_ACCOUNT_TOKEN: "glsa_test_token",
          GRAFANA_PDC_NETWORK_UUID: "00000000-0000-0000-0000-000000000000",
          GRAFANA_VERIFY_ATTEMPTS: "1",
          GRAFANA_VERIFY_BACKOFF_SECONDS: "0",
          ...extraEnv,
        },
      });
      return { status: 0, output };
    } catch (error) {
      const e = error as { status?: number; stdout?: string; stderr?: string };
      return {
        status: e.status ?? 1,
        output: `${e.stdout ?? ""}${e.stderr ?? ""}`,
      };
    }
  };

  return {
    run,
    uids: (): readonly string[] =>
      (JSON.parse(readFileSync(state, "utf8")) as Datasource[]).map(
        (d) => d.uid
      ),
    requests: (): readonly string[] =>
      readFileSync(log, "utf8").split("\n").filter(Boolean),
  };
}

const postgres = (uid: string): Datasource => ({
  uid,
  type: "grafana-postgresql-datasource",
});

/** The roster the provisioner derives, read from the catalog the same way it does. */
function derivedUids(): readonly string[] {
  const csv = execFileSync(
    "bash",
    [
      "-c",
      `source "${REPO_ROOT}/scripts/ci/lib/image-tags.sh" >/dev/null 2>&1 && node_database_csv`,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        COGNI_CATALOG_ROOT: path.join(REPO_ROOT, "infra/catalog"),
      },
    }
  ).trim();
  return csv
    .split(",")
    .map((db) => db.trim())
    .filter(Boolean)
    .map(
      (db) => `cogni-${ENV_UNDER_TEST}-${db.replace(/^cogni_/, "")}-postgres`
    );
}

describe("grafana postgres datasource convergence (bug.5117)", () => {
  it("DECLARED_SET_IS_THE_WHOLE_SET: prunes rostered-no-more datasources", () => {
    const intended = derivedUids();
    expect(intended.length).toBeGreaterThan(0);

    const ghosts = [
      `cogni-${ENV_UNDER_TEST}-ayo-postgres`,
      `cogni-${ENV_UNDER_TEST}-trash-postgres`,
      // toks4's database is still alive on the host; it is a prune target because
      // it left the catalog, not because its database vanished.
      `cogni-${ENV_UNDER_TEST}-toks4-postgres`,
    ];
    const box = sandbox([...intended, ...ghosts].map(postgres));

    const result = box.run(PROVISION);
    expect(result.output).toContain("converged");
    expect(result.status).toBe(0);

    const after = box.uids();
    for (const ghost of ghosts) expect(after).not.toContain(ghost);
    for (const uid of intended) expect(after).toContain(uid);
    expect([...after].sort()).toStrictEqual([...intended].sort());
  });

  it("PRUNE_SCOPE_IS_NARROW: never touches another env or a non-Postgres datasource", () => {
    const untouchable: readonly Datasource[] = [
      { uid: "grafanacloud-logs", type: "loki" },
      { uid: "grafanacloud-prom", type: "prometheus" },
      // A Postgres datasource for a DIFFERENT environment, which this run does not own.
      postgres("cogni-candidate-a-ayo-postgres"),
      postgres("cogni-preview-ayo-postgres"),
      // Shape-adjacent but not ours: no `cogni-<env>-` prefix.
      postgres("handmade-production-scratch-postgres"),
    ];
    const box = sandbox([
      ...derivedUids().map(postgres),
      ...untouchable,
      postgres(`cogni-${ENV_UNDER_TEST}-ayo-postgres`),
    ]);

    expect(box.run(PROVISION).status).toBe(0);

    const after = box.uids();
    for (const ds of untouchable) expect(after).toContain(ds.uid);
    expect(after).not.toContain(`cogni-${ENV_UNDER_TEST}-ayo-postgres`);
  });

  it("EMPTY_ROSTER_NEVER_PRUNES: an empty derived set aborts instead of deleting everything", () => {
    const seeded = [
      ...derivedUids(),
      `cogni-${ENV_UNDER_TEST}-ayo-postgres`,
    ].map(postgres);
    const box = sandbox(seeded);
    const emptyCatalog = mkdtempSync(path.join(tmpdir(), "empty-catalog-"));

    const result = box.run(PROVISION, { COGNI_CATALOG_ROOT: emptyCatalog });

    expect(result.status).not.toBe(0);
    expect(box.requests().some((r) => r.startsWith("DELETE"))).toBe(false);
    expect(box.uids().length).toBe(seeded.length);
  });

  it("GRAFANA_DATASOURCE_PRUNE=0 reports what it would delete without deleting", () => {
    const ghost = `cogni-${ENV_UNDER_TEST}-ayo-postgres`;
    const box = sandbox([...derivedUids().map(postgres), postgres(ghost)]);

    const result = box.run(PROVISION, { GRAFANA_DATASOURCE_PRUNE: "0" });

    expect(result.status).toBe(0);
    expect(result.output).toContain(`would prune ${ghost}`);
    expect(box.requests().some((r) => r.startsWith("DELETE"))).toBe(false);
    expect(box.uids()).toContain(ghost);
  });

  it("HTTP_200_IS_NOT_SUCCESS: verify fails on a 200 envelope carrying a 28P01", () => {
    const box = sandbox(derivedUids().map(postgres));

    const healthy = box.run(VERIFY);
    expect(healthy.status).toBe(0);
    expect(healthy.output).toContain("all datasources verified");

    const drifted = box.run(VERIFY, {
      SHIM_DS_QUERY_CODE: "200",
      SHIM_DS_QUERY_BODY: JSON.stringify({
        results: {
          A: {
            error:
              'db query error: failed SASL auth: FATAL: password authentication failed for user "app_readonly" (SQLSTATE 28P01)',
            frames: [],
          },
        },
      }),
    });
    expect(drifted.status).not.toBe(0);
    expect(drifted.output).toContain("28P01");
  });
});
