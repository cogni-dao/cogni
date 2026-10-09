---
name: cognition-expert
description: "Session-bootstrap + cognition-delivery expert for Cogni nodes — how an agent actually receives (or fails to receive) its operating contract at session start, across Claude Code, Codex, and opencode. Points at the canon (docs/spec/node-baas-architecture.md §Cognition Substrate, scripts/agent/session-cognition.sh, nodes/operator/app/src/app/api/v1/cognition/{route,_bundle}.ts) and holds the durable mental model + hard-won gotchas that aren't obvious when you read it: the two-axis design (code-owned constitution vs hub-served knowledge index), why the SessionStart hook is NOT a universal injection surface, and why the full bundle must ride the instruction-FILE channel. Use when touching the cognition bundle, the session-start loader, AGENTS.md/CLAUDE.md bootstrap, the .cogni/.cognition-cache.md cache, @imports, .codex/config.toml, opencode.json instructions, SESSION_BOOTSTRAP_INVARIANTS, the served orientation entry, or when debugging why a fresh agent booted without its agent-contract / replied in prose instead of the status-contract / got a truncated bundle. Triggers: 'cognition bundle', 'session-cognition.sh', 'SessionStart hook', 'agent-contract not loading', 'status-contract', 'bundle truncated', 'Output too large / Preview first 2KB', 'additionalContext', 'additionalContextLimit', 'CLAUDE.md @import', 'CLAUDE.local.md', '.cognition-cache.md', 'AGENTS.md bootstrap', 'thin pointer', 'ONE_VOICE', 'orientation IS the constitution', 'SESSION_BOOTSTRAP_INVARIANTS', 'opencode AGENTS.md', 'Codex project_doc_max_bytes', 'why did a fresh agent not follow the contract', 'cross-harness bootstrap', 'hub-empty boot', 'cognition didn't load'."
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
acquisition first. Claude Code presents the cache through an instruction-file import;
Codex can also inject the cache through uncapped hook stdout. Current OpenCode V2 only
injects discovered `AGENTS.md` files: its `instructions` config is parsed but not
resolved into model context, and it does not expand `@` references. Therefore the
committed root `AGENTS.md` carries the terse universal floor and tells OpenCode to read
the live cache explicitly before acting.

| harness         | instruction files                                                                                               | SessionStart hook                                                                  | truncation override                                                    | proven delivery path                                     |
| --------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------- |
| **Claude Code** | `CLAUDE.md`/`AGENTS.md` + `@import`s + `CLAUDE.local.md`, injected **whole up to 4 MiB**                        | write cache only; hook output is capped and too late for the same session's import | **NONE** (docs: no setting/env raises it)                              | `AGENTS.md` floor + `@import .cogni/.cognition-cache.md` |
| **Codex**       | `AGENTS.md`/`AGENTS.override.md`, whole under **`project_doc_max_bytes` = 32 KiB** (silently truncates past it) | stdout as developer context, `additionalContextLimit` defaults to 2500 tokens      | **`additionalContextLimit = 0`** in `.codex/config.toml` → full inject | committed floor + hook-delivered live cache              |
| **OpenCode V2** | discovered `AGENTS.md` files only; current `instructions` entries are retained but not resolved                 | no SessionStart injection                                                          | n/a                                                                    | committed floor + explicit tool-read of the live cache   |

Keep the served bundle **< 32 KiB** so Codex never truncates it.

## Hard-won gotchas (the stuff that burns a whole session)

- **"Output too large (14.8KB) … Preview (first 2KB)" is the Claude Code hook spill**, not a display quirk. The agent only has the first ~2KB; the rest is in a `tool-results/hook-*.txt` file it will not read. This hits `additionalContext` identically to raw stdout — the structured channel does NOT escape the cap. Keep the Claude hook write-only.
- **No Claude Code knob exists** to raise the hook cap (verified: `--help`, env, settings). Do not look for one; use the file channel.
- **@import of an ABSENT file renders as literal text**, not empty-expansion. On a true first boot the hook writes the cache _during_ SessionStart — too late for the same session's `@import`, which resolves at context assembly. **Warm the cache in the pre-session step** (`scripts/conductor-worktree-setup.sh`) so first boot is non-empty; otherwise first boot is truncated and only the second boot is full.
- **A failed hook fetch must not clobber the cache** — the loader only writes when the fetch returns non-empty, so a warm cache survives an expired key / hub outage. This is load-bearing: it's why warm workspaces keep working through an outage.
- **Codex parity:** `.codex/config.toml` must keep `additionalContextLimit = 0`. Without it Codex head/tail-spills the bundle and cuts the middle of the contract.
- **OpenCode version drift is real:** current V2 docs say only `AGENTS.md` is
  discovered; `CLAUDE.md` fallback is gone and `instructions` entries do not reach
  the model yet. Do not claim injection because `opencode debug config` echoes paths;
  prove the model's received context on the installed version.
- **The hook cap and the serve cap are different layers.** There is also a producer-side budget (`project_doc_max_bytes` on Codex); keep the bundle small enough for the tightest consumer (32 KiB).

## When you touch this, in order

1. **Separate the axes.** Is the problem ownership (what's in the bundle) or delivery (how it arrives)? Fix the right one.
2. **Constitution stays code-owned.** Never move the agent-contract/invariants into a hub entry that only renders on a healthy hub. If you find it there, that's the drift — pull it back to `SESSION_BOOTSTRAP_INVARIANTS`.
3. **Deliver through the proven harness path.** Claude = file import; Codex = committed
   floor + uncapped hook; OpenCode V2 = committed floor + explicit cache read.
4. **AGENTS.md carries only the universal floor + bootstrap pointers**
   (`node-baas-architecture.md:311`) — the terse response/state skeleton, bundle pointer,
   and self-serve fallback. It must not copy expandable orientation, skills, domains, or
   the full rich contract.
5. **Prove on the live harness.** The only proof is a fresh spawn (`claude -p` headless, or a real session) that holds the whole contract and replies in the status-contract unprompted — AND a hub-down/expired-key boot that still renders the constitution. Byte round-trips of the loader output are necessary but not sufficient; the inject is what matters.

## Canonical sources

| What                                                                            | Where                                                                                                                                                                              |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cognition Substrate design (two axes, ownership split, thin-AGENTS.md boundary) | `docs/spec/node-baas-architecture.md` §Cognition Substrate (`:282-311`)                                                                                                            |
| The delivery loader (fetch → cache → emit per runtime)                          | `scripts/agent/session-cognition.sh`                                                                                                                                               |
| The bundle producer + `SESSION_BOOTSTRAP_INVARIANTS`                            | `nodes/operator/app/src/app/api/v1/cognition/{route,_bundle}.ts`                                                                                                                   |
| Harness wiring                                                                  | `.claude/settings.json`, `.codex/config.toml`, root `AGENTS.md`                                                                                                                    |
| Harness docs                                                                    | Claude Code memory/hooks (code.claude.com/docs/en/{memory,hooks}), Codex prompting/config (developers.openai.com), OpenCode V2 instructions (dev.opencode.ai/v2/docs/instructions) |
| What becomes a skill vs hub entry vs spec                                       | [`knowledge-syntropy-expert`](../knowledge-syntropy-expert/SKILL.md)                                                                                                               |
