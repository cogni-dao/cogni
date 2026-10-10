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
 *   - ENVIRONMENT_IS_THE_WORKLOAD'S: the Job is ensured against the secret AND THE NAMESPACE of
 *     the workload being reconciled — both stated here, from the environment the observe request
 *     carries. "Which environment's database?" is answered by WHERE THE WORKLOAD IS, never by who
 *     is paying for it. Until task.5132 only the secret NAME was stated; the namespace defaulted
 *     to this process's own, which for a foreign-custodied lane resolved that name to the PAYING
 *     env's Secret — and left the receipt where the lane then read it as its own proof.
 *   - RECEIPT_IS_METADATA_NOT_DATA_ACCESS: on `succeeded` this step collects the receipt the node's
 *     OWN migrator printed and stores it as operator deployment metadata, keyed by the `node_id`
 *     the caller's allocation receipt already binds to this workload. The operator never connects
 *     to `cogni_<node>` to learn what was applied, and never asks the tenant-scoped `nodes`
 *     registry who the workload is — the one lookup that silently voided every receipt. That
 *     receipt is also the only input to the DRIFT GATE, which fails a `succeeded` Job into a
 *     `failed` PHASE on exactly one definite signal — a receipt was READ and it names a declared
 *     tag the database does not hold (bug.5415). No receipt, no capability, no bound node id, and
 *     `unexpected`-only ledger rows are UNKNOWNS or non-blocking drift: they keep reporting
 *     `succeeded`, because an unknown must never be laundered into a verdict.
 *   - OUTCOME_IS_OBSERVABLE: every phase emits a structured log marker before it is returned
 *     (bug.5115: a refusal that only reached CR status was invisible for hours). A `failed`
 *     phase additionally reaches the composite as a named status reason.
 * Side-effects: IO (one migration-proof call per invocation; the Kubernetes adapter behind the
 *   port creates the per-digest Job on first ask and reads it thereafter)
 * Links: @ports/akash-tx.port, @ports/compute-workload-migration.port,
 *   adapters/server/compute/kubernetes-migration-job.adapter, @shared/migrations/migration-receipt,
 *   bug.5116, bug.5140, bug.5415, task.5135
 * @internal
 */

import type {
  AkashTxMigrationPhase,
  AkashTxMigrationPort,
  AkashTxMigrationStep,
  ComputeWorkloadMigrationPhase,
  NodeMigrationReportStorePort,
} from "@/ports";
import {
  diffDeclaredVsApplied,
  hasMissingMigrations,
  type MigrationDrift,
  parseMigrationReceipt,
} from "@/shared/migrations/migration-receipt";

import type { AkashTxLogger } from "./akash-tx-actuator";

/**
 * Migration command policy implied by the `cogni-node-app-v1` runtime profile (bug.5116).
 * Fork images bundle the migrator at `/app/app/...` — the same contract the k3s lane's
 * `migrate` initContainer exercises against the monorepo layout.
 *
 * TWINS, kept byte-identical on purpose: `cogniNodeAppMigrationPhases()` in the frozen
 * the retired `compute-workload-reconciler`, and this. That controller is DELETED (task.5098),
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

/**
 * The namespace that Secret lives in — the WORKLOAD's, exactly as the composite that asked for
 * this migration is namespaced (`compute-workload-secret-manifests.ts`, `buildComputeWorkloadManifest`).
 *
 * This process runs in the PAYING cluster's `cogni-production` and reconciles other lanes'
 * workloads (bug.5206 custody), so its own namespace answers "who pays", never "whose database".
 * Stating the workload's namespace is what makes ENVIRONMENT_IS_THE_WORKLOAD'S true rather than
 * merely intended: `cogni-production/poly-compute-env-secrets` names `cogni_poly`, while the
 * candidate-a lane's identically-named Secret names `cogni_poly_candidate_a` (task.5132).
 */
function workloadNamespace(environment: string): string {
  return `cogni-${environment}`;
}

