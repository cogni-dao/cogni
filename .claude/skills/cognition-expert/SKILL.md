---
name: cognition-expert
description: "Session-bootstrap + cognition-delivery expert for Cogni nodes — how an agent actually receives (or fails to receive) its operating contract at session start, across Claude Code, Codex, and opencode. Points at the canon (docs/spec/node-baas-architecture.md §Cognition Substrate, scripts/agent/session-cognition.sh, nodes/operator/app/src/app/api/v1/cognition/{route,_bundle}.ts) and holds the durable mental model + hard-won gotchas that aren't obvious when you read it: the two-axis design (hub-owned complete contract vs code-owned delivery and recovery), why the SessionStart hook is NOT a universal injection surface, and why each harness needs a native full-context path. Use when touching the cognition bundle, the session-start loader, AGENTS.md/CLAUDE.md bootstrap, the .cogni/.cognition-cache.md cache, @imports, .codex/config.toml, opencode.json instructions, SESSION_BOOTSTRAP_INVARIANTS, the served orientation entry, or when debugging why a fresh agent booted without its agent-contract / replied in prose instead of the status-contract / got a truncated bundle. Triggers: 'cognition bundle', 'session-cognition.sh', 'SessionStart hook', 'agent-contract not loading', 'status-contract', 'bundle truncated', 'Output too large / Preview first 2KB', 'additionalContext', 'additionalContextLimit', 'CLAUDE.md @import', 'CLAUDE.local.md', '.cognition-cache.md', 'AGENTS.md bootstrap', 'thin pointer', 'ONE_VOICE', 'orientation IS the constitution', 'SESSION_BOOTSTRAP_INVARIANTS', 'opencode AGENTS.md', 'Codex project_doc_max_bytes', 'why did a fresh agent not follow the contract', 'cross-harness bootstrap', 'hub-empty boot', 'cognition didn't load'."
---

# cognition-expert

> How an agent's operating contract reaches its context at session start — and why that is the single most load-bearing, most-silently-broken part of the node substrate. A fresh agent that never receives its contract is an invalid agent that looks fine.

## The domain

