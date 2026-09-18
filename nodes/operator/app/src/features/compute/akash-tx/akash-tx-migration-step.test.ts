// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/compute/akash-tx/akash-tx-migration-step.test`
 * Purpose: Pin the RELEASE step that replaced the pre-transaction gate (task.5135) — every
 *   outcome is a PHASE and none of them throws, and the per-digest migration contract handed to
 *   the runner is still byte-identical to the one the frozen controller used.
 * Scope: Unit tests over a fake runner. Touches no Kubernetes API, no Akash Console, no DB.
 * Invariants: no outcome is silent; NO outcome is a refusal.
 * Side-effects: none
 * Links: ./akash-tx-migration-step, bug.5116, bug.5140, task.5135
 * @internal
 */

import { describe, expect, it } from "vitest";

import type {
  AkashTxMigrationPort,
  AkashTxMigrationStep,
  ComputeWorkloadMigrationInput,
} from "@/ports";

import type { AkashTxLogger } from "./akash-tx-actuator";
import {
  cogniNodeAppMigrationPhases,
  runMigrationStep,
} from "./akash-tx-migration-step";

const DIGEST = `sha256:${"c".repeat(64)}`;
const IMAGE = `ghcr.io/cogni-dao/toks9@sha256:${"d".repeat(64)}`;

function step(
  overrides: Partial<AkashTxMigrationStep> = {}
): AkashTxMigrationStep {
  return {
    profile: "cogni-node-app-v1",
    bundleDigest: DIGEST,
    image: IMAGE,
    doltgres: false,
    ...overrides,
  };
}

class FakeMigration implements AkashTxMigrationPort {
  calls: ComputeWorkloadMigrationInput[] = [];
  outcome: "succeeded" | "running" | "failed" = "succeeded";
  throws?: Error;

  async ensure(input: ComputeWorkloadMigrationInput) {
    this.calls.push(input);
    if (this.throws) throw this.throws;
    return this.outcome;
  }
}

function recordingLogger(): AkashTxLogger & {
  lines: { level: string; marker: string; fields: Record<string, unknown> }[];
} {
  const lines: {
    level: string;
    marker: string;
    fields: Record<string, unknown>;
  }[] = [];
  return {
    lines,
    info: (fields, marker) => lines.push({ level: "info", marker, fields }),
    warn: (fields, marker) => lines.push({ level: "warn", marker, fields }),
    error: (fields, marker) => lines.push({ level: "error", marker, fields }),
  };
}

const INPUT = {
  cogniKey: "xcw:cogni-candidate-a:node-uuid:0",
  environment: "candidate-a",
  workload: "toks9",
};

