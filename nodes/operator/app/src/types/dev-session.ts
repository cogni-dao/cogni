// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@types/dev-session`
 * Purpose: Backend-agnostic shape of an AI-developer Claude Code session as a
 *   navigable, per-turn analytical VIEW (what an observability backend renders).
 *   Compile-time types only — the mapper that produces these lives in
 *   `@/shared/transcript/dev-session-map`; the Langfuse adapter consumes them.
 * Scope: Type definitions. No runtime code (types-layer invariant).
 * Invariants: VIEW_NOT_STORE (derived from the raw transcript corpus, never the
 *   store); a draft is lossy by design (scrubbed + capped + turn-limited).
 * Side-effects: none
 * Links: docs/design/agent-transcript-telemetry.md
 * @public
 */

export type DevSessionTool = {
  readonly name: string;
  readonly toolUseId: string | null;
  readonly input: string;
};

export type DevSessionTurn = {
  readonly index: number;
  readonly role: "user" | "assistant";
  readonly model: string | null;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly text: string;
  readonly tools: readonly DevSessionTool[];
  readonly timestamp: string | null;
};

export type DevSessionMeta = {
  readonly sessionId: string;
  readonly principalId: string;
  readonly principalName: string | null;
  readonly node: string | null;
  readonly repo: string | null;
  readonly headSha: string | null;
  readonly branch: string | null;
};

export type DevSessionDraft = {
  readonly sessionId: string;
  readonly source: "claude-code-dev-session";
  readonly tags: readonly string[];
  readonly metadata: Record<string, unknown>;
  readonly turns: readonly DevSessionTurn[];
  /** True when the transcript exceeded the turn cap and was clipped. */
  readonly truncatedTurns: boolean;
};
