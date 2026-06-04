// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/node-contracts`
 * Purpose: Shared Zod route contracts and HTTP router definitions for all node apps.
 * Scope: Pure contract code — Zod schemas, ts-rest router, OpenAPI generation. Does not contain business logic or adapters.
 * Invariants:
 *   - PURE_LIBRARY: No process lifecycle, no env vars, no framework deps
 *   - NO_SRC_IMPORTS: Never imports @/ or src/ paths
 * Side-effects: none
 * Links: docs/spec/architecture.md, docs/spec/packages-architecture.md
 * @public
 */

export * from "./agent.register.v1.contract";
// ── AI contracts ────────────────────────────────────────────────────────────
export * from "./ai.activity.v1.contract";
export * from "./ai.agents.v1.contract";
// ai.chat.v1.contract: selective re-export to avoid ChatMessage collision
// with ai.completions.v1.contract (TS2308). The completions ChatMessage
// (OpenAI-compatible format) is the one used by consumers.
export {
  AssistantUiInputSchema,
  aiChatOperation,
  type ChatInput,
  ChatMessageSchema,
  type ChatOutput,
} from "./ai.chat.v1.contract";
export * from "./ai.completions.v1.contract";
export * from "./ai.models.v1.contract";
export * from "./ai.runs.v1.contract";
export * from "./ai.threads.v1.contract";
// ── Analytics ───────────────────────────────────────────────────────────────
export * from "./analytics.summary.v1.contract";
// ── Attribution ─────────────────────────────────────────────────────────────
export * from "./attribution.collect-trigger.v1.contract";
export * from "./attribution.epoch-activity.v1.contract";
export * from "./attribution.epoch-claimants.v1.contract";
export * from "./attribution.epoch-statement.v1.contract";
export * from "./attribution.epoch-user-projections.v1.contract";
export * from "./attribution.finalize-epoch.v1.contract";
export * from "./attribution.list-epochs.v1.contract";
export * from "./attribution.record-pool-component.v1.contract";
export * from "./attribution.review-epoch.v1.contract";
export * from "./attribution.review-subject-overrides.v1.contract";
export * from "./attribution.sign-data.v1.contract";
// ── Billing ─────────────────────────────────────────────────────────────────
export * from "./billing-ingest.internal.v1.contract";
// ── Chat errors ─────────────────────────────────────────────────────────────
export * from "./error.chat.v1.contract";
export * from "./governance.status.v1.contract";
// ── Governance ──────────────────────────────────────────────────────────────
export * from "./governance-schedules-sync.internal.v1.contract";
export * from "./grants.validate.internal.v1.contract";
// ── Graphs ──────────────────────────────────────────────────────────────────
export * from "./graph-runs.create.internal.v1.contract";
export * from "./graph-runs.update.internal.v1.contract";
export * from "./graphs.run.internal.v1.contract";
// ── HTTP (ts-rest router + OpenAPI) ─────────────────────────────────────────
export * from "./http/openapi.v1";
export * from "./http/router.v1";
// ── Knowledge ───────────────────────────────────────────────────────────────
export * from "./knowledge.contributions.v1.contract";
export * from "./knowledge.domains.v1.contract";
export * from "./knowledge.list.v1.contract";
// ── Meta ────────────────────────────────────────────────────────────────────
export * from "./meta.livez.read.v1.contract";
export * from "./meta.readyz.read.v1.contract";
export * from "./meta.route-manifest.read.v1.contract";
export * from "./meta.version.read.v1.contract";
// ── Payments ────────────────────────────────────────────────────────────────
export * from "./payments.credits.summary.v1.contract";
export * from "./payments.intent.v1.contract";
export * from "./payments.status.v1.contract";
export * from "./payments.submit.v1.contract";
// Poly contracts moved to @cogni/poly-node-contracts (task.0421).
// ── Review (internal GitHub plane) ──────────────────────────────────────────
export * from "./review.internal.v1.contract";
// ── Runs ────────────────────────────────────────────────────────────────────
export * from "./run-stream.contract";
export * from "./runs.stream.v1.contract";
// ── Schedules ───────────────────────────────────────────────────────────────
export * from "./schedules.create.v1.contract";
export * from "./schedules.delete.v1.contract";
export * from "./schedules.list.v1.contract";
export * from "./schedules.update.v1.contract";
// ── Setup ───────────────────────────────────────────────────────────────────
export * from "./setup.verify.v1.contract";
// ── Treasury ────────────────────────────────────────────────────────────────
export * from "./treasury.snapshot.v1.contract";
// ── Users ───────────────────────────────────────────────────────────────────
export * from "./users.ownership.v1.contract";
export * from "./users.profile.v1.contract";
// ── VCS ─────────────────────────────────────────────────────────────────────
export * from "./vcs.flight.v1.contract";
export * from "./work.items.create.v1.contract";
export * from "./work.items.delete.v1.contract";
export * from "./work.items.get.v1.contract";
export * from "./work.items.list.v1.contract";
export * from "./work.items.patch.v1.contract";
