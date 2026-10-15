// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `features/nodes/dedicated-cell-pressure`
 * Purpose: Require sustained node-attributed active pressure before dedicated containment.
 * Scope: Pure policy over a privately authenticated native pressure port.
 * Invariants: Three fresh samples, 75% active role budget, 40% node backend share; idle alone never triggers.
 * Side-effects: Controller calls pressure/containment ports; pure evaluator has none.
 * Links: reliability-status.ts, ports/database-cell-pressure.port.ts
 * @internal
 */
import { RELIABILITY_POLICY_V1 } from "@cogni/node-contracts";
import type {
  DatabaseCellPressureObservation,
  DatabaseCellPressurePort,
  DatabaseContainmentPort,
  DatabaseContainmentStatus,
  DatabaseRecoveryVerificationPort,
} from "@/ports";

export const DEDICATED_PRESSURE_INTERVAL_MS = 10_000;
const WINDOW_MS = 35_000;
const FRESH_MS = 15_000;

export interface DedicatedCellPressureTrigger {
  readonly policy: "dedicated-active-role-pressure.v1";
  readonly role: string;
  readonly reason: "critical_connections";
  readonly activeRoleBudgetPct: number;
  readonly attributedBackendsPct: number;
  readonly firstObservedAt: string;
  readonly lastObservedAt: string;
  readonly evidenceQueryRefs: readonly string[];
}

function identity(sample: DatabaseCellPressureObservation): string {
  return JSON.stringify([
    sample.nodeId,
    sample.nodeSlug,
    sample.environment,
    sample.allocationReceiptId,
    sample.dseq,
    sample.providerAccount,
    sample.databaseName,
    sample.systemIdentifier,
    sample.targetBuildSha,
    sample.roles
      .map((role) => [role.name, role.kind, role.connectionLimit])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  ]);
}

/** Three fresh native samples at ten-second cadence; no missing-host substitution. */
export function knownCriticalDedicatedPressure(input: {
  readonly nowMs: number;
  readonly targetBuildSha: string;
  readonly samples: readonly DatabaseCellPressureObservation[];
}): DedicatedCellPressureTrigger | null {
  const samples = input.samples.slice(-3);
  const first = samples[0];
  const last = samples[2];
  if (samples.length !== 3 || !first || !last) return null;
  const firstMs = Date.parse(first.observedAt);
  const lastMs = Date.parse(last.observedAt);
  if (
    !Number.isFinite(input.nowMs) ||
    !Number.isFinite(firstMs) ||
    !Number.isFinite(lastMs) ||
    input.nowMs - firstMs > WINDOW_MS ||
    input.nowMs - lastMs > FRESH_MS ||
    lastMs > input.nowMs + 2_000 ||
    !/^[0-9a-f]{40}$/.test(input.targetBuildSha) ||
    !/^[1-9][0-9]*$/.test(first.systemIdentifier) ||
    !first.allocationReceiptId ||
    !first.dseq ||
    !first.providerAccount ||
    new Set(first.roles.map((role) => role.name)).size !== first.roles.length
  )
    return null;
  for (const [index, sample] of samples.entries()) {
    const at = Date.parse(sample.observedAt);
    const previous = samples[index - 1];
    const spacing = previous ? at - Date.parse(previous.observedAt) : null;
    if (
      identity(sample) !== identity(first) ||
      sample.targetBuildSha !== input.targetBuildSha ||
      !sample.queryRef ||
      !Number.isFinite(at) ||
      (spacing !== null && (spacing < 9_000 || spacing > 15_000)) ||
      !Number.isInteger(sample.totalBackends) ||
      sample.totalBackends <= 0 ||
      sample.roles.reduce((total, role) => total + role.connections, 0) >
        sample.totalBackends ||
      sample.roles.some(
        (role) =>
          !Number.isInteger(role.connectionLimit) ||
          role.connectionLimit <= 0 ||
          [
            role.connections,
            role.active,
            role.waiting,
            role.idle,
            role.idleInTransaction,
          ].some((value) => !Number.isInteger(value) || value < 0) ||
          role.active > role.connections ||
          role.active + role.idle + role.idleInTransaction > role.connections ||
          role.waiting > role.active ||
          role.connections > sample.totalBackends
      )
    )
      return null;
  }
  for (const role of last.roles) {
    const measured = samples.map((sample) => {
      const current = sample.roles.find((value) => value.name === role.name);
      if (!current) return null;
      return {
        budget: (100 * current.active) / current.connectionLimit,
        // Attribution belongs to the whole node; backend-share counts connections, including idle.
        // The independent per-role ACTIVE/budget threshold prevents idle-only containment.
        attribution:
          (100 *
            sample.roles.reduce(
              (total, owned) => total + owned.connections,
              0
            )) /
          sample.totalBackends,
      };
    });
    if (
      measured.every(
        (value) =>
          value !== null &&
          value.budget >=
            RELIABILITY_POLICY_V1.signals.connectionsPercent.critical &&
          value.attribution >= RELIABILITY_POLICY_V1.noisyNeighborSharePercent
      )
    ) {
      return {
        policy: "dedicated-active-role-pressure.v1",
        role: role.name,
        reason: "critical_connections",
        activeRoleBudgetPct: Math.min(
          ...measured.map((value) => value?.budget ?? 0)
        ),
        attributedBackendsPct: Math.min(
          ...measured.map((value) => value?.attribution ?? 0)
        ),
        firstObservedAt: first.observedAt,
        lastObservedAt: last.observedAt,
        evidenceQueryRefs: samples.map((sample) => sample.queryRef),
      };
    }
  }
  return null;
}

