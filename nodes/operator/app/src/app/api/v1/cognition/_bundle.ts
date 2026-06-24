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
 *   - INDEX_FIRST: renders pointers (id + title + recall path), never full entry
 *     bodies. The ONE bounded exception is a single current-node orientation
 *     excerpt (the map an agent needs to start, not just the constitution) —
 *     capped at ORIENTATION_EXCERPT_MAX chars, one entry, never a full body.
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
  "ONE production work item + ONE node per session (single-node-scope is a CI gate). Claim/heartbeat/link-PR via /api/v1/work/items/{id}/*; coordination.nextAction is authoritative.",
  "RECALL_BEFORE_WRITE: the merged hub (/api/v1/knowledge?domain=) AND your own open contribution branch (/contributions/{id}/diff).",
  "Ship every code change through the operator via the `cicd-e2e-required-sequence` guide: fork+PR → run-checks → CI green → flight + validate-candidate → merge → promote. Read-only on GitHub; never personal `gh`.",
  "Clean architecture: strict types (no `any`), Zod boundaries, hexagonal layering, Pino→Loki, idempotent ops; purge legacy, no compat shims unless asked.",
  "Durable learning refines the hub in place (recall→refine over write-new) and cites an existing entry; never inline comments or doc sprawl.",
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

/** Max length of the bounded orientation excerpt (INDEX_FIRST carve-out). */
export const ORIENTATION_EXCERPT_MAX = 480;

/** A single current-node orientation entry surfaced as a bounded excerpt. */
export interface OrientationExcerpt {
  id: string;
  excerpt: string;
}

/**
 * Bounded first-section excerpt of an orientation entry body — the agent's
 * map, not a docs dump. Takes the leading paragraph, flattens whitespace, and
 * caps length so the bundle stays INDEX_FIRST.
 */
export function excerptFromContent(
  content: string,
  maxChars: number = ORIENTATION_EXCERPT_MAX
): string {
  const firstBlock =
    content
      .trim()
      .split(/\n{2,}/)[0]
      ?.trim() ?? "";
  const flat = firstBlock.replace(/\s*\r?\n\s*/g, " ").trim();
  if (flat.length <= maxChars) return flat;
  return `${flat.slice(0, maxChars).trimEnd()}…`;
}

export interface RenderBundleInput {
  node: string;
  name: string;
  mission: string | null;
  generatedAt: string;
  origin: string;
  buildSha: string;
  toolingInvariants: readonly string[];
  skillsIndex: readonly CognitionSkillPointer[];
  domainPointers: readonly CognitionDomainPointer[];
  /** The current node's `<slug>-agent-orientation` excerpt, or null if unseeded. */
  orientation: OrientationExcerpt | null;
}

/**
 * Render the kickstart bundle as GFM markdown. A SessionStart hook echoes this
 * verbatim to stdout; Claude Code and Codex both inject SessionStart stdout
 * into the model's context.
 */
export function renderBundleMarkdown(input: RenderBundleInput): string {
  const {
    node,
    name,
    mission,
    generatedAt,
    origin,
    buildSha,
    toolingInvariants,
    orientation,
  } = input;
  const { skillsIndex, domainPointers } = input;
  // "2026-06-16 14:20" — human date, not an ISO wall of digits.
  const loadedAt = generatedAt.replace("T", " ").slice(0, 16);
  const subtitle = [
    mission,
    `${skillsIndex.length} skills`,
    `${domainPointers.length} domains`,
    `loaded ${loadedAt}`,
  ]
    .filter(Boolean)
    .join(" · ");

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

  // The map, not just the constitution: one bounded current-node orientation
  // excerpt (INDEX_FIRST carve-out). Falls back to a seed prompt when unset so
  // the convention surfaces even before the entry exists.
  const orientationLines = orientation
    ? [
        "## Orientation — recall this first",
        "",
        orientation.excerpt,
        "",
        `_Current-node operating map. Recall \`${orientation.id}\` for the full context (where to edit, what not to run, what can break prod/candidate, what to recall next), and refine it when repo layout, scripts, CI, deploy, auth, or validation change._`,
      ]
    : [
        "## Orientation — recall this first",
        "",
        `_No \`${name}-agent-orientation\` entry yet. Recall the hub, then seed one — the current-node operating map for agents (what this node is, where authority lives, what's safe, what to recall next) — and refine it as the repo changes._`,
      ];

  return [
    `# ${name} — Cogni Session Cognition`,
    "",
    `> ${subtitle}`,
    ">",
    `> Delivered at session start from ${origin}/api/v1/cognition — replaces git-synced AGENTS.md sprawl. (node \`${node}\` · build \`${buildSha}\`)`,
    "",
    ...orientationLines,
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
    `- Recall: \`GET ${origin}/api/v1/knowledge?domain=<domain>\` · entry \`/{id}\` · discovery \`/.well-known/agent.json\``,
    "- Contribute durable knowledge via `/contribute-knowledge-to-cogni` (refine in place > write new; cite an existing entry).",
    "",
  ].join("\n");
}
