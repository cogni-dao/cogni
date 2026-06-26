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
  "Adopt exactly ONE work item and ONE node per session (single-node-scope is a CI gate); claim + heartbeat + link the PR via /api/v1/work/items/{id}/{claims,heartbeat,pr}; coordination.nextAction is authoritative.",
  "RECALL the node knowledge hub before designing, researching, or coding — both merged (/api/v1/knowledge?domain=) and your own open contribution branch — and refine in place over creating new.",
  "Git path: push a same-repo feature branch, open a PR, and let CI verify the exact head (gh pr checks). Flight that PR head to candidate-a before merge. The operator is the deploy plane only — flight, logs, secrets — not where code, work items, or knowledge live.",
  "Definition of Done = validated on candidate-a, not merely merged: flight the PR, exercise the live deployed surface, read your own request back from Loki at the deployed SHA, and post a /validate-candidate scorecard — that posted scorecard is the merge gate.",
  "Recall this node's <slug>-agent-orientation entry for the operating map — architecture and observability standards, what's safe to run, what can break prod/candidate, and what to recall next — and refine it in the hub as the node changes.",
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
    `- Browse a domain: \`GET ${origin}/api/v1/knowledge?domain=<domain>\``,
    `- Full entry body: \`GET ${origin}/api/v1/knowledge/{id}\``,
    `- Discovery doc: \`GET ${origin}/.well-known/agent.json\``,
    "- Contribute durable knowledge: `/contribute-knowledge-to-cogni` (refine in place > write new).",
    `- Cite an existing entry in your edit: \`POST ${origin}/api/v1/knowledge/contributions/{id}/commits\` with \`{op:"cite", citingId, citedId, citationType}\` — cross-plane cites (target on main) resolve and stay valid post-merge.`,
    "",
  ].join("\n");
}