export interface DedicatedPressureTarget {
  readonly nodeId: string;
  readonly slug: string;
  readonly environment: "candidate-a" | "preview" | "production";
  readonly desiredTier: "dedicated";
  readonly budgetProfile: string;
  readonly sourceSha: string;
  readonly cellId: string;
}

/** Native activity can prove containment necessary while host health stays unknown. */
export class DedicatedCellPressureController {
  private readonly windows = new Map<
    string,
    DatabaseCellPressureObservation[]
  >();

  constructor(
    private readonly deps: {
      readonly pressure: DatabaseCellPressurePort;
      readonly containment: DatabaseContainmentPort;
      readonly recovery: Pick<
        DatabaseRecoveryVerificationPort,
        "current" | "recontain"
      >;
      readonly buildShaFor: (
        target: DedicatedPressureTarget
      ) => Promise<string | null>;
      readonly nowMs: () => number;
    }
  ) {}

  async observe(target: DedicatedPressureTarget): Promise<{
    readonly observation: DatabaseCellPressureObservation;
    readonly trigger: DedicatedCellPressureTrigger | null;
    readonly containment: DatabaseContainmentStatus | null;
  }> {
    const key = `${target.environment}/${target.nodeId}`;
    try {
      if ((await this.deps.buildShaFor(target)) !== target.sourceSha)
        throw new Error("database_cell_pressure_current_app_sha_unproved");
      const observation = await this.deps.pressure.observe({
        nodeId: target.nodeId,
        nodeSlug: target.slug,
        environment: target.environment,
        cellId: target.cellId,
      });
      if (
        observation.nodeId !== target.nodeId ||
        observation.nodeSlug !== target.slug ||
        observation.environment !== target.environment ||
        observation.targetBuildSha !== target.sourceSha
      )
        throw new Error("database_cell_pressure_target_identity_mismatch");
      const nowMs = this.deps.nowMs();
      for (const [oldKey, values] of this.windows) {
        const lastAt = Date.parse(values.at(-1)?.observedAt ?? "");
        if (!Number.isFinite(lastAt) || nowMs - lastAt > WINDOW_MS)
          this.windows.delete(oldKey);
      }
      const samples = [...(this.windows.get(key) ?? []), observation].slice(-3);
      this.windows.set(key, samples);
      const trigger = knownCriticalDedicatedPressure({
        nowMs,
        targetBuildSha: target.sourceSha,
        samples,
      });
      if (!trigger) return { observation, trigger, containment: null };
      const scope = {
        nodeId: target.nodeId,
        nodeSlug: target.slug,
        environment: target.environment,
        desiredTier: target.desiredTier,
        budgetProfile: target.budgetProfile,
        cellId: target.cellId,
      };
      const current = await this.deps.recovery.current(scope);
      if (
        current &&
        (current.nodeId !== target.nodeId ||
          current.environment !== target.environment ||
          current.nodeSlug !== target.slug ||
          current.targetBuildSha !== target.sourceSha ||
          current.databaseName !== observation.databaseName ||
          current.databaseSystemIdentifier !== observation.systemIdentifier)
      )
        throw new Error(
          "database_cell_pressure_native_incident_identity_mismatch"
        );
      let contained: DatabaseContainmentStatus;
      if (current && current.state !== "readmitted") {
        // Reassert an actual current incident; never invent a second incident during recovery.
        await this.deps.recovery.recontain({
          nodeId: target.nodeId,
          environment: target.environment,
          incidentId: current.incidentId,
          targetBuildSha: current.targetBuildSha,
          databaseSystemIdentifier: current.databaseSystemIdentifier,
          reason: "dedicated_active_role_pressure",
        });
        contained = await this.deps.containment.status(scope);
      } else {
        contained = await this.deps.containment.contain({
          ...scope,
          incidentId: `reliability.v1:${target.environment}:${target.nodeId}:dedicated:${Date.parse(trigger.firstObservedAt)}`,
          reason: trigger.reason,
          actorId: "system:dedicated-active-role-pressure.v1",
        });
      }
      if (!contained.contained || contained.phase !== "contained")
        throw new Error("database_cell_pressure_containment_not_confirmed");
      this.windows.delete(key);
      return { observation, trigger, containment: contained };
    } catch (error) {
      // A failed sample must break continuity instead of completing a later three-sample window.
      this.windows.delete(key);
      throw error;
    }
  }
}
