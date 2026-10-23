// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/cognition/_bundle`
 * Purpose: Pure composition of the session-start kickstart bundle — the
 *   irreducible tooling invariants (code-owned) plus the markdown renderer
 *   that frames the hub-delivered governing index + domain pointers for a
 *   SessionStart hook.
 * Scope: Pure functions + the invariants constant. No I/O, no env, no container.
 * Invariants:
 *   - INVARIANTS_ARE_THE_FLOOR: the code-owned `SESSION_BOOTSTRAP_INVARIANTS` +
 *     watch-gate render UNCONDITIONALLY — they are the always-present contract
 *     spine that survives an empty/unreachable hub and the common fresh-node
 *     case (story.5070). A served orientation renders ALONGSIDE as the node MAP,
 *     augmenting the floor, never replacing it. This reverses the earlier
 *     ONE_VOICE suppression (task.5155), whose real defect was that a map-only
 *     orientation then dropped the contract entirely.
 *   - ORIENTATION_LOADED_IN_FULL: renders pointers (id + title + recall path)
 *     for skills/domains, but the current-node `<slug>-agent-orientation` entry
 *     is rendered IN FULL — the node MAP that rides alongside the invariant
 *     floor, so the git skeleton stays minimal and the Dolt orientation carries
 *     the node-specific substance.
 *   - GOALS_AFTER_MISSION: the approved DAO goals (`listActiveGoals`) render as
 *     `## Goals` right after the orientation, title + content verbatim; zero
 *     goals renders `no approved goals`, a read failure `goals unavailable: …`.
 *   - GOVERNING_INDEX_IN_CONTEXT (guidance-routing-design): the session index is
 *     the hub's governing index (`listGoverningIndex`) — id, type, domain,
 *     useWhen — never a skills-only subset and never bodies.
 *   - WHOLE_BUNDLE_BUDGET_64KIB: the whole rendered bundle stays within
 *     `WHOLE_BUNDLE_BUDGET_BYTES`. Past it, the governing section carries only
 *     the `method` shelf inline and points the agent at
 *     `/api/v1/knowledge/index?domain=<shelf>` for the rest (approach T).
 * Side-effects: none
 * Links: https://cognidao.org/knowledge/node-baas-substrate-model
 * @internal
 */

import type {
  CognitionDomainPointer,
  CognitionGoverningPointer,
} from "@cogni/node-contracts";

/**
 * No producer-side byte ceiling (story.5070).
 *
 * The loader writes `.cogni/.cognition-cache.md`, then each harness uses its
 * native full-context path: Claude Code `@import` (up to 4 MiB), Codex hook
 * stdout with `additionalContextLimit = 0`, and OpenCode `opencode.json`
 * instructions. Claude Code's SessionStart stdout/`additionalContext` is NOT a
 * safe delivery surface — it caps large output with no override — so no
 * universal hook-injection path or serve-side ceiling is assumed. The former
 * 16 KB cap (bug.5284) capped
 * the SSoT itself and blocked realistic growth; the bundle is human-curated in
 * Dolt, not user-generated. See https://cognidao.org/knowledge/node-baas-substrate-model
 * Substrate and the `cognition-expert` skill.
 */

/**
 * The irreducible session contract. This is the ONLY cognition that is
 * code-owned rather than hub-delivered: it must survive an empty or unreachable
 * hub so every session still bootstraps. Everything expandable (skills, guides,
 * domain expertise) is delivered live from the knowledge hub on top of this.
 */
