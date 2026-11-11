// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@ports/delivery-kpi`
 * Purpose: Read-only sources for the operator's delivery goal KPIs (task.5442): per-release facts from
 *   the node-deploy release store, the serving lanes, and one bounded public HTTP probe.
 * Scope: Interfaces only. The Postgres + fetch adapter lives in `adapters/server/node-deploy/`; the
 *   calculators that consume these facts live in `features/node-deploy/delivery-kpis.ts`.
 * Invariants:
 *   - RELEASE_STORE_ONLY: facts come from the operator Postgres release store, never Prometheus or Loki.
 *   - BOUNDED: every read takes `maxRows` (or `maxBytes`) and reports `truncated` instead of dropping rows.
 *   - UNREACHABLE_IS_AN_ANSWER: a probe that ran and got no HTTP answer returns `unreachable`; a probe that
 *     could not run (aborted by the caller) throws, so the reading becomes unknown.
 * Side-effects: none
 * Links: features/node-deploy/delivery-kpis.ts, shared/db/node-workloads.ts, task.5442
 * @public
 */

/** Optional filter: one node, one env, or both. Absent fields mean every node / env. */
export interface DeliveryScope {
  readonly nodeId?: string | undefined;
  readonly env?: string | undefined;
}

/** One release, aggregated over its attempts. All instants come from durable rows. */
export interface DeliveryReleaseFacts {
  readonly releaseId: string;
  readonly nodeId: string;
  readonly env: string;
  readonly workload: string;
  /** The full git sha the release deploys (task.5479 lane view). */
  readonly sourceSha: string;
  /** The principal that recorded the release (`user:<id>`; task.5479 lane view). */
  readonly createdBy: string;
  /** The write-once terminal admission refusal's reason, when the release was refused. */
  readonly admissionRefusalReason: string | undefined;
  /** When the release was recorded (POST): the start of lead time. */
  readonly createdAt: Date;
  /** Earliest write-once `attempts.activated_at`; undefined for attempts before the column. */
  readonly activatedAt: Date | undefined;
  /** Earliest persisted `activated/ok` step: the fallback when the column is absent. */
  readonly activatedStepAt: Date | undefined;
  /** An attempt is or was serving (`active|retiring|retired`), even with no recorded instant. */
  readonly served: boolean;
  /**
   * The durable park instant: earliest write-once `attempts.parked_at`, else the write-once terminal
   * admission refusal. Never the repeating `release_parked` step.
   */
  readonly parkedAt: Date | undefined;
  /** A `release_parked` step exists (a park from before `parked_at`, with no durable instant). */
  readonly parkStepSeen: boolean;
  /** The workload's desired row still points at this release. */
  readonly current: boolean;
  /**
   * Attempt number (per-release ordinal, from 1) of the earliest attempt that activated: its
   * `activated_at` is set or its steps hold `activated/ok`. Undefined = no attempt ever activated.
   */
  readonly firstActivatedAttempt: number | undefined;
  /**
   * An attempt that came BEFORE the first activation (or any attempt, when none activated) failed: an
   * `attempt_failed` step (`failed|closing`), phase `failed|closing|lost`, or a set `parked_at`. A failure
   * after the release first served (a lost lease, a retired blue) does not count.
   */
  readonly failedBeforeActivation: boolean;
}

/** One public lane: a running desired row whose release exposes an http host. */
export interface DeliveryLaneFacts {
  readonly nodeId: string;
  readonly env: string;
  readonly workload: string;
  readonly host: string;
  /** The release's declared health paths (`/version`, `/readyz` when undeclared). */
  readonly versionPath: string;
  readonly readyPath: string;
  readonly desiredReleaseId: string;
  readonly desiredCreatedAt: Date;
  /** The release that owns the lane's `active` attempt; undefined when nothing is active. */
  readonly activeReleaseId: string | undefined;
  /** `source_sha` of that release: the build the lane must serve. */
  readonly expectedSha: string | undefined;
}

export type DeliveryProbeResult =
  | {
      readonly kind: "response";
      readonly status: number;
      readonly body: string;
    }
  | { readonly kind: "unreachable"; readonly code: string };

export interface DeliveryKpiSourcePort {
  /**
   * Releases that could have finished in `[from, to)`: recorded in `[recordedFrom, to)`. A release
   * recorded before `recordedFrom` is not read.
   */
  releases(input: {
    readonly recordedFrom: Date;
    readonly to: Date;
    readonly scope: DeliveryScope;
    readonly maxRows: number;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly rows: readonly DeliveryReleaseFacts[];
    readonly truncated: boolean;
    readonly asOf: Date;
  }>;
  servingLanes(input: {
    readonly scope: DeliveryScope;
    readonly maxRows: number;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly lanes: readonly DeliveryLaneFacts[];
    readonly truncated: boolean;
    readonly asOf: Date;
  }>;
  /** GET `https://<host><path>`, no redirects, body capped at `maxBytes`. */
  probe(input: {
    readonly host: string;
    readonly path: string;
    readonly timeoutMs: number;
    readonly maxBytes: number;
    readonly signal: AbortSignal;
  }): Promise<DeliveryProbeResult>;
}
