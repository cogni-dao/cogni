// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/compute/akash-tx/akash-tx-migration-step`
 * Purpose: Run the per-bundle-digest database migration as a RELEASE step on the actuator's
 *   UNPAID observe tick, and REPORT its phase. Replaces the pre-transaction gate this module
 *   used to be (task.5135): bug.5116 wanted a fresh node's schemas to exist, and bug.5140
 *   implemented that want as a precondition of every paid Akash transaction. That coupling is
 *   what left node toks5 with a valid XR, a valid image digest, and no lease in ANY
 *   environment — `akash-lease` said "not yet ready" 1044 times while the actuator was never
 *   called at all. Buying compute and migrating a database are different jobs; this one is no
 *   longer allowed to stop the other.
 * Scope: One bounded, NON-THROWING attempt per call: translate the caller's step into the
 *   per-digest migration contract, ask the migration port once, answer with a phase. Does NOT
 *   watch, poll, sleep, retry, hold state, or refuse anything — the caller (Crossplane, via the
 *   actuator's observe) owns requeue and backoff exactly as it does for every other tick.
 * Invariants:
 *   - NEVER_REFUSES: there is no failure path that throws. Every outcome — including an
 *     unreachable prover and a missing capability — is a PHASE. A thrown error here would
 *     re-create the coupling this module was rewritten to delete, because observe is the call
 *     Crossplane uses to decide whether to create the lease at all.
 *   - COMMANDS_ARE_NOT_CALLER_SUPPLIED: the migration commands live here, keyed by
 *     runtimeProfile. A caller-supplied command would let anyone who can reach the actuator run
 *     an arbitrary container against the environment's database under its service account.
 *   - ENVIRONMENT_IS_THE_WORKLOAD'S: the Job is ensured against the secret and namespace of the
 *     workload being reconciled. The composite is namespaced `cogni-<environment>` and the
 *     Composition dials the actuator in that same namespace, so "which environment's database?"
 *     is answered by WHERE THE WORKLOAD IS, never by who is paying for it.
 *   - OUTCOME_IS_OBSERVABLE: every phase emits a structured log marker before it is returned
 *     (bug.5115: a refusal that only reached CR status was invisible for hours). A `failed`
 *     phase additionally reaches the composite as a named status reason.
 * Side-effects: IO (one migration-proof call per invocation; the Kubernetes adapter behind the
 *   port creates the per-digest Job on first ask and reads it thereafter)
 * Links: @ports/akash-tx.port, @ports/compute-workload-migration.port,
 *   adapters/server/compute/kubernetes-migration-job.adapter, bug.5116, bug.5140, task.5135
 * @internal
 */

import type {
  AkashTxMigrationPhase,
  AkashTxMigrationPort,
  AkashTxMigrationStep,
  ComputeWorkloadMigrationPhase,
} from "@/ports";

import type { AkashTxLogger } from "./akash-tx-actuator";

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

export interface AkashTxMigrationStepInput {
  readonly step: AkashTxMigrationStep;
  readonly cogniKey: string;
  readonly environment: string;
  /** The workload/node slug — `spec.name` on the wire. */
  readonly workload: string;
}

export interface AkashTxMigrationStepDeps {
  /** Absent means the actuator cannot run migrations; the step reports `unavailable`. */
  readonly migration?: AkashTxMigrationPort;
  readonly log: AkashTxLogger;
}

/**
 * Ensure the bundle digest's migration and report where it got to. NEVER throws, and its
 * answer never gates anything in this process — the composite decides what a phase means.
 */
export async function runMigrationStep(
  deps: AkashTxMigrationStepDeps,
  input: AkashTxMigrationStepInput
): Promise<AkashTxMigrationPhase> {
  const { bundleDigest, image, doltgres, profile } = input.step;
  const fields = {
    cogniKey: input.cogniKey,
    environment: input.environment,
    workload: input.workload,
    bundleDigest,
    profile,
  };

  if (!deps.migration) {
    // Not a refusal any more — a fact. The lease is created either way, and a node whose
    // schema never arrives fails its boot SLO, which is bounded and visible.
    deps.log.error(fields, "akash_tx_migration_capability_missing");
    return "unavailable";
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
    deps.log.error(
      {
        ...fields,
        causeMessage: error instanceof Error ? error.message : "unknown cause",
      },
      "akash_tx_migration_unavailable"
    );
    return "unavailable";
  }

  if (outcome === "succeeded") {
    deps.log.info(fields, "akash_tx_migration_succeeded");
    return "succeeded";
  }
  if (outcome === "running") {
    deps.log.info(fields, "akash_tx_migration_running");
    return "running";
  }
  // Terminal for this digest. The composite names it `MigrationFailed`; a new bundle digest
  // is the only thing that can clear it.
  deps.log.error(fields, "akash_tx_migration_failed");
  return "failed";
}