export const SESSION_BOOTSTRAP_INVARIANTS: readonly string[] = [
  "ONE work item + ONE node per session — it is your plan and your checklist. Claim it, then write the definition of done as an ordered checklist in `outcome` BEFORE you act; heartbeat; link your PR. You are not done until every box is checked and proven; coordination.nextAction is authoritative and may add boxes.",
  "Cite before you act. Recall first — your <slug>-agent-orientation, then skills/guides → this hub (/api/v1/knowledge?domain=) → our code (node-template, operator) → external OSS; merged + your own open branch. Refine in place over adding new. Every checklist step names the skill/guide/entry it follows; an uncited step is the exception you justify.",
  "Follow the CICD checklist exactly — recall it, never improvise the mechanism: branch → PR → a fresh /review-implementation while CI runs (never the implementer) → APPROVE + CI green at one head SHA → flight that SHA THROUGH the operator (POST /api/v1/vcs/flight — never a personal `gh` dispatch) → /validate-candidate → /closeout: operator merge (POST /api/v1/vcs/merge) → promote. NEVER enter the merge queue or enable auto-merge before review and validate pass. Watch each async gate (CI, flight, deploy) the ONE portable way — see <watch-gate> below.",
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

/**
 * WHOLE_BUNDLE_BUDGET_64KIB (guidance-routing-design). Harness limits do not
 * bind (Claude Code `@import` accepts 4 MiB, Codex is uncapped); the cap
 * protects model context — about 16k tokens, 8% of a 200k window.
 */
export const WHOLE_BUNDLE_BUDGET_BYTES = 64 * 1024;

/** The shelf rendered inline when the whole index no longer fits the budget. */
const INLINE_FALLBACK_SHELF = "method";

const utf8Bytes = (text: string): number =>
  new TextEncoder().encode(text).byteLength;

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
 * The domain scan that discovers orientation entries only reads the newest
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

/** One approved DAO goal as the bundle renders it (title + content verbatim). */
export interface GoalView {
  id: string;
  title: string;
  content: string;
  /** The goal's deadline, read from the `evaluate_at` column — never parsed from content. */
  evaluateAt: Date | null;
}

/**
 * The Goals section state. `unavailable` is a visible line, never an omitted
 * section (NO_GOALS_FAILS_LOUD): a session must be able to tell "no goals" from
 * "could not read goals".
 */
export type GoalsSection =
  | { status: "ok"; goals: readonly GoalView[] }
  | { status: "unavailable"; reason: string };

/** Minimal read surface `resolveGoals` needs — `KnowledgeStorePort.listActiveGoals`. */
export interface GoalsLookupPort {
  listActiveGoals(): Promise<readonly GoalView[]>;
}

/**
 * Read the approved DAO goals by one direct query — not the PER_DOMAIN_LIMIT
 * domain scan, which silently drops older rows (bug.5280). Any failure,
 * including `TooManyActiveGoalsError` (MAX_THREE_GOALS) or an unconfigured hub,
 * becomes a visible `unavailable` state rather than a missing section.
 */
export async function resolveGoals(
  port: GoalsLookupPort | undefined
): Promise<GoalsSection> {
  if (!port) {
    return { status: "unavailable", reason: "knowledge hub not configured" };
  }
  try {
    const goals = await port.listActiveGoals();
    return {
      status: "ok",
      goals: goals.map((g) => ({
        id: g.id,
        title: g.title,
        content: g.content,
        evaluateAt: g.evaluateAt,
      })),
    };
  } catch (e) {
    return {
      status: "unavailable",
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

/** `YYYY-MM-DD` from the `evaluate_at` column, or an explicit gap marker. */
function goalDeadline(evaluateAt: Date | null): string {
  return evaluateAt ? evaluateAt.toISOString().slice(0, 10) : "no deadline set";
}

/**
 * Render the `## Goals` section lines: per goal its title, the deadline from
 * the `evaluate_at` column (never parsed from content), then content verbatim.
 */
export function renderGoalsLines(goals: GoalsSection): string[] {
  const head = ["", "## Goals", ""];
  if (goals.status === "unavailable") {
    return [...head, `goals unavailable: ${escapeCell(goals.reason)}`];
  }
  if (goals.goals.length === 0) return [...head, "no approved goals"];
  return [
    ...head,
    ...goals.goals.flatMap((g, i) => [
      ...(i > 0 ? [""] : []),
      `### ${g.title}`,
      "",
      `By: ${goalDeadline(g.evaluateAt)} · \`${g.id}\``,
      "",
      g.content,
    ]),
  ];
}

export interface RenderBundleInput {
  node: string;
  name: string;
  mission: string | null;
  generatedAt: string;
  origin: string;
  buildSha: string;
  toolingInvariants: readonly string[];
  /** The hub's governing index (`KnowledgeStorePort.listGoverningIndex`). */
  governingIndex: readonly CognitionGoverningPointer[];
  domainPointers: readonly CognitionDomainPointer[];
  /** The current node's `<slug>-agent-orientation` entry (full), or null if unseeded. */
  orientation: OrientationEntry | null;
  /** Approved DAO goals, rendered right after the mission/orientation. */
  goals: GoalsSection;
}

/**
 * Render the kickstart bundle as GFM markdown. A SessionStart hook echoes this
 * verbatim to stdout; Claude Code and Codex both inject SessionStart stdout
 * into the model's context.
 *
 * WHOLE_BUNDLE_BUDGET_64KIB: renders the whole governing index inline when the
 * bundle fits `WHOLE_BUNDLE_BUDGET_BYTES`; otherwise re-renders with only the
 * `method` shelf inline plus a pointer to pull other shelves (approach T).
 */
export function renderBundle(input: RenderBundleInput): RenderedBundle {
  const whole = renderWith(input, "whole-index");
  const wholeBytes = utf8Bytes(whole);
  if (wholeBytes <= WHOLE_BUNDLE_BUDGET_BYTES)
    return {
      markdown: whole,
      governingRender: { mode: "whole-index", wholeBytes },
    };
  return {
    markdown: renderWith(input, "shelf-pointer"),
    governingRender: { mode: "shelf-pointer", wholeBytes },
  };
}

/** `renderBundle(input).markdown`. */
export function renderBundleMarkdown(input: RenderBundleInput): string {
  return renderBundle(input).markdown;
}

/** Which governing section the bundle rendered: the whole index, or the `method` shelf plus a shelf-pull pointer. */
export type GoverningMode = "whole-index" | "shelf-pointer";

/** The rendered bundle plus how its governing section was rendered (eval row 0 reads this). */
export interface RenderedBundle {
  markdown: string;
  governingRender: {
    mode: GoverningMode;
    /** UTF-8 bytes of the whole-index render, whether or not it was served. */
    wholeBytes: number;
  };
}

/** The governing section lines for one render mode. */
function governingLines(
  rows: readonly CognitionGoverningPointer[],
  mode: GoverningMode,
  origin: string
): string[] {
  const inline =
    mode === "whole-index"
      ? rows
      : rows.filter((r) => r.domain === INLINE_FALLBACK_SHELF);
  const tableRows =
    inline.length > 0
      ? inline.map(
          (r) =>
            `| \`${r.id}\` | ${r.entryType} | ${r.domain} | ${escapeCell(r.useWhen)} |`
        )
      : ["| _(none merged yet)_ | | | |"];
  const lead =
    mode === "whole-index"
      ? "Every skill, guide, playbook, rule, design, decision and reference on this hub. " +
        `Pick the rows whose use-when matches your task, then read each chosen entry (\`GET ${origin}/api/v1/knowledge/{id}\`) before acting.`
      : `_The governing index (${rows.length} rows) exceeds the 64 KiB bundle budget, so only the \`${INLINE_FALLBACK_SHELF}\` shelf is inline. ` +
        `Pick 1–3 shelves from the domains below and pull each with \`GET ${origin}/api/v1/knowledge/index?domain=<shelf>\`; ` +
        "keep only skill, guide, playbook, rule, design, decision and reference rows, then read each chosen entry before acting._";
  return [
    "## Governing index — pick by use-when, read before acting",
    "",
    lead,
    "",
    "| entry | type | domain | use when |",
    "| --- | --- | --- | --- |",
    ...tableRows,
  ];
}

function renderWith(input: RenderBundleInput, mode: GoverningMode): string {
  const {
    node,
    name,
    mission,
    generatedAt,
    origin,
    buildSha,
    toolingInvariants,
    orientation,
    goals,
  } = input;
  const { governingIndex, domainPointers } = input;
  // "2026-06-16 14:20" — human date, not an ISO wall of digits.
  const loadedAt = generatedAt.replace("T", " ").slice(0, 16);
  const subtitle = [
    mission,
    `${governingIndex.length} governing entries`,
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

  const domainRows =
    domainPointers.length > 0
      ? domainPointers
          .map(
            (d) =>
              `| \`${d.domain}\` | ${d.entryCount} | ${escapeCell(d.description)} |`
          )
          .join("\n")
      : "| _(none)_ | | |";

  // The node MAP that rides alongside the invariant floor: the current-node
  // orientation entry rendered IN FULL (no second recall). Falls back to a seed
  // prompt when unset so the convention surfaces even before the entry exists.
  const orientationLines = orientation
    ? ["## Orientation — recall this first", "", orientation.content]
    : [
        "## Orientation — recall this first",
        "",
        `_No \`${name}-agent-orientation\` entry yet. Recall the hub, then seed one — the current-node operating map for agents (what this node is, where authority lives, what's safe, what to recall next) — and refine it as the repo changes._`,
      ];

  // THE INVARIANT FLOOR — rendered UNCONDITIONALLY (story.5070). The code-owned
  // `SESSION_BOOTSTRAP_INVARIANTS` + watch-gate are the always-present contract
  // spine: they must survive an empty/unreachable hub AND the common fresh-node
  // case where the hub serves only a map-only orientation. The earlier ONE_VOICE
  // suppression (task.5155) dropped this floor whenever ANY orientation was
  // served — so a map-only orientation silently shipped a session with no
  // contract at all. The orientation above now renders ALONGSIDE as the node
  // MAP (augment, never replace), not instead of the floor.
  //
  // DRY / migration note: orientations are being reduced to map-only (what this
  // node is, where authority lives, what to recall next) and MUST NOT restate
  // these terse axioms — the invariants are now the single always-present source
  // of the contract. Stripping any residual axiom prose still embedded in a hub
  // orientation entry is the migration's concern, tracked separately (story.5070
  // step 7, human-merge-gated hub Dolt edit).
  const toolingFloor = [
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
    ...renderGoalsLines(goals),
    ...toolingFloor,
    "",
    ...governingLines(governingIndex, mode, origin),
    "",
    "## Knowledge domains — RECALL_BEFORE_WRITE",
    "",
    "| domain | entries | about |",
    "| --- | --- | --- |",
    domainRows,
    "",
    // The node-relative endpoint contract — always rendered. A hub entry
    // structurally cannot carry it because `origin` is only known per-request.
    // Without it agents fall back to harness-local slash commands that hardcode
    // the operator apex and file every node's work onto operator.
    "## Work items — this node's own ledger",
    "",
    `Your items live in THIS node's store (\`${origin}\`) — each node owns its own \`knowledge_<slug>\` database, so there is no central ledger to fall back to. ONE work item + ONE node per session.`,
    "",
    `- Find work: \`GET ${origin}/api/v1/work/items?statuses=needs_implement,needs_design\` — adopt over create.`,
    `- File one: \`POST ${origin}/api/v1/work/items\` \`{type,title,summary,outcome}\` — \`type\` ∈ task|bug|story|spike|subtask; the server allocates the id, never send one.`,
    `- Progress: \`PATCH ${origin}/api/v1/work/items/{id}\` \`{"set":{...}}\` — the wrapper is \`set\`, NOT \`patch\`.`,
    "- `status` ∈ needs_triage|needs_research|needs_design|needs_implement|needs_closeout|needs_merge|done|blocked|cancelled. There is no `in_progress`.",
    '- Close with `{"set":{"status":"done"}}` only after the PR merges.',
    `- Machine schemas for the two writes: \`GET ${origin}/.well-known/agent.json\` → \`actions.createWorkItem\` / \`actions.updateWorkItem\`.`,
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