describe("runMigrationStep", () => {
  it("reports a succeeded digest and says so", async () => {
    const migration = new FakeMigration();
    const log = recordingLogger();

    await expect(
      runMigrationStep({ migration, log }, { ...INPUT, step: step() })
    ).resolves.toBe("succeeded");

    expect(migration.calls).toHaveLength(1);
    expect(log.lines.map((line) => line.marker)).toContain(
      "akash_tx_migration_succeeded"
    );
  });

  it("hands the runner the SAME per-digest contract the legacy controller used", async () => {
    const migration = new FakeMigration();
    await runMigrationStep(
      { migration, log: recordingLogger() },
      { ...INPUT, step: step({ doltgres: true }) }
    );

    expect(migration.calls[0]).toEqual({
      nodeSlug: "toks9",
      environment: "candidate-a",
      bundleDigest: DIGEST,
      image: IMAGE,
      // Derived, never sent on the wire: a secret NAME the Job references by key.
      secretName: "toks9-compute-env-secrets",
      // ...and the namespace that name resolves in. Both derived from the WORKLOAD (task.5132).
      namespace: "cogni-candidate-a",
      phases: cogniNodeAppMigrationPhases({ doltgres: true }),
    });
  });

  it("ENVIRONMENT_IS_THE_WORKLOAD'S: the secret and slug come from the workload, not the actuator", async () => {
    // A candidate-a workload must migrate candidate-a's database. The runner is told which
    // workload and which environment; it never substitutes its own deployment's identity.
    const migration = new FakeMigration();
    await runMigrationStep(
      { migration, log: recordingLogger() },
      { ...INPUT, environment: "production", workload: "toks5", step: step() }
    );

    expect(migration.calls[0]).toMatchObject({
      nodeSlug: "toks5",
      environment: "production",
      secretName: "toks5-compute-env-secrets",
      namespace: "cogni-production",
    });
  });

  it("states the LANE's namespace when this actuator custodies a foreign lane (task.5132)", async () => {
    // The receipt-vs-database bug in one assertion. This process runs in cogni-production and
    // pays for poly's candidate-a lane; `poly-compute-env-secrets` exists in BOTH namespaces and
    // names a DIFFERENT database in each (`cogni_poly` vs `cogni_poly_candidate_a`, bug.5207).
    // Leaving the namespace to the actuator's own migrated production's database and then left a
    // receipt the lane read as proof of its own — an empty DB behind a `succeeded` phase.
    const migration = new FakeMigration();
    await runMigrationStep(
      { migration, log: recordingLogger() },
      { ...INPUT, environment: "candidate-a", workload: "poly", step: step() }
    );

    expect(migration.calls[0]).toMatchObject({
      nodeSlug: "poly",
      environment: "candidate-a",
      secretName: "poly-compute-env-secrets",
      namespace: "cogni-candidate-a",
    });
  });

  it("reports a running migration WITHOUT throwing (task.5135)", async () => {
    // This is the falsifiable heart of the change. The pre-task.5135 gate threw
    // `migration_pending` here, which is what stopped toks5's lease from ever being created.
    const migration = new FakeMigration();
    migration.outcome = "running";
    const log = recordingLogger();

    await expect(
      runMigrationStep({ migration, log }, { ...INPUT, step: step() })
    ).resolves.toBe("running");

    // bug.5115: the log line exists and carries the digest the workload is waiting on.
    expect(log.lines).toEqual([
      {
        level: "info",
        marker: "akash_tx_migration_running",
        fields: expect.objectContaining({
          bundleDigest: DIGEST,
          workload: "toks9",
          cogniKey: INPUT.cogniKey,
        }),
      },
    ]);
  });

  it("reports a failed migration WITHOUT throwing, and loudly", async () => {
    const migration = new FakeMigration();
    migration.outcome = "failed";
    const log = recordingLogger();

    await expect(
      runMigrationStep({ migration, log }, { ...INPUT, step: step() })
    ).resolves.toBe("failed");
    expect(log.lines.map((line) => line.marker)).toEqual([
      "akash_tx_migration_failed",
    ]);
  });

  it("reports `unavailable` when it cannot determine the state either way", async () => {
    const migration = new FakeMigration();
    migration.throws = new Error("kube-apiserver unreachable");
    const log = recordingLogger();

    await expect(
      runMigrationStep({ migration, log }, { ...INPUT, step: step() })
    ).resolves.toBe("unavailable");
    expect(log.lines[0]).toMatchObject({
      marker: "akash_tx_migration_unavailable",
      fields: expect.objectContaining({
        causeMessage: "kube-apiserver unreachable",
      }),
    });
  });

  it("reports `unavailable` — never throws — when no runner is wired at all", async () => {
    // An actuator with no migration capability used to refuse EVERY paid transaction. It now
    // says so and lets the lease exist; readiness is what will notice the missing schema.
    const log = recordingLogger();

    await expect(
      runMigrationStep({ log }, { ...INPUT, step: step() })
    ).resolves.toBe("unavailable");
    expect(log.lines.map((line) => line.marker)).toEqual([
      "akash_tx_migration_capability_missing",
    ]);
  });
});

describe("cogniNodeAppMigrationPhases", () => {
  it("pins the fork-image migrator contract", () => {
    // Twin of the frozen reconciler's private cogniNodeAppMigrationPhases(). Changing either
    // without the other silently un-migrates a lane, so the strings are pinned here.
    expect(cogniNodeAppMigrationPhases({ doltgres: false })).toEqual([
      {
        name: "migrate",
        command: [
          "/bin/sh",
          "-c",
          "exec node /app/app/migrate.mjs /app/app/migrations",
        ],
        databaseUrlSecretKey: "DATABASE_URL",
      },
    ]);
  });

  it("adds the Doltgres phase only when the workload declares that database", () => {
    expect(cogniNodeAppMigrationPhases({ doltgres: true })[1]).toEqual({
      name: "migrate-doltgres",
      command: [
        "/bin/sh",
        "-c",
        "exec node /app/app/migrate-doltgres.mjs /app/app/doltgres-migrations",
      ],
      databaseUrlSecretKey: "DOLTGRES_URL",
    });
  });
});
