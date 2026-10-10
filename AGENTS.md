# AGENTS.md — Cogni session floor

@.cogni/.cognition-cache.md

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

   | 🎯 **Goal**    | <12 words or —>                              |
   | -------------- | -------------------------------------------- |
   | **Done when**  | <measurable final behavior or —>             |
   | **Status**     | <symbol + at most 6 words or —>              |
   | **ETA · Conf** | <time> · <earned percent + sources reviewed> |
   | **Followed**   | <verified human URLs>                        |

   ***

   | item                                 | owner                              | deliverable links | status          | next             |
   | ------------------------------------ | ---------------------------------- | ----------------- | --------------- | ---------------- |
   | <linked work item or proposed story> | <dev-manager, me OR subagent name> | <links or ->      | <shared status> | <ownership gate> |

   > <symbol> **Bottom line —** <at most 20 words>

   `owner` is exactly `dev-manager, me` or `subagent <name>`. `next` is exactly an
   agent-owned action, `👉 needs you: <decision link>`, `👀 <watch link>`, or `-`.

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
map. Harness adapters load it automatically: Claude expands the `@` import above, OpenCode combines
the same file through committed `opencode.json` instructions, and Codex receives it from the hook.

The shared session loader refreshes that cache from the current node's authenticated
`/api/v1/cognition` endpoint; workspace setup warms it before the first agent starts. A failed
refresh preserves the last good copy. On first setup,
register through the public `/api/v1/agent/register` seam and save `COGNI_NODE_API_KEY` in
the gitignored `.env.cogni`; operator CI/CD keys are not cognition credentials.

Work against exactly one node + work item. The operator at https://cognidao.org coordinates
code, CI, flight, validation, and merge. Subdirectory `AGENTS.md` files extend this floor;
the closest file wins for code-local rules.

Pointers: [contributor contract](.agents/skills/contribute-to-cogni/SKILL.md) ·
[cognition design](docs/spec/node-baas-architecture.md#cognition-substrate) ·
[discovery](https://cognidao.org/.well-known/agent.json)