export interface AkashTxMigrationStepInput {
  readonly step: AkashTxMigrationStep;
  readonly cogniKey: string;
  readonly environment: string;
  /** The workload/node slug — `spec.name` on the wire. Names the Job, never the receipt cell. */
  readonly workload: string;
  /**
   * The immutable node UUID this workload's allocation receipt is bound to, when the caller could
   * read it. Absent means the receipt cell cannot be keyed yet — the migration still runs and
   * still reports its phase, and the metadata lands on a later tick (see recordReceipt).
   */
  readonly nodeId?: string | undefined;
}

export interface AkashTxMigrationStepDeps {
  /** Absent means the actuator cannot run migrations; the step reports `unavailable`. */
  readonly migration?: AkashTxMigrationPort;
  /**
   * Where a collected receipt is stored as operator-held deployment METADATA. Absent means the
   * receipt is simply not collected — the schema readout then honestly says "never reported"
   * rather than implying an empty schema, and the drift gate cannot fire, because there is no
   * reported state to fail.
   */
  readonly reports?: NodeMigrationReportStorePort;
  readonly log: AkashTxLogger;
}

/**
 * Collect the receipt the node's own migrator printed and store it against the NODE this call is
 * reconciling. The cell key is `nodeId` — the write-once UUID the caller's own allocation receipt
 * bound to this workload before any Console transaction — not the slug, which is renameable and is
 * identity for nothing. Nothing here reaches a node database: the migrator read its own ledger with
 * its own DSN and printed the answer.
 *
 * `nodeId` absent is a FACT, not an error: the only honest thing to do is say the metadata did not
 * land and let the next tick carry it (`ensure` keeps answering `succeeded` for the same digest).
 * It is NOT re-derived from the slug here — the previous shape asked the `nodes` registry, which is
 * FORCE row-level-security tenant state, and from this session-less process that lookup returned
 * zero rows for every node in the fleet, so every receipt was discarded as `node_not_registered`.
 *
 * Non-throwing, like everything else in this module. It returns the drift it READ, or `null` for
 * "no verdict" — every path that could not obtain and durably store a receipt answers `null`, and
 * `null` is NOT "clean". That distinction is the whole safety property of the drift gate: an
 * unreadable Job log, a missing capability, a malformed line and an unbound node id are all
 * UNKNOWNS, and an unknown must never block a deploy.
 */
async function recordReceipt(
  deps: AkashTxMigrationStepDeps,
  input: {
    readonly workload: string;
    readonly nodeId?: string | undefined;
    readonly environment: string;
    readonly bundleDigest: string;
    readonly namespace: string;
    readonly containerName: string;
    readonly fields: Record<string, unknown>;
  }
): Promise<MigrationDrift | null> {
  const { reports, migration } = deps;
  if (!reports || !migration?.readReceipt) return null;
  const { nodeId } = input;
  if (!nodeId) {
    deps.log.warn(input.fields, "akash_tx_migration_receipt_unbound");
    return null;
  }
  try {
    const stdout = await migration.readReceipt({
      nodeSlug: input.workload,
      bundleDigest: input.bundleDigest,
      namespace: input.namespace,
      containerName: input.containerName,
    });
    // ABSENT, not empty. `readReceipt` answers `null` when no pod log could be read at all (the
    // 403 class that `compute_workload_migration_receipt_log_unreadable` names), and
    // `parseMigrationReceipt` answers `null` when the stdout it did read carries no marker or a
    // truncated/malformed one. Neither is a receipt that says "I applied nothing" — only a PARSED
    // receipt with an empty `applied` array says that, and only that one gets a verdict.
    const receipt = stdout ? parseMigrationReceipt(stdout) : null;
    if (!receipt) {
      deps.log.info(input.fields, "akash_tx_migration_receipt_absent");
      return null;
    }
    const outcome = await reports.record({
      nodeId,
      environment: input.environment,
      declared: receipt.declared,
      applied: receipt.applied,
      bundleDigest: input.bundleDigest,
      reporter: "migration-job",
    });
    const drift = diffDeclaredVsApplied(receipt);
    // Counts and enums only on THIS line — it fires on every tick. Named tags appear once, on the
    // `akash_tx_migration_drift_missing` verdict, and only for the image's own journal (reportDrift).
    deps.log.info(
      {
        ...input.fields,
        outcome,
        declaredCount: receipt.declared.length,
        appliedCount: receipt.applied.length,
        missingCount: drift.missing.length,
      },
      "akash_tx_migration_receipt_recorded"
    );
    return drift;
  } catch (error) {
    deps.log.error(
      {
        ...input.fields,
        causeMessage: error instanceof Error ? error.message : "unknown cause",
      },
      "akash_tx_migration_receipt_failed"
    );
    return null;
  }
}

