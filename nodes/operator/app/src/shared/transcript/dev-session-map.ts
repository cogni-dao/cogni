// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/transcript/dev-session-map`
 * Purpose: Pure mapper from a Claude Code session transcript (JSONL firehose) to
 *   a backend-agnostic `DevSessionDraft` — the navigable, per-turn shape an
 *   observability view (Langfuse) renders. Applies secret-scrubbing and payload
 *   caps as pure transforms so nothing un-bounded or unscrubbed can be emitted.
 * Scope: Parsing + shaping only. Owns no IO, no Langfuse SDK, no env. The raw
 *   transcript stays the corpus (Postgres); this derives an analytical VIEW from
 *   it — it is never the store. Defensive by construction: malformed lines are
 *   skipped, never thrown, because Claude Code's JSONL shape evolves.
 * Invariants:
 *   - SCRUB_BEFORE_SHAPE: every author-controlled string is scrubbed + capped
 *     before it enters the draft (mirrors the hook's client-side redaction).
 *   - VIEW_NOT_STORE: lossy by design (caps, turn limit); the corpus is canonical.
 *   - TOTAL_FUNCTION: any input string yields a draft; parse errors drop a line.
 * Side-effects: none (pure)
 * Links: docs/design/agent-transcript-telemetry.md
 * @public
 */

import type {
  DevSessionDraft,
  DevSessionMeta,
  DevSessionTool,
  DevSessionTurn,
} from "@/types/dev-session";

/** Caps — keep a single dev session well under Langfuse per-payload limits. */
export const MAX_TURNS = 500;
export const MAX_TURN_TEXT_BYTES = 10_000;
export const MAX_TOOL_INPUT_BYTES = 4_000;
const TRUNCATED = "…[truncated]";

export const DEV_SESSION_SOURCE = "claude-code-dev-session";

/**
 * Secret-scrub author content server-side before it can leave the operator.
 * Mirrors the regex set in `.claude/hooks/ship-transcript.mjs` (defence in
 * depth: the hook scrubs client-side, but a body could arrive from elsewhere).
 */
export function scrubSecrets(text: string): string {
  return text
    .replace(/cogni_ag_sk_v1_[A-Za-z0-9._-]+/g, "cogni_ag_sk_v1_[REDACTED]")
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, "gh_[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]{20,}/g, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9._-]{20,}/g, "sk-[REDACTED]");
}

function capBytes(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - TRUNCATED.length) + TRUNCATED;
}

function clean(text: string, max: number): string {
  return capBytes(scrubSecrets(text), max);
}

type RawContentPart = {
  type?: unknown;
  text?: unknown;
  thinking?: unknown;
  name?: unknown;
  id?: unknown;
  input?: unknown;
  content?: unknown;
  tool_use_id?: unknown;
};

function asString(v: unknown): string {
  if (typeof v === "string") return v;
  if (v == null) return "";
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function numberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Extract scrubbed+capped text and tool calls from one message's content. */
function readContent(content: unknown): {
  text: string;
  tools: DevSessionTool[];
} {
  const tools: DevSessionTool[] = [];
  if (typeof content === "string") {
    return { text: clean(content, MAX_TURN_TEXT_BYTES), tools };
  }
  if (!Array.isArray(content)) return { text: "", tools };

  const textParts: string[] = [];
  for (const raw of content) {
    const part = raw as RawContentPart;
    switch (part?.type) {
      case "text":
        textParts.push(asString(part.text));
        break;
      case "thinking":
        textParts.push(`[thinking] ${asString(part.thinking)}`);
        break;
      case "tool_use":
        tools.push({
          name: asString(part.name) || "tool",
          toolUseId: typeof part.id === "string" ? part.id : null,
          input: clean(asString(part.input), MAX_TOOL_INPUT_BYTES),
        });
        break;
      case "tool_result":
        textParts.push(`[tool_result] ${asString(part.content)}`);
        break;
      default:
        break;
    }
  }
  return { text: clean(textParts.join("\n"), MAX_TURN_TEXT_BYTES), tools };
}

type RawLine = {
  type?: unknown;
  timestamp?: unknown;
  message?: {
    role?: unknown;
    model?: unknown;
    content?: unknown;
    usage?: { input_tokens?: unknown; output_tokens?: unknown } | null;
  } | null;
};

/**
 * Map a Claude Code transcript (newline-delimited JSON) into a DevSessionDraft.
 * Only `user`/`assistant` lines become turns; `system`/`summary`/unknown lines
 * are ignored. Never throws.
 */
export function mapTranscriptToDevSession(
  jsonl: string,
  meta: DevSessionMeta
): DevSessionDraft {
  const turns: DevSessionTurn[] = [];
  let totalIn = 0;
  let totalOut = 0;
  let truncatedTurns = false;

  for (const lineText of jsonl.split("\n")) {
    const trimmed = lineText.trim();
    if (!trimmed) continue;
    if (turns.length >= MAX_TURNS) {
      truncatedTurns = true;
      break;
    }

    let entry: RawLine;
    try {
      entry = JSON.parse(trimmed) as RawLine;
    } catch {
      continue; // tolerate malformed / partial lines
    }
    if (entry?.type !== "user" && entry?.type !== "assistant") continue;

    const msg = entry.message ?? {};
    const { text, tools } = readContent(msg.content);
    if (!text && tools.length === 0) continue;

    const tokensIn = numberOrNull(msg.usage?.input_tokens);
    const tokensOut = numberOrNull(msg.usage?.output_tokens);
    if (tokensIn) totalIn += tokensIn;
    if (tokensOut) totalOut += tokensOut;

    turns.push({
      index: turns.length,
      role: entry.type,
      model: typeof msg.model === "string" ? msg.model : null,
      tokensIn,
      tokensOut,
      text,
      tools,
      timestamp: typeof entry.timestamp === "string" ? entry.timestamp : null,
    });
  }

  const tags = [
    DEV_SESSION_SOURCE,
    meta.node ? `node:${meta.node}` : null,
  ].filter((t): t is string => t !== null);

  return {
    sessionId: meta.sessionId,
    source: DEV_SESSION_SOURCE,
    tags,
    metadata: {
      principalId: meta.principalId,
      principalName: meta.principalName,
      node: meta.node,
      repo: meta.repo,
      headSha: meta.headSha,
      branch: meta.branch,
      turnCount: turns.length,
      totalTokensIn: totalIn,
      totalTokensOut: totalOut,
    },
    turns,
    truncatedTurns,
  };
}
