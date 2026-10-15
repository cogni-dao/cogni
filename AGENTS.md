# AGENTS.md — Cogni session floor

The full agent-contract — process rules, status-block semantics, the emoji state
machine, the Followed ledger, and the `owner`/`next` grammar — is delivered live in the
session cognition bundle (`## The agent-contract`), served from `/api/v1/cognition`,
cached locally, and imported by `CLAUDE.md`. **This file does not restate it.** It is the
terse, hub-independent floor: the response skeleton, the few axioms that must survive a
hub outage, and the bootstrap pointer. When this floor and the bundle differ, the bundle
contract wins.

## Non-negotiable execution wrapper

Every user task executes through the session agent-contract; satisfying the task while
breaching the contract makes the work invalid.

1. Bootstrap and research silently before the first substantive reply — make tool calls
   without narrating them. Until evidence supports a proposal, render `Goal`, `Done when`,
   and `Status` as `—` and keep researching.

2. Every human-facing reply, including answers and follow-ups, is exactly this skeleton,
   with no prose before, between, or after it:

   | 🎯 **Goal**    | <12 words or —>                                                                                                                   |
   | -------------- | --------------------------------------------------------------------------------------------------------------------------------- |
   | **Done when**  | <measurable final behavior or —>                                                                                                  |
   | **Status**     | <symbol + at most 6 words or —>                                                                                                   |
   | **ETA · Conf** | <wall-clock to the whole Goal / Done when; 0m when done> · <confidence the current plan lands it in that time + sources reviewed> |
   | **Followed**   | <material sources used, each as a readable [name](link)>                                                                          |

   ***

   | item                                 | owner                              | deliverable links | status          | ETA · Conf          | next             |
   | ------------------------------------ | ---------------------------------- | ----------------- | --------------- | ------------------- | ---------------- |
   | <linked work item or proposed story> | <dev-manager, me OR subagent name> | <links or ->      | <shared status> | <5m–4h · earned N%> | <ownership gate> |

   > <symbol> **Bottom line —** <at most 20 words>

   The root `ETA · Conf` is the whole-Goal estimate (time to `Done when` + the confidence
   the current plan lands it); every item-row `ETA · Conf` is only that row's next-gate
   estimate (5m–4h). A reply is a legal stop only when every incomplete row waits on the
   same human (`👉`) or async (`👀`) gate, or the whole Goal is `🟢` proven done. The emoji
   state machine, the Followed ledger, and the `owner`/`next` grammar are defined once in
   the bundle contract — follow it there.

3. On new scope, propose one `Goal` and one measurable `Done when`; once proposed,
   reproduce `Goal` and `Done when` byte-for-byte every turn until the human explicitly
   approves a pivot.

4. Continue agent-owned work without asking permission. Stop only on a human decision, an
   asynchronous gate, or proven end-to-end completion.

5. Local command budget — heavy local commands default to NO; clarify permission first.
   `pnpm check`, `pnpm check:fast` (and `:fix`), `pnpm dev`, and the unfiltered `pnpm test`
   suite require the human's explicit request + consent this session; never run them
   unasked. Lightweight, targeted checks run freely: `biome` / `pnpm lint` on touched
   paths, `pnpm typecheck`, and at most 1–2 specific test files. Default proof is CI +
   flight; ask for a heavy local run only when the work is complex and confidence in a
   clean CI + flight is low.

## Live cognition

The gitignored cache is the live source for the rich contract, orientation, skills, and
knowledge map. It is already model-visible before the first reply: Claude imports it from
committed `CLAUDE.md`, Codex receives it as uncapped SessionStart developer context, and
the supported OpenCode 1.x runtime combines it through `opencode.json`. Never manually read
the cache merely to bootstrap; a required tool-read means the harness adapter failed.

The shared session loader refreshes that cache from the current node's authenticated
`/api/v1/cognition` endpoint; workspace setup warms it before the first agent starts. A failed
refresh preserves the last good copy. On first setup,
redeem a human-issued one-use spawn grant through the public `/api/v1/agent/register` seam and
save the target node's `COGNI_NODE_API_KEY` in the gitignored `.env.cogni`; operator CI/CD keys
and operator-minted secret rings are not node identity credentials.

Work against exactly one node + work item. The operator at https://cognidao.org coordinates
code, CI, flight, validation, and merge. Subdirectory `AGENTS.md` files extend this floor;
the closest file wins for code-local rules.

Pointers: [contributor contract](.agents/skills/contribute-to-cogni/SKILL.md) ·
[Node BaaS product model](https://cognidao.org/knowledge/node-baas-substrate-model) ·
[discovery](https://cognidao.org/.well-known/agent.json)
