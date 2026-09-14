// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/compute/akash-tx/akash-tx-migration-gate`
 * Purpose: Enforce bug.5116's ordering at the ONE chokepoint every paid Akash transaction
 *   already passes through — the actuator. A `RequireBeforeTransaction` workload cannot reach
 *   a Console transaction until the per-digest DB migration for its bundle has SUCCEEDED, so a
 *   freshly born node has its schemas before it has a lease (bug.5140).
 * Scope: One bounded proof per call: translate the caller's stated requirement into the
 *   per-digest migration contract, ask the migration port once, and answer pass-or-refuse.
 *   Does NOT watch, poll, sleep, retry, or hold state — the caller (Crossplane, via the
 *   actuator's HTTP surface) owns requeue and backoff exactly as it does for every other
 *   actuator refusal.
 * Invariants:
 *   - PROVEN_OR_REFUSED: only a `succeeded` proof passes. `running`, `failed`, an unreachable
 *     prover, and a missing prover are ALL refusals. There is no soft path.
 *   - COMMANDS_ARE_NOT_CALLER_SUPPLIED: the migration commands live here, keyed by
 *     runtimeProfile. A caller-supplied command would make the gate advisory — anyone able to
 *     call the actuator could "prove" a migration with a no-op.
 *   - REFUSAL_IS_OBSERVABLE: every outcome — including the `Skip` bypass — emits a structured
 *     log marker BEFORE the gate answers (bug.5115: a refusal that only reached CR status was
 *     invisible for hours).
 *   - GATE_BEFORE_SLOT: the caller must run this BEFORE taking the wallet slot. A migration
 *     Job runs for minutes; holding the wallet-global slot across it would deadlock the fleet.
 * Side-effects: IO (one migration-proof call per invocation; the Kubernetes adapter behind the
 *   port creates the per-digest Job on first ask and reads it thereafter)
 * Links: @ports/akash-tx.port, @ports/compute-workload-migration.port,
 *   adapters/server/compute/kubernetes-migration-job.adapter, bug.5116, bug.5140
 * @internal
 */

import {
  AkashTxError,
  type AkashTxMigrationPort,
  type AkashTxMigrationRequirement,
  type ComputeWorkloadMigrationPhase,
} from "@/ports";

import type { AkashTxLogger } from "./akash-tx-actuator";

/** Which mutating operation asked for the proof. Log-only; both gate identically. */
export type AkashTxMigrationOperation = "create" | "update";

/**
 * Migration command policy implied by the `cogni-node-app-v1` runtime profile (bug.5116).
 * Fork images bundle the migrator at `/app/app/...` — the same contract the k3s lane's
 * `migrate` initContainer exercises against the monorepo layout.
 *
 * TWINS, kept byte-identical on purpose: `cogniNodeAppMigrationPhases()` in the frozen
 * `compute-workload-reconciler`, and this. The controller is frozen (no new capabilities, see
 * docs/spec/cicd-platform-boundary.md), so the policy is restated here rather than moved out
 * of it; the test pins the exact strings so a change to either is a deliberate, reviewed diff.
 */
export function cogniNodeAppMigrationPhases(input: {
  doltgres: boolean;
}): readonly ComputeWorkloadMigrationPhase[] {
  return [
    {
      name: "migrate",
      command: [
        "/bin/sh",
        "-c",
        "exec node /app/app/migrate.mjs /app/app/migrations",
      ],
      databaseUrlSecretKey: "DATABASE_URL",
    },
    ...(input.doltgres
      ? [
          {
            name: "migrate-doltgres",
            command: [
              "/bin/sh",
              "-c",
              "exec node /app/app/migrate-doltgres.mjs /app/app/doltgres-migrations",
            ],
            databaseUrlSecretKey: "DOLTGRES_URL",
          },
        ]
      : []),
  ];
}

/**
 * The node-scoped Secret holding the database URLs, derived exactly as the legacy reconciler
 * derived it. Values never transit this process: the Job references keys by `secretKeyRef`.
 */
function migrationSecretName(workload: string): string {
  return `${workload}-compute-env-secrets`;
}

export interface AkashTxMigrationGateInput {
  readonly requirement: AkashTxMigrationRequirement;
  readonly operation: AkashTxMigrationOperation;
  readonly cogniKey: string;
  readonly environment: string;
  /** The workload/node slug — `spec.name` on the wire. */
  readonly workload: string;
}

export interface AkashTxMigrationGateDeps {
  /** Absent means the actuator has no way to prove migrations; requirements then REFUSE. */
  readonly migration?: AkashTxMigrationPort;
  readonly log: AkashTxLogger;
}

/**
 * Prove the migration precondition, or throw the refusal the caller must propagate.
 * Returns normally ONLY when the requirement is `Skip` or the digest's migration succeeded.
 */
export async function enforceMigrationGate(
  deps: AkashTxMigrationGateDeps,
  input: AkashTxMigrationGateInput
): Promise<void> {
  const base = {
    cogniKey: input.cogniKey,
    environment: input.environment,
    workload: input.workload,
    operation: input.operation,
  };

  if (input.requirement.policy === "Skip") {
    // Not a refusal, but the one way the gate can legitimately not fire. A silent bypass is
    // how "nothing enforces this" looked for a whole release; say it out loud instead.
    deps.log.info(base, "akash_tx_migration_skipped");
    return;
  }

  const { bundleDigest, image, doltgres, profile } = input.requirement;
  const fields = { ...base, bundleDigest, profile };

  if (!deps.migration) {
    // Fail CLOSED. An actuator wired without a prover cannot tell a migrated database from an
    // empty one, and "assume migrated" is precisely the paid-lease-on-empty-schema bug.
    deps.log.error(fields, "akash_tx_migration_capability_missing");
    throw new AkashTxError(
      "migration_unavailable",
      "migration proof is required but this actuator has no migration capability wired"
    );
  }

  let outcome: "succeeded" | "running" | "failed";
  try {
    outcome = await deps.migration.ensure({
      nodeSlug: input.workload,
      environment: input.environment,
      bundleDigest,
      image,
      secretName: migrationSecretName(input.workload),
      phases: cogniNodeAppMigrationPhases({ doltgres }),
    });
  } catch (error) {
    // We could not find out. Refuse: an unknown migration state must never be spent against.
    deps.log.error(
      {
        ...fields,
        causeMessage: error instanceof Error ? error.message : "unknown cause",
      },
      "akash_tx_migration_unavailable"
    );
    throw new AkashTxError(
      "migration_unavailable",
      "could not prove the bundle digest's migration state"
    );
  }

  if (outcome === "succeeded") {
    // The audit line that ties a paid lease to the digest whose schema preceded it.
    deps.log.info(fields, "akash_tx_migration_proven");
    return;
  }

  if (outcome === "running") {
    deps.log.warn(fields, "akash_tx_migration_pending");
    throw new AkashTxError(
      "migration_pending",
      "bundle digest migration has not completed; retry this key later"
    );
  }

  deps.log.error(fields, "akash_tx_migration_failed");
  throw new AkashTxError(
    "migration_failed",
    "bundle digest migration failed; a new bundle digest is required"
  );
}
