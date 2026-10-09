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
  NodeMigrationReportStorePort,
  RecordNodeMigrationReportInput,
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
  /** What the node's own migrator printed, when this fake is asked for a receipt. */
  receiptStdout: string | null = null;

  async ensure(input: ComputeWorkloadMigrationInput) {
    this.calls.push(input);
    if (this.throws) throw this.throws;
    return this.outcome;
  }

  async readReceipt() {
    return this.receiptStdout;
  }
}

/** Receipt-cell writer. Records what it was asked to key the cell on, and nothing else. */
class FakeReports implements NodeMigrationReportStorePort {
  readonly recorded: RecordNodeMigrationReportInput[] = [];

  async record(input: RecordNodeMigrationReportInput) {
    this.recorded.push(input);
    return "recorded" as const;
  }

  async read() {
    return null;
  }
}

/** The line the fork image's migrator prints on a successful migrate. */
const RECEIPT_STDOUT = [
  "migrate complete: 1 migration(s) applied + verified",
  `COGNI_MIGRATION_RECEIPT_V1 ${JSON.stringify({
    node: "toks9",
    declared: ["0000_init", "0001_next"],
    applied: [{ tag: "0000_init", hash: "abc", appliedAtMs: 1 }],
  })}`,
].join("\n");

/** The immutable node UUID the caller's own allocation receipt binds to this workload. */
const NODE_ID = "f66b260b-4633-41e2-8711-b7c1b8449cc1";

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

describe("runMigrationStep receipt collection", () => {
  it("keys the receipt cell on the RECEIPT-BOUND node id, never on the workload slug", async () => {
    // The whole bug. `record` used to be handed `nodeSlug` and resolve `node_id` by selecting
    // the operator's `nodes` registry — a table with ENABLE + FORCE row-level security and one
    // `tenant_isolation` policy keyed on `current_setting('app.current_user_id')`. The akash-tx
    // actuator holds the RLS-enforced app role and opens no tenant scope, so that select
    // SUCCEEDED and matched ZERO rows for every node in the fleet: production logged
    // `outcome: "node_not_registered"` with declaredCount 32 / appliedCount 32 / missingCount 0,
    // and `node_migration_reports` stayed empty. The cell key now arrives already resolved.
    const migration = new FakeMigration();
    migration.receiptStdout = RECEIPT_STDOUT;
    const reports = new FakeReports();
    const log = recordingLogger();

    await expect(
      runMigrationStep(
        { migration, reports, log },
        { ...INPUT, nodeId: NODE_ID, step: step() }
      )
    ).resolves.toBe("succeeded");

    expect(reports.recorded).toEqual([
      {
        nodeId: NODE_ID,
        environment: "candidate-a",
        declared: ["0000_init", "0001_next"],
        applied: [{ tag: "0000_init", hash: "abc", appliedAtMs: 1 }],
        bundleDigest: DIGEST,
        reporter: "migration-job",
      },
    ]);
    // Counts and enums only — a migration tag is row content and never reaches a log line.
    expect(
      log.lines.find(
        (line) => line.marker === "akash_tx_migration_receipt_recorded"
      )?.fields
    ).toMatchObject({
      outcome: "recorded",
      declaredCount: 2,
      appliedCount: 1,
      missingCount: 1,
    });
  });

  it("says the metadata did not land — and writes NOTHING — when no node id is bound yet", async () => {
    // A workload's very first observe precedes its first create, so the allocation receipt that
    // binds the node id may not exist yet. That is a FACT, not an error: the phase is still
    // `succeeded`, the write is skipped, and the next tick carries the metadata.
    const migration = new FakeMigration();
    migration.receiptStdout = RECEIPT_STDOUT;
    const reports = new FakeReports();
    const log = recordingLogger();

    await expect(
      runMigrationStep({ migration, reports, log }, { ...INPUT, step: step() })
    ).resolves.toBe("succeeded");

    expect(reports.recorded).toEqual([]);
    expect(log.lines.map((line) => line.marker)).toContain(
      "akash_tx_migration_receipt_unbound"
    );
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
