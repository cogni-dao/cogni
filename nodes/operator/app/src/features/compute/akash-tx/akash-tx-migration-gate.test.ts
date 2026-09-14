// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/compute/akash-tx/akash-tx-migration-gate.test`
 * Purpose: Pin the gate that makes bug.5116's ordering structural for a Crossplane-reconciled
 *   workload (bug.5140) — only a PROVEN migration passes, every other outcome refuses, and the
 *   per-digest migration contract handed to the prover is byte-identical to the one the frozen
 *   controller used.
 * Scope: Unit tests over a fake prover. Touches no Kubernetes API, no Akash Console, no DB.
 * Invariants: no refusal is silent; no unproven state is treated as proven.
 * Side-effects: none
 * Links: ./akash-tx-migration-gate, bug.5116, bug.5140
 * @internal
 */

import { describe, expect, it } from "vitest";

import type {
  AkashTxMigrationPort,
  AkashTxMigrationRequirement,
  ComputeWorkloadMigrationInput,
} from "@/ports";
import { AkashTxError } from "@/ports";

import type { AkashTxLogger } from "./akash-tx-actuator";
import {
  cogniNodeAppMigrationPhases,
  enforceMigrationGate,
} from "./akash-tx-migration-gate";

const DIGEST = `sha256:${"c".repeat(64)}`;
const IMAGE = `ghcr.io/cogni-dao/toks9@sha256:${"d".repeat(64)}`;

function requirement(
  overrides: Partial<
    Extract<AkashTxMigrationRequirement, { policy: "RequireBeforeTransaction" }>
  > = {}
): AkashTxMigrationRequirement {
  return {
    policy: "RequireBeforeTransaction",
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
  operation: "create" as const,
  cogniKey: "xcw:cogni-candidate-a:node-uuid:0",
  environment: "candidate-a",
  workload: "toks9",
};

describe("enforceMigrationGate", () => {
  it("passes a proven digest and says so", async () => {
    const migration = new FakeMigration();
    const log = recordingLogger();

    await expect(
      enforceMigrationGate(
        { migration, log },
        { ...INPUT, requirement: requirement() }
      )
    ).resolves.toBeUndefined();

    expect(migration.calls).toHaveLength(1);
    expect(log.lines.map((line) => line.marker)).toContain(
      "akash_tx_migration_proven"
    );
  });

  it("hands the prover the SAME per-digest contract the legacy controller used", async () => {
    const migration = new FakeMigration();
    await enforceMigrationGate(
      { migration, log: recordingLogger() },
      { ...INPUT, requirement: requirement({ doltgres: true }) }
    );

    expect(migration.calls[0]).toEqual({
      nodeSlug: "toks9",
      environment: "candidate-a",
      bundleDigest: DIGEST,
      image: IMAGE,
      // Derived, never sent on the wire: a secret NAME the Job references by key.
      secretName: "toks9-compute-env-secrets",
      phases: cogniNodeAppMigrationPhases({ doltgres: true }),
    });
  });

  it("refuses a running migration with a retryable code, before it answers", async () => {
    const migration = new FakeMigration();
    migration.outcome = "running";
    const log = recordingLogger();

    await expect(
      enforceMigrationGate(
        { migration, log },
        { ...INPUT, requirement: requirement() }
      )
    ).rejects.toMatchObject({ code: "migration_pending" });

    // bug.5115: the log line exists and carries the digest that is holding the workload up.
    expect(log.lines).toEqual([
      {
        level: "warn",
        marker: "akash_tx_migration_pending",
        fields: expect.objectContaining({
          bundleDigest: DIGEST,
          workload: "toks9",
          operation: "create",
          cogniKey: INPUT.cogniKey,
        }),
      },
    ]);
  });

  it("refuses a failed migration terminally", async () => {
    const migration = new FakeMigration();
    migration.outcome = "failed";
    const log = recordingLogger();

    await expect(
      enforceMigrationGate(
        { migration, log },
        { ...INPUT, requirement: requirement() }
      )
    ).rejects.toMatchObject({ code: "migration_failed" });
    expect(log.lines.map((line) => line.marker)).toEqual([
      "akash_tx_migration_failed",
    ]);
  });

  it("refuses when it cannot prove the state either way", async () => {
    const migration = new FakeMigration();
    migration.throws = new Error("kube-apiserver unreachable");
    const log = recordingLogger();

    const error = await enforceMigrationGate(
      { migration, log },
      { ...INPUT, requirement: requirement() }
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AkashTxError);
    expect(error).toMatchObject({ code: "migration_unavailable" });
    expect(log.lines[0]).toMatchObject({
      marker: "akash_tx_migration_unavailable",
      fields: expect.objectContaining({
        causeMessage: "kube-apiserver unreachable",
      }),
    });
  });

  it("refuses — never passes — when no prover is wired at all", async () => {
    // An actuator with no migration capability cannot tell an empty database from a migrated
    // one. Fail-open here IS the bug this gate exists to close.
    const log = recordingLogger();

    await expect(
      enforceMigrationGate({ log }, { ...INPUT, requirement: requirement() })
    ).rejects.toMatchObject({ code: "migration_unavailable" });
    expect(log.lines.map((line) => line.marker)).toEqual([
      "akash_tx_migration_capability_missing",
    ]);
  });

  it("lets Skip through, but never silently", async () => {
    const migration = new FakeMigration();
    const log = recordingLogger();

    await enforceMigrationGate(
      { migration, log },
      { ...INPUT, requirement: { policy: "Skip" } }
    );

    expect(migration.calls).toHaveLength(0);
    expect(log.lines.map((line) => line.marker)).toEqual([
      "akash_tx_migration_skipped",
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
