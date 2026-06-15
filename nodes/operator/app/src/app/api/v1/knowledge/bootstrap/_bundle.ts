// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/knowledge/bootstrap/_bundle`
 * Purpose: Pure composition of the session-start kickstart bundle — the
 *   irreducible tooling invariants (code-owned) plus the markdown renderer
 *   that frames hub-delivered skills + domain pointers for a SessionStart hook.
 * Scope: Pure functions + the invariants constant. No I/O, no env, no container.
 * Invariants:
 *   - IRREDUCIBLE_INVARIANTS_ALWAYS_PRESENT: the constant is the one piece of
 *     cognition that must render even when the hub is empty/unreachable.
 *   - INDEX_NOT_CONTENT: renders pointers (title + use-when + recall path), not
 *     full entry bodies.
 * Side-effects: none
 * Links: docs/spec/node-baas-architecture.md
 * @internal
 */

import type {
  BootstrapDomainPointer,
  BootstrapSkillPointer,
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
  "Definition of Done = merged AND deploy_verified: flight to candidate-a, post a /validate-candidate scorecard, observe your own request in Loki at the deployed SHA.",
  "Clean architecture: strict typing (no `any`), Zod boundaries, hexagonal layering, Pino→Loki observability, idempotent ops. Purge legacy — no backwards-compat shims unless the user asks.",
  "Durable learning refines back into the knowledge hub (rare, recall→refine over write-new), never inline comments or docs sprawl.",
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

/** First non-empty content line, stripped of markdown emphasis, ≤160 chars. */
export function deriveUseWhen(content: string, fallback: string): string {
  const firstLine = content
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  const raw = firstLine ?? fallback;
  const cleaned = raw.replace(/[*_`#>]/g, "").trim();
  return cleaned.length > 160 ? `${cleaned.slice(0, 157)}…` : cleaned;
}

export interface RenderBundleInput {
  node: string;
  origin: string;
  buildSha: string;
  toolingInvariants: readonly string[];
  skillsIndex: readonly BootstrapSkillPointer[];
  domainPointers: readonly BootstrapDomainPointer[];
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
          .map((s) => `| \`${s.id}\` | ${s.entryType} | ${s.useWhen} |`)
          .join("\n")
      : "| _(none merged yet)_ | | |";

  const domainRows =
    domainPointers.length > 0
      ? domainPointers
          .map(
            (d) =>
              `| \`${d.domain}\` | ${d.entryCount} | ${d.description ?? ""} |`
          )
          .join("\n")
      : "| _(none)_ | | |";

  return [
    `# Cogni \`${node}\` — Session Cognition (live from the knowledge endpoint · build \`${buildSha}\`)`,
    "",
    `> Delivered at session start from ${origin}/api/v1/knowledge/bootstrap — this replaces git-synced AGENTS.md sprawl. Re-fetch any time.`,
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
    "- Contribute durable knowledge: `/contribute-knowledge-to-cogni` (recall both planes → refine in place > write new)",
    "",
  ].join("\n");
}