/** Cap on named tags per line: enough to act on, bounded against a 1000-migration journal. */
const DRIFT_TAGS_LOGGED = 20;

/**
 * Report the drift a receipt carried, and say whether it FAILS the step.
 *
 * Two different loudnesses on purpose (the asymmetry is the point):
 *   - `missing` — a tag the IMAGE declared that the database does not hold. A developer's
 *     migration did not arrive. This blocks: `akash_tx_migration_drift_missing` at error, and the
 *     step reports `failed`.
 *   - `unexpected` — a row in the database the image's journal does not recognise, i.e. an image
 *     rolled BACK past its schema. Worth shouting about, but it is NOT "a declared migration did
 *     not arrive", and blocking on it would fail every legitimately-older image. Warn only.
 *
 * Privacy: `missing` tags are IMAGE content — migration filenames out of the journal the image
 * ships, already served by `GET /nodes/{id}/observability/db/schema` — so naming them is what
 * makes the line actionable without an API round-trip. `unexpected` tags are DATABASE ROW content
 * (e.g. a bare ledger timestamp) and stay counted, never named. Bounded either way.
 */
function reportDrift(
  deps: AkashTxMigrationStepDeps,
  input: {
    readonly drift: MigrationDrift | null;
    readonly nodeId?: string | undefined;
    readonly fields: Record<string, unknown>;
  }
): boolean {
  const { drift } = input;
  if (!drift) return false;
  const counts = {
    ...input.fields,
    ...(input.nodeId ? { nodeId: input.nodeId } : {}),
    missingCount: drift.missing.length,
    unexpectedCount: drift.unexpected.length,
  };
  if (drift.unexpected.length > 0) {
    deps.log.warn(counts, "akash_tx_migration_drift_unexpected");
  }
  if (!hasMissingMigrations(drift)) return false;
  deps.log.error(
    { ...counts, missing: drift.missing.slice(0, DRIFT_TAGS_LOGGED) },
    "akash_tx_migration_drift_missing"
  );
  return true;
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
      namespace: workloadNamespace(input.environment),
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
    // The JOB's outcome, which is a different fact from the step's verdict below: a Job can exit 0
    // having applied less than its image declared, and that is exactly the drift this step now
    // gates on. Both lines are emitted so the two facts stay separately greppable.
    deps.log.info(fields, "akash_tx_migration_succeeded");
    // Declared-vs-applied becomes comparable here, and only here: the migrator just told us what
    // it applied. Awaited so the receipt is durable before the phase is reported.
    const drift = await recordReceipt(deps, {
      workload: input.workload,
      ...(input.nodeId ? { nodeId: input.nodeId } : {}),
      environment: input.environment,
      bundleDigest,
      namespace: workloadNamespace(input.environment),
      // The FIRST phase is the node's Postgres migrate; Doltgres has its own runtime drift check
      // (verifyDoltgresSchema), so Postgres is the plane with no proof today.
      containerName:
        cogniNodeAppMigrationPhases({ doltgres })[0]?.name ?? "migrate",
      fields,
    });
    // THE DRIFT GATE. A definite signal only: a receipt WAS read and it names a declared tag the
    // database does not hold. Still a PHASE, never a throw — the composite turns it into
    // `status.failure.reason: MigrationFailed` (retryable:false) and the lease is untouched, so
    // the previous digest keeps serving while a human repairs the schema. Nothing weaker reaches
    // here: no receipt, no capability, no bound node id and `unexpected`-only all answer
    // `succeeded`, because an unknown is not a failure.
    if (
      reportDrift(deps, {
        drift,
        ...(input.nodeId ? { nodeId: input.nodeId } : {}),
        fields,
      })
    ) {
      return "failed";
    }
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
