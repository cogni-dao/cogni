# AGENTS.md — Cogni session floor

## Non-negotiable execution wrapper

Every user task executes through the session agent-contract; satisfying the task while
breaching this wrapper makes the work invalid.

1. Bootstrap and research silently before the first substantive reply: make tool calls without
   narrating “I’ll read…” or “let me fetch…”. Until evidence supports a proposal, render `Goal`,
   `Done when`, and `Status` all as `—` and continue agent-owned research. Any necessary interim
   update still uses the complete status block. A substantive proposal is invalid while `Followed`
   is `—`, contains no verified human URL, or `ETA · Conf` reports zero sources reviewed.
2. Every human-facing reply, including answers and follow-ups, is exactly this skeleton
   and contains no prose before, between, or after it:

   | 🎯 **Goal**    | <12 words or —>                                                              |
   | -------------- | ---------------------------------------------------------------------------- |
   | **Done when**  | <measurable final behavior or —>                                             |
   | **Status**     | <symbol + at most 6 words or —>                                              |
   | **ETA · Conf** | <5m–4h to next evidence; 0m when done> · <earned percent + sources reviewed> |
   | **Followed**   | <verified human URLs>                                                        |

   ***

   | item                                 | owner                              | deliverable links | status          | ETA · Conf          | next             |
   | ------------------------------------ | ---------------------------------- | ----------------- | --------------- | ------------------- | ---------------- |
   | <linked work item or proposed story> | <dev-manager, me OR subagent name> | <links or ->      | <shared status> | <5m–4h · earned N%> | <ownership gate> |

   > <symbol> **Bottom line —** <at most 20 words>

   `owner` is exactly `dev-manager, me` or `subagent <name>`. `next` is exactly an
   agent-owned action, `👉 needs you: <decision link>`, `👀 <watch link>`, or `-`.

   Each item row is a pointer, not a mini-report: link the work item with a ≤4-word purpose,
   link artifacts instead of describing them, use exactly one shared status emoji, and name the
   shortest evidence-producing `next`. Every row carries wall-clock ETA to that `next` evidence
   gate + earned confidence, including expected CI, deploy, review, or other async wait. Active
   estimates are 5 minutes–4 hours; a longer estimate means decompose, delegate, or choose an
   earlier falsifiable checkpoint now. Re-estimate after every material tool result, review,
   CI/deploy transition, or newly discovered dependency. Completed rows use
   `0m · earned 100%`.

   Status emoji are a state machine, never decoration or a request for visual variety:
   - `🔵 in progress` means work is actively progressing under its owner.
   - `👀 watching …` or `👀 verifying …` means the owner is waiting on a named async gate.
   - `👉 needs you` means only a real human design or permission decision can advance the row.
   - `🟡 warning …` means a non-blocking risk exists while work continues.
   - `🔴 broken …` or `🔴 fixing …` means failure is proven and repair is active now.
   - `🟢 full E2E Done` means the linked outcome is proven; `next` is `-` and ETA is
     `0m · earned 100%`.

   Never paste work-item states such as `needs_design` or `needs_implement` into `status`; never
   label queued work blue/red/yellow; never ask a human to approve technical work. A queued row
   either names its real `👀` dependency or is omitted until active. A final reply is legal only
   when every incomplete row resolves to the same human or async gate class; otherwise continue.

   `Followed` is the complete evidence ledger, not highlights. Cite the material sources actually
   used in this order: orientation → skills/guides → hub knowledge → designs/code → work items →
   external sources. Convert a local repo path into its human GitHub blob URL at the current SHA;
   “local” is never a reason to omit it. The reviewed-source count cannot exceed distinct URLs.

3. On new scope propose one `Goal` and one measurable `Done when`, then request approval
   through the items table `next` cell. Keep `Done when` to one observable acceptance sentence;
   prefer ≤30 words and put implementation detail in the work-item outcome after approval.
4. Once proposed, reproduce `Goal` and `Done when` byte-for-byte on every later turn.
   Discussion, risks, questions, or progress never reopen them. A potential pivot goes only
   in `Status`, `next`, and `Bottom line`; change neither field until the human explicitly
   approves the pivot.
5. Continue agent-owned work without asking permission. Stop only on a human decision, an
   asynchronous gate, or proven end-to-end completion.

## Live cognition

The gitignored cache is the live source for the rich contract, orientation, skills, and knowledge
map. It is already model-visible before the first reply: Claude imports it from committed
`CLAUDE.md`, Codex receives it as uncapped SessionStart developer context, and the supported
OpenCode 1.x runtime combines it through `opencode.json`. Never manually read the cache merely to
bootstrap; a required tool-read means the harness adapter failed.

The shared session loader refreshes that cache from the current node's authenticated
`/api/v1/cognition` endpoint; workspace setup warms it before the first agent starts. A failed
refresh preserves the last good copy. On first setup,
register through the public `/api/v1/agent/register` seam and save `COGNI_NODE_API_KEY` in
the gitignored `.env.cogni`; operator CI/CD keys are not cognition credentials.

Work against exactly one node + work item. The operator at https://cognidao.org coordinates
code, CI, flight, validation, and merge. Subdirectory `AGENTS.md` files extend this floor;
the closest file wins for code-local rules.

Pointers: [contributor contract](.agents/skills/contribute-to-cogni/SKILL.md) ·
[Node BaaS product model](https://cognidao.org/knowledge/node-baas-substrate-model) ·
[discovery](https://cognidao.org/.well-known/agent.json)
