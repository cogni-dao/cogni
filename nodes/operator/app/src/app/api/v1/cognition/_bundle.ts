// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/cognition/_bundle`
 * Purpose: Pure composition of the session-start kickstart bundle — the
 *   irreducible tooling invariants (code-owned) plus the markdown renderer
 *   that frames hub-delivered skills + domain pointers for a SessionStart hook.
 * Scope: Pure functions + the invariants constant. No I/O, no env, no container.
 * Invariants:
 *   - IRREDUCIBLE_INVARIANTS_ALWAYS_PRESENT: the constant is the one piece of
 *     cognition that must render even when the hub is empty/unreachable.
 *   - INDEX_NOT_CONTENT: renders pointers (id + title + recall path), not
 *     entry bodies or excerpts.
 * Side-effects: none
 * Links: docs/spec/node-baas-architecture.md
 * @internal
 */

import type {
  CognitionDomainPointer,
  CognitionSkillPointer,
} from "@cogni/node-contracts";

/**
 * The irreducible session contract. This is the ONLY cognition that is
 * code-owned rather than hub-delivered: it must survive an empty or unreachable
 * hub so every session still bootstraps. Everything expandable (skills, guides,
 * domain expertise) is delivered live from the knowledge hub on top of this.
 */
export const SESSION_BOOTSTRAP_INVARIANTS: readonly string[] = [
  "Adopt exactly ONE production work item and ONE node per session (single-node-scope is a CI gate). Claim + heartbeat + link PR via /api/v1/work/items/{id}/{claims,heartbeat,pr,coordination}; coordination.nextAction is authoritative.",
  "RECALL the node knowledge hub before designing or researching (RECALL_BEFORE_WRITE) — two planes: merged (/api/v1/knowledge?domain=) AND your own open contribution branch (GET /contributions/{id}/diff).",
  "Every code change flows through the operator. Align to existing specs/skills/prior code before writing; refine and simplify in place over adding parallel artifacts.",
  "Push to a feature branch and let CI verify — do not run broad local check/build suites. Monitor `gh pr checks` to green.",
  "Definition of Done = merged AND validated on candidate-a: flight the PR, exercise the changed surface against the live deployed URL, read your own request back from Loki at the deployed SHA, then post a /validate-candidate scorecard on the PR. The posted scorecard IS the validation signal — not a work-item flag to flip.",
  "Clean architecture: strict typing (no `any`), Zod boundaries, hexagonal layering, Pino→Loki observability, idempotent ops. Purge legacy — no backwards-compat shims unless the user asks.",
  "Durable learning refines back into the knowledge hub (rare, recall→refine over write-new), never inline comments or docs sprawl.",
  "A new knowledge entry nearly always cites an existing one (supports/contradicts/extends/supersedes) so the hub compounds as a DAG, not islands — cite freely across planes; an entry on your open branch may cite one already merged to main, and the edge goes live in main's DAG when your contribution merges.",
];

const COGNITION_ENTRY_TYPES: ReadonlySet<string> = new Set([
  "skill",
  "guide",
  "playbook",
]);

/** True for hub entries that belong in an agent's actionable skills index. */
export function isCognitionEntry(entryType: string | undefined): boolean {
  return COGNITION_ENTRY_TYPES.has(entryType ?? "");
}

/** Make a string safe to drop into a GFM table cell (no `|`, no line breaks). */
export function escapeCell(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/\s*\r?\n\s*/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

export interface RenderBundleInput {
  node: string;
  origin: string;
  buildSha: string;
  toolingInvariants: readonly string[];
  skillsIndex: readonly CognitionSkillPointer[];
  domainPointers: readonly CognitionDomainPointer[];
}

/**
 * Render the kickstart bundle as GFM markdown. A SessionStart hook echoes this
 * verbatim to stdout; Claude Code and Codex both inject SessionStart stdout
 * into the model's context.
 */
export function renderBundleMarkdown(input: RenderBundleInput): string {
  const { node, origin, buildSha, toolingInvariants, skillsIndex } = input;
  const domainPointers = input.domainPointers;

  const invariants = toolingInvariants
    .map((line, i) => `${i + 1}. ${line}`)
    .join("\n");

  const skillRows =
    skillsIndex.length > 0
      ? skillsIndex
          .map(
            (s) => `| \`${s.id}\` | ${s.entryType} | ${escapeCell(s.title)} |`
          )
          .join("\n")
      : "| _(none merged yet)_ | | |";

  const domainRows =
    domainPointers.length > 0
      ? domainPointers
          .map(
            (d) =>
              `| \`${d.domain}\` | ${d.entryCount} | ${escapeCell(d.description)} |`
          )
          .join("\n")
      : "| _(none)_ | | |";

  return [
    `# Cogni \`${node}\` — Session Cognition (live from the knowledge endpoint · build \`${buildSha}\`)`,
    "",
    `> Delivered at session start from ${origin}/api/v1/cognition — this replaces git-synced AGENTS.md sprawl. Re-fetch any time.`,
    "",
    "## Tooling invariants (irreducible session contract)",
    "",
    invariants,
    "",
    "## Skills index (recall full content from the hub before acting)",
    "",
    "| entry | type | use when |",
    "| --- | --- | --- |",
    skillRows,
    "",
    "## Knowledge domains — RECALL_BEFORE_WRITE",
    "",
    "| domain | entries | about |",
    "| --- | --- | --- |",
    domainRows,
    "",
    "## Recall + contribute",
    "",
    `- Browse a domain: \`GET ${origin}/api/v1/knowledge?domain=<domain>\``,
    `- Full entry body: \`GET ${origin}/api/v1/knowledge/{id}\``,
    `- Discovery doc: \`GET ${origin}/.well-known/agent.json\``,
    "- Contribute durable knowledge: `/contribute-knowledge-to-cogni` (recall both planes → refine in place > write new; a new entry nearly always cites an existing one — link across planes, don't island)",
    `- Link to existing knowledge: add a citation edge in your edit — \`POST ${origin}/api/v1/knowledge/contributions/{id}/commits\` with \`{op:"cite", citingId, citedId, citationType}\`. Cross-plane cites (target already merged to main) resolve and stay valid post-merge.`,
    "",
  ].join("\n");
}
