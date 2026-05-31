// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/review/types`
 * Purpose: Type definitions for the PR review feature.
 * Scope: Shared interfaces for gates, orchestrator, and review handler. Does not contain business logic.
 * Invariants: Types are plain serializable objects.
 * Side-effects: none
 * Links: task.0153
 * @public
 */

/** Gate evaluation status. */
export type GateStatus = "pass" | "fail" | "neutral";

/** Result from a single gate evaluation. */
export interface GateResult {
  readonly gateId: string;
  readonly gateType: string;
  readonly status: GateStatus;
  readonly summary: string;
  /** Per-metric scores (only for ai-rule gates). */
  readonly metrics?: ReadonlyArray<{
    readonly metric: string;
    readonly score: number;
    /** Human-readable threshold from repo-spec (e.g., "≥ 0.80"). */
    readonly requirement?: string;
    readonly observation: string;
  }>;
}

/** Overall review result from the gate orchestrator. */
export interface ReviewResult {
  readonly conclusion: GateStatus;
  readonly gateResults: readonly GateResult[];
}

/** PR evidence bundle pre-fetched for gate evaluation. */
export interface EvidenceBundle {
  readonly prNumber: number;
  readonly prTitle: string;
  readonly prBody: string;
  readonly headSha: string;
  readonly baseBranch: string;
  readonly changedFiles: number;
  readonly additions: number;
  readonly deletions: number;
  /** Truncated diff patches per file. */
  readonly patches: ReadonlyArray<{
    readonly filename: string;
    readonly patch: string;
  }>;
  /** Total diff size in bytes (before truncation). */
  readonly totalDiffBytes: number;
}

/** Context passed to the review handler. */
export interface ReviewContext {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly installationId: number;
}
