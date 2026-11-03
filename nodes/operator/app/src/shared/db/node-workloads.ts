// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@shared/db/node-workloads`
 * Purpose: Operator-local Drizzle schema for the node-deploy sequencer's durable state: what a
 *   node WANTS running (`node_workload_desired`), the immutable releases it asked for
 *   (`node_workload_releases`), and every paid create attempt made for a release
 *   (`node_workload_attempts`). task.5400 / story.5127, design hub `node-service-delivery`.
 * Scope: Table definitions only. Holds no queries and no policy; the Postgres store adapter reads
 *   and writes them and the sequencer decides.
 * Invariants:
 *   - OPERATOR_LOCAL_NOT_SHARED: operator operational Postgres, never `@cogni/db-schema` and never
 *     Doltgres. These rows are system-of-record deploy history, not AI-refined knowledge.
 *   - RELEASE_IS_IMMUTABLE: a release row is written once. A new sha is a NEW release; nothing
 *     updates `spec` or `source_sha`.
 *   - ATTEMPT_ROW_BEFORE_CREATE: an attempt row (phase `planned`) is durable BEFORE the paid
 *     create is sent, so a crash can never leak a paid lease nobody can find.
 *   - KEY_IS_NEVER_REUSED: `cogni_key` is globally unique and embeds `(release, attempt)`; every
 *     create gets a fresh ordinal, and `(release_id, attempt)` is unique too.
 *   - DESIRED_IS_ONE_ROW_PER_WORKLOAD: pk `(node_id, env, workload)`; only operator verbs write it.
 * Side-effects: none
 * Links: adapters/server/node-deploy/postgres-store.adapter.ts, features/node-deploy/sequencer.ts,
 *   docs/spec/databases.md, task.5400
 * @public
 */

import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

/** Lifecycle of one create attempt. See `features/node-deploy/types.ts` for the transitions. */
export const NODE_WORKLOAD_ATTEMPT_PHASES = [
  "planned",
  "created",
  "proving",
  "proven",
  "active",
  "retiring",
  "retired",
  "closing",
  "failed",
  "lost",
] as const;

export const NODE_WORKLOAD_DESIRED_STATES = ["running", "stopped"] as const;

export const nodeWorkloadReleases = pgTable(
  "node_workload_releases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Immutable repo-spec node UUID. Not a FK: deploy history must outlive a registry purge. */
    nodeId: uuid("node_id").notNull(),
    env: text("env").notNull(),
    workload: text("workload").notNull(),
    /** Full git sha the declaration was read at; injected into apps as RELEASE_SHA. */
    sourceSha: text("source_sha").notNull(),
    /** The resolved `NodeWorkloadSpec` as declared at `source_sha`. */
    spec: jsonb("spec").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("node_workload_releases_workload_idx").on(
      table.nodeId,
      table.env,
      table.workload,
      table.createdAt
    ),
  ]
);

export const nodeWorkloadDesired = pgTable(
  "node_workload_desired",
  {
    nodeId: uuid("node_id").notNull(),
    env: text("env").notNull(),
    workload: text("workload").notNull(),
    /** `running` is reconciled; `stopped` is left alone by every loop. */
    state: text("state").notNull(),
    /** The release the sequencer converges this workload to. */
    releaseId: uuid("release_id")
      .notNull()
      .references(() => nodeWorkloadReleases.id),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /**
     * Durable GAME-DAY intent: set by `POST /deploy/workloads/game-day`, consumed (and cleared) by the
     * sequencer, which closes the active app lease through the actuator WITHOUT touching `state` or
     * `release_id`. Reconcile then detects the chain-confirmed close and recovers the same release.
     */
    gameDayRequestedAt: timestamp("game_day_requested_at", {
      withTimezone: true,
    }),
  },
  (table) => [
    primaryKey({
      name: "node_workload_desired_pkey",
      columns: [table.nodeId, table.env, table.workload],
    }),
  ]
);

export const nodeWorkloadAttempts = pgTable(
  "node_workload_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    releaseId: uuid("release_id")
      .notNull()
      .references(() => nodeWorkloadReleases.id),
    /** Per-release ordinal, starting at 1. The actuator's `compositeGeneration`. */
    attempt: integer("attempt").notNull(),
    /** `nd:<namespace>:<nodeId>:<workload>:<releaseId>:<attempt>` — the actuator idempotency key. */
    cogniKey: text("cogni_key").notNull(),
    /** Opaque provider handle (Akash dseq) once the allocation is durable. */
    externalName: text("external_name"),
    provider: text("provider"),
    /** Provider endpoints as the actuator reported them (ingress hosts, `tcp://host:port`). */
    endpoints: jsonb("endpoints").$type<readonly string[]>().notNull(),
    phase: text("phase").notNull(),
    error: text("error"),
    /** First time the active lease failed its proof while live on chain; null while healthy. */
    unhealthySince: timestamp("unhealthy_since", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** When the lease was bound (phase `created`); the proof deadline counts from here. */
    leasedAt: timestamp("leased_at", { withTimezone: true }),
    /** Last phase change; the retention window of a `retiring` blue counts from here. */
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /**
     * Durable step timeline (oldest first, newest 100 kept), appended by the sequencer's single emit
     * helper next to the `node_deploy_step` log line. Nullable and additive: attempts that predate it
     * read as an empty timeline. Observability only; no policy reads it.
     */
    steps:
      jsonb("steps").$type<
        readonly {
          step: string;
          outcome: string;
          reason?: string | undefined;
          dseq?: string | undefined;
          provider?: string | undefined;
          elapsedMs?: number | undefined;
          at: string;
        }[]
      >(),
  },
  (table) => [
    unique("node_workload_attempts_cogni_key_uniq").on(table.cogniKey),
    unique("node_workload_attempts_release_attempt_uniq").on(
      table.releaseId,
      table.attempt
    ),
    index("node_workload_attempts_phase_idx").on(table.phase),
  ]
);
