// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/review/summary-formatter`
 * Purpose: Markdown rendering for Check Run output and PR comment body.
 * Scope: Pure formatting — receives review results, returns markdown strings. Does not perform I/O.
 * Invariants: Output is valid GitHub-flavored markdown. Format aligns with cogni-git-review.
 * Side-effects: none
 * Links: docs/spec/governance-signal-execution.md
 * @public
 */

import type { GateResult, GateStatus, ReviewResult } from "./types";

/**
 * Format the Check Run summary (markdown for the "output" field).
 * Matches cogni-git-review summary-adapter.js format.
 */
export function formatCheckRunSummary(
  result: ReviewResult,
  opts?: { daoBaseUrl?: string }
): string {
  const lines: string[] = [];

  // DAO vote link (failures only — top of View Details page)
  if (opts?.daoBaseUrl && result.conclusion === "fail") {
    lines.push(`[Propose DAO Vote to Merge](${opts.daoBaseUrl})\n\n---\n`);
  }

  // Verdict
  lines.push(`**${verdictLabel(result.conclusion)}**\n`);

  // Counts line
  lines.push(countsLine(result.gateResults));
  lines.push("");

  // Gates sorted: fail → pass → neutral
  for (const gate of sortedGates(result.gateResults)) {
    lines.push(formatGateSection(gate));
  }

  return lines.join("\n");
}

/**
 * Format a PR comment body with developer-friendly summary.
 * Matches cogni-git-review pr-comment.js format.
 */
export function formatPrComment(
  result: ReviewResult,
  opts?: {
    headSha?: string;
    checkRunUrl?: string;
  }
): string {
  const lines: string[] = [];

  lines.push(`## Cogni Review — ${verdictLabel(result.conclusion)}\n`);

  // Counts line
  lines.push(`**Gates:** ${countsLine(result.gateResults)}\n`);

  // Failed gates detail (compact — top 3 blockers, with metric tables)
  const failed = result.gateResults.filter((g) => g.status === "fail");
  if (failed.length > 0) {
    lines.push("**Blockers:**");
    for (const gate of failed.slice(0, 3)) {
      lines.push(`- **${gate.gateId}**:`);
      if (gate.metrics && gate.metrics.length > 0) {
        lines.push("");
        lines.push("  | Metric | Score | Requirement | Observation |");
        lines.push("  |--------|-------|-------------|-------------|");
        for (const m of gate.metrics) {
          const req = m.requirement ?? "—";
          lines.push(
            `  | ${m.metric} | ${m.score.toFixed(2)} | ${req} | ${m.observation.slice(0, 100)} |`
          );
        }
      } else {
        lines.push(`  - ${gate.summary}`);
      }
    }
    lines.push("");
  }

  // View Details link to Check Run
  if (opts?.checkRunUrl) {
    lines.push(`\n[View Details](${opts.checkRunUrl})`);
  }

  // Staleness marker (for future comment-update logic)
  if (opts?.headSha) {
    lines.push(
      `\n<!-- cogni:summary v1 sha=${opts.headSha.slice(0, 7)} ts=${Date.now()} -->`
    );
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function verdictLabel(status: GateStatus): string {
  switch (status) {
    case "pass":
      return "\u2705 PASS";
    case "fail":
      return "\u274C FAIL";
    default:
      return "\u26A0\uFE0F NEUTRAL";
  }
}

function statusEmoji(status: GateStatus): string {
  switch (status) {
    case "pass":
      return "\u2705";
    case "fail":
      return "\u274C";
    default:
      return "\u26A0\uFE0F";
  }
}

/** Counts line: `✅ 2 passed | ❌ 1 failed | ⚠️ 0 neutral` */
function countsLine(gates: readonly GateResult[]): string {
  const pass = gates.filter((g) => g.status === "pass").length;
  const fail = gates.filter((g) => g.status === "fail").length;
  const neutral = gates.filter((g) => g.status === "neutral").length;
  return `\u2705 ${pass} passed | \u274C ${fail} failed | \u26A0\uFE0F ${neutral} neutral`;
}

/** Sort gates: fail first, then pass, then neutral. */
function sortedGates(gates: readonly GateResult[]): readonly GateResult[] {
  const order: Record<string, number> = { fail: 0, pass: 1, neutral: 2 };
  return [...gates].sort(
    (a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3)
  );
}

function formatGateSection(gate: GateResult): string {
  const lines: string[] = [];
  const emoji = statusEmoji(gate.status);

  lines.push(`### ${emoji} ${gate.gateId}\n`);
  lines.push(`${gate.summary}\n`);

  if (gate.metrics && gate.metrics.length > 0) {
    lines.push("| Metric | Score | Requirement | Observation |");
    lines.push("|--------|-------|-------------|-------------|");
    for (const m of gate.metrics) {
      const scoreBar = `${(m.score * 100).toFixed(0)}%`;
      const req = m.requirement ?? "—";
      lines.push(
        `| ${m.metric} | ${scoreBar} | ${req} | ${m.observation.slice(0, 120)} |`
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}
