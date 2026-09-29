// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/cognition/_bundle`
 * Purpose: Pure composition of the session-start kickstart bundle — the
 *   irreducible tooling invariants (code-owned) plus the markdown renderer
 *   that frames hub-delivered skills + domain pointers for a SessionStart hook.
 * Scope: Pure functions + the invariants constant. No I/O, no env, no container.
 * Invariants:
 *   - ONE_VOICE: a served orientation entry IS the constitution — the
 *     code-owned invariants + watch-gate render ONLY when no orientation
 *     exists (empty/unseeded hub fallback), never alongside it (task.5155).
 *   - ORIENTATION_LOADED_IN_FULL: renders pointers (id + title + recall path)
 *     for skills/domains, but the current-node `<slug>-agent-orientation` entry
 *     is rendered IN FULL — the bootstrap IS the agent's operating map, so the
 *     git skeleton stays minimal and the Dolt orientation carries the substance.
 * Side-effects: none
 * Links: docs/spec/node-baas-architecture.md
 * @internal
 */

import type {
  CognitionDomainPointer,
  CognitionSkillPointer,
} from "@cogni/node-contracts";

/**
 * Hard ceiling for model-visible SessionStart context.
 *
 * Codex's repo hook opts out of its approximate token spill so the middle of
 * the orientation can never disappear. That is safe only while the producer
 * enforces a strict bound. Keep the shell loader's value identical: the API
 * rejects growth at the source, and the loader independently protects stale
 * or foreign caches.
 */
export const SESSION_COGNITION_MAX_BYTES = 16 * 1024;

/** Reject an oversized bundle rather than silently removing arbitrary text. */
export function assertBundleWithinBudget(markdown: string): void {
  // Shell command substitution strips trailing newlines; the presenter then
  // restores exactly one. Count that exact model-visible stdout shape here.
  const presented = `${markdown.replace(/\n+$/, "")}\n`;
  const bytes = new TextEncoder().encode(presented).byteLength;
  if (bytes > SESSION_COGNITION_MAX_BYTES) {
    throw new Error(
      `Session cognition bundle is ${bytes} bytes; maximum is ${SESSION_COGNITION_MAX_BYTES}`
    );
  }
}

/**
 * The irreducible session contract. This is the ONLY cognition that is
 * code-owned rather than hub-delivered: it must survive an empty or unreachable
 * hub so every session still bootstraps. Everything expandable (skills, guides,
 * domain expertise) is delivered live from the knowledge hub on top of this.
 */
export const SESSION_BOOTSTRAP_INVARIANTS: readonly string[] = [
  "ONE work item + ONE node per session — it is your plan and your checklist. Claim it, then write the definition of done as an ordered checklist in `outcome` BEFORE you act; heartbeat; link your PR. You are not done until every box is checked and proven; coordination.nextAction is authoritative and may add boxes.",
  "Cite before you act. Recall first — your <slug>-agent-orientation, then skills/guides → this hub (/api/v1/knowledge?domain=) → our code (node-template, operator) → external OSS; merged + your own open branch. Refine in place over adding new. Every checklist step names the skill/guide/entry it follows; an uncited step is the exception you justify.",
  "Follow the CICD checklist exactly — recall it, never improvise the mechanism: branch → CI green → flight to candidate THROUGH the operator (POST /api/v1/vcs/flight — never a personal `gh` dispatch) → /validate-candidate → operator merge (POST /api/v1/vcs/merge) → promote. NEVER enter the merge queue or enable auto-merge before validate passes. Watch each async gate (CI, flight, deploy) the ONE portable way — see <watch-gate> below.",
  "Done = before→after behavior proven on the live candidate, NOT a SHA deployed. Capture the BROKEN signal, flight, then read the FIXED behavior back from Loki at that SHA. 'Request reached the build' is deploy proof, not function. The /validate-candidate scorecard is the merge gate; reprove prod-facing changes in preview/prod.",
  "Persist what outlives the session in the durable substrate, never a doc that rots: plan + status → the work item; durable strategy/why → operator Dolt, linked to the item (specRefs / cite edge). Specs hold contracts + invariants only — never a rollout plan.",
  "Drive autonomously; interrupt a human only for the irreversible, outward-facing, or out-of-scope — never for approval you already hold, never to merge/promote something unvalidated. When you ask: one scorecard → the single decision → a clickable link.",
];

/**
 * How to watch an async CI/CD gate — the ONE portable technique, tagged for
 * machine parse + recall. Code-owned (survives an empty hub) and XML-structured
 * so any harness (Claude, Codex, OpenAI, plain shell) extracts the exact command
 * without prose parsing. Deliberately terse: five tagged atoms, no run-on prose.
 */