The cognition bundle is the kickstart a node serves to every agent session: rich operating guidance, the mission, and the map (orientation + skills index + domain pointers). Recall the canonical [ownership and delivery contract](https://cognidao.org/knowledge/cognition-substrate-bootstrap) before editing; it supersedes the retired `docs/spec/node-baas-architecture.md` reference. The producer is `nodes/operator/app/src/app/api/v1/cognition/{route,_bundle}.ts`; the shared delivery loader is `scripts/agent/session-cognition.sh`. This skill supplies the trigger and implementation gotchas.

## The mental model — two orthogonal axes

Everything here is one of two questions. Keep them separate; conflating them is the root error.

### Axis A — OWNERSHIP: what is the bundle made of (and who can break it)

**The complete normal response contract is hub-owned: shape and semantics travel together.**
Root `AGENTS.md` owns terse bootstrap, local execution safety, and bounded recovery. It
must not retain response tables, frozen-state rules, or a competing normal communication
protocol. The output style points to the loaded bundle without restating its rules.

| Part                                                                     | Owner                                                         | Why                                                            |
| ------------------------------------------------------------------------ | ------------------------------------------------------------- | -------------------------------------------------------------- |
| Bootstrap, execution safety, and missing-contract recovery               | code: root `AGENTS.md` and loader                             | a cold session can recover without inventing a second contract |
| Complete response format, process and status semantics, node orientation | hub: the node's Dolt orientation, delivered through cognition | one versioned home for the whole normal operating contract     |
| Mission                                                                  | repo-spec `intent.mission`                                    | per-node identity                                              |
| Skills and domain map                                                    | hub                                                           | index-first recall                                             |
| Last-known complete projection                                           | gitignored cognition cache                                    | normal offline sessions retain the complete contract           |

**The drift to watch for:** deleting a hub template while leaving one in AGENTS reverses
this split; deleting both leaves no response format. Verify the destination's complete
template before removing competing copies. Never equate a nonempty map or semantics-only
contract section with a complete bundle. If no complete contract is loaded, stay in
bounded bootstrap recovery; AGENTS and skills cannot substitute for normal cognition.

### Axis B — DELIVERY: how does it reach the agent's context

**The SessionStart hook is NOT a universal injection surface.** Treat it as cache
acquisition first. Claude Code presents the cache through a `CLAUDE.md` instruction-file
import and reinforces adherence to that loaded contract through a project-scoped output style;
Codex injects the cache through uncapped hook stdout. OpenCode does not expand `@`
references; the supported 1.x runtime combines the cache through
`opencode.json.instructions`.

| harness          | instruction files                                                                                               | SessionStart hook                                                               | truncation override                                                    | proven delivery path                                                 |
| ---------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **Claude Code**  | project output style + `CLAUDE.md`/`AGENTS.md` + `@import`s, injected every request                             | write cache only; `Stop` **warns** on a malformed final response (never blocks) | **NONE** (docs: no setting/env raises it)                              | style (primary driver) + file/cache + non-blocking response detector |
| **Codex**        | `AGENTS.md`/`AGENTS.override.md`, whole under **`project_doc_max_bytes` = 32 KiB** (silently truncates past it) | stdout as developer context, `additionalContextLimit` defaults to 2500 tokens   | **`additionalContextLimit = 0`** in `.codex/config.toml` → full inject | committed floor + hook-delivered live cache                          |
| **OpenCode 1.x** | root `AGENTS.md` + `opencode.json.instructions`                                                                 | no SessionStart injection                                                       | n/a                                                                    | committed floor + instruction-loaded warm cache                      |

Keep the committed root `AGENTS.md` **< 32 KiB** so Codex never truncates its cold-boot floor.

## Hard-won gotchas (the stuff that burns a whole session)

- **"Output too large (14.8KB) … Preview (first 2KB)" is the Claude Code hook spill**, not a display quirk. The agent only has the first ~2KB; the rest is in a `tool-results/hook-*.txt` file it will not read. This hits `additionalContext` identically to raw stdout — the structured channel does NOT escape the cap. Keep the Claude hook write-only.
- **No Claude Code knob exists** to raise the hook cap (verified: `--help`, env, settings). Do not look for one; use the file channel.
- **Delivery does not guarantee adherence — but enforcement is a detector, never a gate.**
  `/context` can show the complete floor and cache while the model still invents a task-type
  exception, so you want _a_ backstop. The primary driver is Claude's project-scoped
  `Cogni Contract` output style, which moves the no-exceptions response rule into the
  system-prompt layer on every request (zero blast radius — it shapes generation, it cannot
  wedge a session). The `validate-status-contract.sh` Stop hook is the secondary, **warn-only**
  check: it surfaces a malformed final response, zero-evidence substantive proposal, or
  frozen-state mutation, and the agent self-corrects on the _next_ turn — it must never
  re-prompt or hard-block. The output style points to the complete loaded bundle; neither adapter owns a second
  response template. The warn-only detector is a conformance check, not instruction authority.
- **A hard Stop-block on every response is an anti-pattern (the lesson of the #2722 loop).**
  Two failure modes make it poor form: (1) **blast radius** — the hook runs on every agent on
  the node, so one over-strict check wedges the whole fleet (the pre-#2722 per-reply
  `/work/items/` check looped every Q&A into an infinite re-prompt); (2) **wrong target** — a
  Stop hook can only grade _format_, so a hollow well-shaped reply passes while a substantive
  one with a stray lead-in line is blocked, taxing real answers with re-emit round-trips.
  Enforce format where generation happens (the output style) and let the Stop hook _warn_, not
  gate. If a future check genuinely must hard-block, it needs a bounded escape so it can never
  loop.
- **Envelope compliance does not guarantee process adherence.** A correctly shaped response
  that proposes with `Followed = —`, reports zero sources, or has no retrieval actions in the
  turn trace is still a hard FAIL. Grade delivery → envelope → research trace → substantive
  synthesis → state continuity in that order. Never call a table-only shell a passing agent.
- **The loaded contract owns reporting semantics.** Follow its current Roles/Followed and
  evidence rules; this skill supplies no cumulative bibliography or second response policy.
- **@import of an ABSENT file renders as literal text**, not empty-expansion. On a true first boot the hook writes the cache _during_ SessionStart — too late for the same session's `@import`, which resolves at context assembly. **Warm the cache in the pre-session step** (`scripts/conductor-worktree-setup.sh`) so first boot is non-empty; otherwise the first session stays in bounded recovery until a restart/resume loads the complete contract.
- **A failed or incomplete hook fetch must not clobber a complete cache.** Both the project loader and the installed stable Codex hook validate the contract envelope and actual response-template structure before admission. A last-known complete bundle survives an expired key, hub outage, map-only response, or truncated contract. Missing/incomplete caches enter bounded recovery instead of normal work; recovery notices never pass completeness admission.
- **Codex parity:** `.codex/config.toml` must keep `additionalContextLimit = 0`. Without it Codex head/tail-spills the bundle and cuts the middle of the contract.
- **OpenCode version drift is real:** supported 1.x combines
  `opencode.json.instructions` with `AGENTS.md`. V2 parses the field but explicitly does
  **not** resolve its files, and its plugin implementation/config contract is incompatible
  with older 1.x releases. Do not claim V2 parity until a version-gated adapter passes the
  live-model eval; breaking the supported runtime to pre-wire an unproved adapter is worse.
  A parsed config is necessary evidence, never the live-model acceptance proof.
- **A manual cache read is delivery failure, not bootstrap.** The cache must already be
  privileged model context before the first agent token. Keep Claude's `@` imports in
  `CLAUDE.md`, not universal `AGENTS.md`, so OpenCode/Codex never mistake a harness-specific
  directive for a task they must execute.
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
2. **Respect the ownership split.** Normal response shape and semantics live together in the hub. Keep only bootstrap/safety/recovery in AGENTS and a bundle pointer in the output style. Do not merge consolidation until the destination contains the full template and fresh-session behavior is verified.
3. **Deliver through the proven harness path.** Claude = project output style (primary driver) +
   `CLAUDE.md` imports + a warn-only Stop detector (never a hard block); Codex = committed floor + uncapped hook; supported
   OpenCode 1.x = `instructions`. None requires an agent tool-read.
4. **AGENTS.md carries bootstrap, safety, and recovery only.** It points to the complete
   bundle without copying response tables or normal communication rules. Preserve a complete
   offline cache; absent/incomplete cognition permits only bounded delivery recovery.
5. **Prove on the live harness.** The only proof is a fresh spawn (`claude -p` headless, or a
   real session) whose trace shows the required research before its first substantive proposal,
   whose reporting follows the exact loaded contract, and which sustains frozen state on the
   next turn — AND a hub-down/expired-key boot with a complete cache that preserves the same
   contract, plus a cold/invalid-cache boot that stays in recovery. Byte
   round-trips, `/context`, and table shape are necessary but not sufficient.
6. **Prove distribution separately.** Name the bootstrap cohort/materializer version, show which
   nodes have adopted it, and show that a fresh developer clone receives the harness files without
   manual configuration. Operator success is the canary, not fleet completion.

## Canonical sources

| What                                                                       | Where                                                                                                                                                                                 |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cognition Substrate design (ownership, delivery, distribution, acceptance) | [cognition-substrate-bootstrap](https://cognidao.org/knowledge/cognition-substrate-bootstrap)                                                                                         |
| The delivery loader (fetch → cache → emit per runtime)                     | `scripts/agent/session-cognition.sh`                                                                                                                                                  |
| The bundle producer + `SESSION_BOOTSTRAP_INVARIANTS`                       | `nodes/operator/app/src/app/api/v1/cognition/{route,_bundle}.ts`                                                                                                                      |
| Harness wiring                                                             | `CLAUDE.md`, `.claude/settings.json`, `.claude/output-styles/Cogni Contract.md`, `scripts/agent/validate-status-contract.sh`, `.codex/config.toml`, `opencode.json`, root `AGENTS.md` |
| Harness docs                                                               | Claude Code memory/hooks (code.claude.com/docs/en/{memory,hooks}), Codex prompting/config (developers.openai.com), OpenCode V2 instructions (dev.opencode.ai/v2/docs/instructions)    |
| What becomes a skill vs hub entry vs spec                                  | [`knowledge-syntropy-expert`](../knowledge-syntropy-expert/SKILL.md)                                                                                                                  |
