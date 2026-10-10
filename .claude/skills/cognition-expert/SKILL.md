---
name: cognition-expert
description: "Session-bootstrap + cognition-delivery expert for Cogni nodes — how an agent actually receives (or fails to receive) its operating contract at session start, across Claude Code, Codex, and opencode. Points at the canon (docs/spec/node-baas-architecture.md §Cognition Substrate, scripts/agent/session-cognition.sh, nodes/operator/app/src/app/api/v1/cognition/{route,_bundle}.ts) and holds the durable mental model + hard-won gotchas that aren't obvious when you read it: the two-axis design (code-owned constitution vs hub-served knowledge index), why the SessionStart hook is NOT a universal injection surface, and why each harness needs a native full-context path. Use when touching the cognition bundle, the session-start loader, AGENTS.md/CLAUDE.md bootstrap, the .cogni/.cognition-cache.md cache, @imports, .codex/config.toml, opencode.json instructions, SESSION_BOOTSTRAP_INVARIANTS, the served orientation entry, or when debugging why a fresh agent booted without its agent-contract / replied in prose instead of the status-contract / got a truncated bundle. Triggers: 'cognition bundle', 'session-cognition.sh', 'SessionStart hook', 'agent-contract not loading', 'status-contract', 'bundle truncated', 'Output too large / Preview first 2KB', 'additionalContext', 'additionalContextLimit', 'CLAUDE.md @import', 'CLAUDE.local.md', '.cognition-cache.md', 'AGENTS.md bootstrap', 'thin pointer', 'ONE_VOICE', 'orientation IS the constitution', 'SESSION_BOOTSTRAP_INVARIANTS', 'opencode AGENTS.md', 'Codex project_doc_max_bytes', 'why did a fresh agent not follow the contract', 'cross-harness bootstrap', 'hub-empty boot', 'cognition didn't load'."
---

# cognition-expert

> How an agent's operating contract reaches its context at session start — and why that is the single most load-bearing, most-silently-broken part of the node substrate. A fresh agent that never receives its contract is an invalid agent that looks fine.

## The domain

The cognition bundle is the kickstart a node serves to every agent session: the constitution (how to behave), the mission (why this node exists), and the map (orientation + skills index + domain pointers). Canon lives in `docs/spec/node-baas-architecture.md` §Cognition Substrate; the producer is `nodes/operator/app/src/app/api/v1/cognition/{route,_bundle}.ts`; the delivery loader shared by all harnesses is `scripts/agent/session-cognition.sh`, wired via `.claude/settings.json` (Claude Code) and `.codex/config.toml` (Codex). This skill is the mental model + the gotchas those files don't state.

## The mental model — two orthogonal axes

Everything here is one of two questions. Keep them separate; conflating them is the root error.

### Axis A — OWNERSHIP: what is the bundle made of (and who can break it)

`node-baas-architecture.md:300`: **the irreducible invariants are CODE-OWNED because they must render even when the hub is empty or unreachable — a session must always bootstrap.**

| Part                                                                   | Owner                                           | Why                                                                       |
| ---------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------- |
| **Constitution** — agent-contract, status-contract, Definition of Done | **code** (`SESSION_BOOTSTRAP_INVARIANTS`)       | must render hub-independent; it is the one thing a session can never lack |
| Mission (the "why")                                                    | repo-spec `intent.mission`                      | per-node identity                                                         |
| Orientation map, skills index, domain pointers                         | **hub** (Dolt), index-first, recalled on demand | expandable, refined-in-place, compounds                                   |