export const SESSION_WATCH_GATE = `<watch-gate rule="ONE blocking command; its exit code or matched value IS the verdict — no harness-specific monitor/background/notification primitive, never fire-and-forget, re-read the ground-truth signal before reporting">
  <ci-green>gh pr checks {PR} --watch --fail-fast — blocks; 0=all pass, nonzero=failed. NOT --required (omits real gates, e.g. build). Re-read after (one-shot 8=pending) — finished ≠ green.</ci-green>
  <flight-landed>poll curl -s {candidate}/version until .buildSha == PR-head SHA → then /validate-candidate. Bound it; no match = flight FAILED, report not hang. host: test.cognidao.org ({node}-test… non-operator).</flight-landed>
  <deploy-landed>poll curl -s {target}/version until .buildSha == promoted SHA; bound, report on no-match. host: {node-}{preview,}cognidao.org.</deploy-landed>
  <truth>/version.buildSha is the only ground truth — CI and workflow "success" can lie.</truth>
</watch-gate>`;

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

/** The current-node orientation entry — rendered in full as the session map. */
export interface OrientationEntry {
  id: string;
  content: string;
}

/** Minimal read surface `resolveOrientation` needs from the knowledge store. */
export interface OrientationLookupPort {
  getKnowledge(
    id: string
  ): Promise<{ id: string; content: string } | null | undefined>;
}

/**
 * Resolve the current-node orientation entry by direct id lookup.
 *
 * The domain scan that feeds the skills index only reads the newest
 * PER_DOMAIN_LIMIT rows per domain, so once a domain outgrows the limit an
 * older `<slug>-agent-orientation` entry silently drops out of the scan and
 * the bundle reports it as unseeded (bug.5280). Direct lookup by exact id is
 * the ground truth; the scan result is only a fallback for suffix-named
 * entries, and the generic starter seed every node inherits comes last.
 */
export async function resolveOrientation(
  port: OrientationLookupPort,
  exactOrientationId: string,
  scannedOrientationId: string | null
): Promise<OrientationEntry | null> {
  const candidates = [
    exactOrientationId,
    scannedOrientationId,
    "cogni-agent-orientation",
  ];
  for (const id of candidates) {
    if (!id) continue;
    const entry = await port.getKnowledge(id);
    if (entry) {
      return { id: entry.id, content: entry.content };
    }
  }
  return null;
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
  /** The current node's `<slug>-agent-orientation` entry (full), or null if unseeded. */
  orientation: OrientationEntry | null;
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

  // The node's candidate (pre-merge flight slot) — where "validated on
  // candidate" happens. operator is the primary test apex; every other node is
  // a slugged test host. Concrete so agents stop guessing the hostname.
  const candidateHost =
    name === "operator" ? "test.cognidao.org" : `${name}-test.cognidao.org`;

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

  // The map, not just the constitution: the current-node orientation entry
  // rendered IN FULL — the bootstrap IS the orientation (no second recall).
  // Falls back to a seed prompt when unset so the convention surfaces even
  // before the entry exists.
  const orientationLines = orientation
    ? ["## Orientation — recall this first", "", orientation.content]
    : [
        "## Orientation — recall this first",
        "",
        `_No \`${name}-agent-orientation\` entry yet. Recall the hub, then seed one — the current-node operating map for agents (what this node is, where authority lives, what's safe, what to recall next) — and refine it as the repo changes._`,
      ];

  // ONE VOICE: when the hub serves an orientation, it IS the constitution —
  // the code-owned invariants + watch-gate would restate it in different words
  // (the two-constitution bundle agents flailed past, task.5155). They render
  // ONLY as the empty-hub fallback, their original design intent.
  const fallbackConstitution = orientation
    ? []
    : [
        "",
        "## Tooling invariants",
        "",
        invariants,
        "",
        `_Your candidate (flight + validate target): \`https://${candidateHost}\` · Loki namespace \`cogni-candidate-a\`._`,
        "",
        "## Watch an async gate — CI · flight · deploy",
        "",
        SESSION_WATCH_GATE,
      ];

  return [
    `# ${name} — Cogni Session Cognition`,
    "",
    `> ${subtitle}`,
    ">",
    `> Delivered at session start from ${origin}/api/v1/cognition — replaces git-synced AGENTS.md sprawl. (node \`${node}\` · build \`${buildSha}\`)`,
    "",
    ...orientationLines,
    ...fallbackConstitution,
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
