// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/compute/akash-tx/akash-tx-migration-step.test`
 * Purpose: Pin the RELEASE step that replaced the pre-transaction gate (task.5135) — every
 *   outcome is a PHASE and none of them throws, and the per-digest migration contract handed to
 *   the runner is still byte-identical to the one the frozen controller used.
 * Scope: Unit tests over a fake runner. Touches no Kubernetes API, no Akash Console, no DB.
 * Invariants: no outcome is silent; NO outcome is a refusal; the drift gate fails ONLY on a receipt
 *   that was read and names a declared tag the database does not hold (bug.5415).
 * Side-effects: none
 * Links: ./akash-tx-migration-step, bug.5116, bug.5140, bug.5415, task.5135
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
  /** The 403 class: the pod log exists but this process may not read it (#2638). */
  readReceiptThrows?: Error;

  async ensure(input: ComputeWorkloadMigrationInput) {
    this.calls.push(input);
    if (this.throws) throw this.throws;
    return this.outcome;
  }

  async readReceipt() {
    if (this.readReceiptThrows) throw this.readReceiptThrows;
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

/** What the fork image's migrator prints on a successful migrate. */
function receiptStdout(body: {
  readonly declared: readonly string[];
  readonly applied: readonly {
    readonly tag: string;
    readonly hash: string;
    readonly appliedAtMs: number;
  }[];
}): string {
  return [
    `migrate complete: ${body.applied.length} migration(s) applied + verified`,
    `COGNI_MIGRATION_RECEIPT_V1 ${JSON.stringify({ node: "toks9", ...body })}`,
  ].join("\n");
}

const APPLIED_INIT = { tag: "0000_init", hash: "abc", appliedAtMs: 1 };
const APPLIED_NEXT = { tag: "0001_next", hash: "def", appliedAtMs: 2 };

/** Declared == applied: the database holds exactly what the image ships. */
const RECEIPT_STDOUT = receiptStdout({
  declared: ["0000_init", "0001_next"],
  applied: [APPLIED_INIT, APPLIED_NEXT],
});

/**
 * poly/candidate-a, as the live readout found it (bug.5415): counts matched 85/85 while the SETS
 * diverged — one declared tag never arrived AND one ledger row the journal does not recognise.
 * Reduced to two migrations; the shape is what matters.
 */
const RECEIPT_STDOUT_MISSING = receiptStdout({
  declared: ["0000_init", "0001_next"],
  applied: [
    APPLIED_INIT,
    { tag: "unknown:1791098285556", hash: "", appliedAtMs: 2 },
  ],
});

/** `unexpected` ONLY: an image legitimately older than a row in its own ledger. Not a failure. */
const RECEIPT_STDOUT_UNEXPECTED_ONLY = receiptStdout({
  declared: ["0000_init"],
  applied: [
    APPLIED_INIT,
    { tag: "unknown:1791098285556", hash: "", appliedAtMs: 2 },
  ],
});

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
        applied: [APPLIED_INIT, APPLIED_NEXT],
        bundleDigest: DIGEST,
        reporter: "migration-job",
      },
    ]);
    expect(
      log.lines.find(
        (line) => line.marker === "akash_tx_migration_receipt_recorded"
      )?.fields
    ).toMatchObject({
      outcome: "recorded",
      declaredCount: 2,
      appliedCount: 2,
      missingCount: 0,
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

describe("runMigrationStep drift gate (bug.5415)", () => {
  /** The one failing condition: a receipt was READ and names a declared tag that did not arrive. */
  it("FAILS a succeeded Job when a declared migration did not arrive, and names it", async () => {
    const migration = new FakeMigration();
    migration.receiptStdout = RECEIPT_STDOUT_MISSING;
    const reports = new FakeReports();
    const log = recordingLogger();

    await expect(
      runMigrationStep(
        { migration, reports, log },
        { ...INPUT, nodeId: NODE_ID, step: step() }
      )
    ).resolves.toBe("failed");

    // Loud and greppable: its own marker, the missing tags, and which node/env/digest.
    const line = log.lines.find(
      (entry) => entry.marker === "akash_tx_migration_drift_missing"
    );
    expect(line?.level).toBe("error");
    expect(line?.fields).toMatchObject({
      workload: "toks9",
      environment: "candidate-a",
      bundleDigest: DIGEST,
      nodeId: NODE_ID,
      missing: ["0001_next"],
      missingCount: 1,
      unexpectedCount: 1,
    });
    // A ledger row the journal does not recognise is DATABASE content: counted, never named.
    expect(JSON.stringify(log.lines)).not.toContain("unknown:1791098285556");
    // Detection still reports: the readout must stay honest even though the step failed.
    expect(reports.recorded).toHaveLength(1);
  });

  it("does NOT fail on `unexpected` alone — it warns", async () => {
    const migration = new FakeMigration();
    migration.receiptStdout = RECEIPT_STDOUT_UNEXPECTED_ONLY;
    const reports = new FakeReports();
    const log = recordingLogger();

    await expect(
      runMigrationStep(
        { migration, reports, log },
        { ...INPUT, nodeId: NODE_ID, step: step() }
      )
    ).resolves.toBe("succeeded");

    const markers = log.lines.map((line) => line.marker);
    expect(markers).toContain("akash_tx_migration_drift_unexpected");
    expect(markers).not.toContain("akash_tx_migration_drift_missing");
    expect(
      log.lines.find(
        (line) => line.marker === "akash_tx_migration_drift_unexpected"
      )
    ).toMatchObject({ level: "warn", fields: { unexpectedCount: 1 } });
  });

  it("NEVER fails when nothing was ever reported — an unknown is not a verdict", async () => {
    // A node whose migrator image predates the receipt emitter prints no marker at all. There is
    // no drift to read, so there is no verdict, so the deploy proceeds. THE load-bearing property.
    const migration = new FakeMigration();
    migration.receiptStdout = "migrate complete: 0 migration(s) applied";
    const reports = new FakeReports();
    const log = recordingLogger();

    await expect(
      runMigrationStep(
        { migration, reports, log },
        { ...INPUT, nodeId: NODE_ID, step: step() }
      )
    ).resolves.toBe("succeeded");

    const markers = log.lines.map((line) => line.marker);
    expect(markers).toContain("akash_tx_migration_receipt_absent");
    expect(markers).not.toContain("akash_tx_migration_drift_missing");
    expect(reports.recorded).toEqual([]);
  });

  it("NEVER fails when the receipt log could not be READ (the 403 class)", async () => {
    // `readReceipt` answers null when no pod log could be fetched — the grant gap #2638 closed.
    // No receipt means no verdict; it is NOT a receipt reporting an empty applied set.
    const migration = new FakeMigration();
    migration.receiptStdout = null;
    const log = recordingLogger();

    await expect(
      runMigrationStep(
        { migration, reports: new FakeReports(), log },
        { ...INPUT, nodeId: NODE_ID, step: step() }
      )
    ).resolves.toBe("succeeded");
    expect(log.lines.map((line) => line.marker)).not.toContain(
      "akash_tx_migration_drift_missing"
    );
  });

  it("NEVER fails when the receipt read THROWS", async () => {
    const migration = new FakeMigration();
    migration.receiptStdout = RECEIPT_STDOUT_MISSING;
    migration.readReceiptThrows = new Error("forbidden");
    const log = recordingLogger();

    await expect(
      runMigrationStep(
        { migration, reports: new FakeReports(), log },
        { ...INPUT, nodeId: NODE_ID, step: step() }
      )
    ).resolves.toBe("succeeded");

    const markers = log.lines.map((line) => line.marker);
    expect(markers).toContain("akash_tx_migration_receipt_failed");
    expect(markers).not.toContain("akash_tx_migration_drift_missing");
  });

  it("NEVER fails on drift when no node id is bound yet", async () => {
    // Pre-create ticks have no allocation receipt to key the cell on, so the readout would say
    // `never_reported` — and the gate only fires on a REPORTED state.
    const migration = new FakeMigration();
    migration.receiptStdout = RECEIPT_STDOUT_MISSING;
    const log = recordingLogger();

    await expect(
      runMigrationStep(
        { migration, reports: new FakeReports(), log },
        { ...INPUT, step: step() }
      )
    ).resolves.toBe("succeeded");
    expect(log.lines.map((line) => line.marker)).not.toContain(
      "akash_tx_migration_drift_missing"
    );
  });

  it("NEVER fails on drift when no receipt store is wired at all", async () => {
    const migration = new FakeMigration();
    migration.receiptStdout = RECEIPT_STDOUT_MISSING;
    const log = recordingLogger();

    await expect(
      runMigrationStep(
        { migration, log },
        { ...INPUT, nodeId: NODE_ID, step: step() }
      )
    ).resolves.toBe("succeeded");
    expect(log.lines.map((line) => line.marker)).not.toContain(
      "akash_tx_migration_drift_missing"
    );
  });

  it("does not consult drift at all for a running or failed Job", async () => {
    const migration = new FakeMigration();
    migration.outcome = "running";
    migration.receiptStdout = RECEIPT_STDOUT_MISSING;
    const log = recordingLogger();

    await expect(
      runMigrationStep(
        { migration, reports: new FakeReports(), log },
        { ...INPUT, nodeId: NODE_ID, step: step() }
      )
    ).resolves.toBe("running");
    expect(log.lines.map((line) => line.marker)).not.toContain(
      "akash_tx_migration_drift_missing"
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