**The drift to watch for (ONE_VOICE, node-template #130):** moving the constitution _into_ the hub orientation entry ("served orientation IS the constitution") makes the contract hub-dependent. That is backwards. Proof it's dangerous: when the operator agent key expired mid-session (2026-10-08), every fresh agent booted **contract-less** — because the contract was being served from the hub, not rendered from code. A code-owned constitution makes a hub outage / expired key a non-event: only the knowledge index degrades, never the contract.

### Axis B — DELIVERY: how does it reach the agent's context

**The SessionStart hook is NOT a universal injection surface.** Treat it as cache
acquisition first. Claude Code presents the cache through an instruction-file import and
reinforces the universal response rule through a project-scoped output style;
Codex can also inject the cache through uncapped hook stdout. OpenCode does not expand
`@` references, so committed project `opencode.json` names the cache in its
`instructions` array; OpenCode combines those files with root `AGENTS.md` automatically.

| harness         | instruction files                                                                                               | SessionStart hook                                                             | truncation override                                                    | proven delivery path                                  |
| --------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------- |
| **Claude Code** | project output style + `CLAUDE.md`/`AGENTS.md` + `@import`s, injected every request                             | write cache only; `Stop` validates each final response                        | **NONE** (docs: no setting/env raises it)                              | style + file/cache + deterministic response validator |
| **Codex**       | `AGENTS.md`/`AGENTS.override.md`, whole under **`project_doc_max_bytes` = 32 KiB** (silently truncates past it) | stdout as developer context, `additionalContextLimit` defaults to 2500 tokens | **`additionalContextLimit = 0`** in `.codex/config.toml` → full inject | committed floor + hook-delivered live cache           |
| **OpenCode**    | root `AGENTS.md` + `opencode.json` `instructions` files, combined automatically                                 | no SessionStart injection                                                     | n/a                                                                    | committed floor + instruction-loaded warm cache       |

Keep the committed root `AGENTS.md` **< 32 KiB** so Codex never truncates its cold-boot floor.

## Hard-won gotchas (the stuff that burns a whole session)

- **"Output too large (14.8KB) … Preview (first 2KB)" is the Claude Code hook spill**, not a display quirk. The agent only has the first ~2KB; the rest is in a `tool-results/hook-*.txt` file it will not read. This hits `additionalContext` identically to raw stdout — the structured channel does NOT escape the cap. Keep the Claude hook write-only.
- **No Claude Code knob exists** to raise the hook cap (verified: `--help`, env, settings). Do not look for one; use the file channel.
- **Delivery does not guarantee adherence.** `/context` can show the complete floor and
  cache while the model still invents a task-type exception. Claude's project-scoped
  `Cogni Contract` output style moves the no-exceptions response rule into the system-prompt
  layer on every request. The `validate-status-contract.sh` Stop hook rejects malformed final
  responses, zero-evidence substantive proposals, and frozen-state mutations. Both adapters
  point back to the file floor; neither owns a second copy of the rich contract.
- **Envelope compliance does not guarantee process adherence.** A correctly shaped response
  that proposes with `Followed = —`, reports zero sources, or has no retrieval actions in the
  turn trace is still a hard FAIL. Grade delivery → envelope → research trace → substantive
  synthesis → state continuity in that order. Never call a table-only shell a passing agent.
- **`Followed` is the evidence ledger, not a sample.** The trace can prove excellent research
  while the visible reply still fails provenance by citing only two convenient work items. Every
  material orientation, skill/guide, hub entry, design/code source, and work item that shaped the
  proposal must appear as a human URL in contract order. A local repo path is citable: convert it
  to `https://github.com/<owner>/<repo>/blob/<HEAD_SHA>/<path>` (plus a line anchor when useful).
  The source count in `ETA · Conf` must not exceed the distinct URLs in `Followed`.
- **@import of an ABSENT file renders as literal text**, not empty-expansion. On a true first boot the hook writes the cache _during_ SessionStart — too late for the same session's `@import`, which resolves at context assembly. **Warm the cache in the pre-session step** (`scripts/conductor-worktree-setup.sh`) so first boot is non-empty; otherwise first boot is truncated and only the second boot is full.
- **A failed hook fetch must not clobber the cache** — the loader only writes when the fetch returns non-empty, so a warm cache survives an expired key / hub outage. This is load-bearing: it's why warm workspaces keep working through an outage.
- **Codex parity:** `.codex/config.toml` must keep `additionalContextLimit = 0`. Without it Codex head/tail-spills the bundle and cuts the middle of the contract.
- **OpenCode version drift is real:** it does not expand `@` references in `AGENTS.md`, but
  current official rules document that `opencode.json` `instructions` files are combined with
  `AGENTS.md`. Keep the repo-owned adapter and still prove received context on the installed
  version; a parsed config is necessary evidence, not the live-model acceptance proof.
- **Hook output and project instructions are different layers.** Codex's
  `project_doc_max_bytes` limits discovered `AGENTS.md`, not the hook-delivered live bundle;
  `additionalContextLimit = 0` disables spilling for that hook path.
- **Session delivery and fleet distribution are different proofs.** A fix in the operator repo
  proves neither existing-node adoption nor developer-zero-config. Rich Dolt cognition is
  write-once/live-fetched; shared runtime behavior belongs in a versioned `@cogni/*` cohort;
  root harness files require a narrow versioned, precondition-hashed materializer because they
  must exist before packages or network. New nodes inherit from node-template. Existing per-node
  PRs are interim migration debt until dependabot-for-nodes automates the upgrade lane. Never
  resurrect fork-wide source overlay, and never call a change fleet-complete while developers
  hand-edit Claude/Codex/OpenCode configuration.

## When you touch this, in order

1. **Separate the axes.** Is the problem ownership (what's in the bundle) or delivery (how it arrives)? Fix the right one.
2. **Constitution stays code-owned.** Never move the agent-contract/invariants into a hub entry that only renders on a healthy hub. If you find it there, that's the drift — pull it back to `SESSION_BOOTSTRAP_INVARIANTS`.
3. **Deliver through the proven harness path.** Claude = project output style + file import +
   deterministic Stop validation; Codex = committed
   floor + uncapped hook; OpenCode = committed floor + `opencode.json` instruction file.
4. **AGENTS.md carries only the universal floor + bootstrap pointers**
   (`node-baas-architecture.md:311`) — the terse response/state skeleton, bundle pointer,
   and self-serve fallback. It must not copy expandable orientation, skills, domains, or
   the full rich contract.
5. **Prove on the live harness.** The only proof is a fresh spawn (`claude -p` headless, or a
   real session) whose trace shows the required research before its first substantive proposal,
   whose `Followed` exhaustively links the material sources actually consulted, and which sustains frozen state on the
   next turn — AND a hub-down/expired-key boot that still renders the constitution. Byte
   round-trips, `/context`, and table shape are necessary but not sufficient.
6. **Prove distribution separately.** Name the bootstrap cohort/materializer version, show which
   nodes have adopted it, and show that a fresh developer clone receives the harness files without
   manual configuration. Operator success is the canary, not fleet completion.

## Canonical sources

| What                                                                            | Where                                                                                                                                                                              |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cognition Substrate design (two axes, ownership split, thin-AGENTS.md boundary) | `docs/spec/node-baas-architecture.md` §Cognition Substrate (`:282-311`)                                                                                                            |
| The delivery loader (fetch → cache → emit per runtime)                          | `scripts/agent/session-cognition.sh`                                                                                                                                               |
| The bundle producer + `SESSION_BOOTSTRAP_INVARIANTS`                            | `nodes/operator/app/src/app/api/v1/cognition/{route,_bundle}.ts`                                                                                                                   |
| Harness wiring                                                                  | `.claude/settings.json`, `.claude/output-styles/Cogni Contract.md`, `scripts/agent/validate-status-contract.sh`, `.codex/config.toml`, `opencode.json`, root `AGENTS.md`           |
| Harness docs                                                                    | Claude Code memory/hooks (code.claude.com/docs/en/{memory,hooks}), Codex prompting/config (developers.openai.com), OpenCode V2 instructions (dev.opencode.ai/v2/docs/instructions) |
| What becomes a skill vs hub entry vs spec                                       | [`knowledge-syntropy-expert`](../knowledge-syntropy-expert/SKILL.md)                                                                                                               |
