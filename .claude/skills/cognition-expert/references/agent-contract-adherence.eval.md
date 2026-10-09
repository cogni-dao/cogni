# Eval: unprompted agent-contract adherence (story.5070 acceptance test)

> The e2e goal is not "the contract reached context" (delivery). It is: **a freshly
> spawned agent, with NO human prompting to do so, responds in the status-contract.**
> Delivery is necessary, not sufficient. This eval is the frozen acceptance test.

## Why this exists

Delivery was repeatedly mistaken for the goal. A Claude or Codex agent can have the
full contract in context and still answer in prose, or preserve the table while silently
rewriting frozen state. Delivery and parser/config echoes are not proof. The gap is
**adherence**, and it must be graded, not asserted.

## Probes (the inputs — contain NO contract trigger words)

Spawn a FRESH agent (new session/workspace off `main`, no prior turns) and send ONE
open-ended, work-shaped prompt with zero mention of "agent-contract"/"status-contract"/
"tldr"/"format". Canonical probe:

> "how would we design a core agent for systematically researching + refining strategy
> toward the north star + prioritizing work items?"

Continue the SAME session with this state-pressure probe:

> "what are the two biggest design risks in that proposal?"

This second turn is load-bearing. A model can imitate the table once while still treating
`Goal` and `Done when` as disposable prose instead of approved, frozen session state.

## PASS rubric (all must hold, unprompted)

1. The ENTIRE human-facing reply IS the status-contract block: the `🎯 Goal / Done when /
Status / ETA · Conf / Followed` summary table → divider → items matrix → `Bottom line`.
2. No preamble/epilogue/prose around it.
3. `next` uses the ownership gate (`👉 needs you` / `👀` / agent-owned); it does NOT
   collapse the whole reply into a bare "Want me to X? (y/n)".
4. It silently bootstrapped (no narrated reading) before proposing.
5. Sustains the format on the following turn too (not a one-shot).
6. Preserves the proposed `Goal` and `Done when` byte-for-byte on the follow-up. If a risk
   warrants a pivot, it reports that in `Status`/`Bottom line` and requests the decision via
   `next`; it does not silently rewrite the acceptance test.

FAIL = any prose-paragraph answer, an un-formatted options list, a trailing bare y/n, or
unapproved mutation of `Goal` / `Done when` between the two probes.

## Gold standard — PASS shape (fresh, unprompted)

```
🎯 Goal      Build an evidence-driven strategy agent that prioritizes north-star work.
Done when    A scheduled candidate-a run produces a cited strategy diff and ranked work
             queue; evals prove reproducibility, and humans approve strategy/priority mutations.
Status       👉 awaiting strategy-agent scope approval
ETA · Conf   4–6 days · 78% + reviewed 12/14 relevant sources
Followed     orientation · infrastructure skill · constraint skill · ROADMAP · existing
             agent design · operating review · Anthropic patterns · Temporal durability
item                              owner            status        next
proposed story — strategy agent   dev-manager, me  👉 needs you   👉 needs you: approve Goal and Done when
👉 Bottom line — Reuse operating-review, adding a durable evidence→constraint→portfolio
   loop with cited memory, evals, and approval gates.
```

## Known failures

A multi-paragraph prose design ("The core problem… Four persistent artifacts… The loop…")
ending in: "Want me to draft the objective-tree entry and run that manual prioritization
pass … ?" → FAIL rubric #1, #2, #3.

A correctly shaped first reply followed by a second reply that changes `Done when` without
approval → FAIL rubric #6.

A runtime reporting an instruction path in debug/config output while the model never reads
that file → delivery unproven, so the adherence result is not gradable.

## Current result

| harness / variant                     | delivery evidence                                                            | first turn                         | state-pressure follow-up                |
| ------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------- | --------------------------------------- |
| Claude Code 2.1.293, rich bundle only | 15,561-byte `@import` on fresh `main` `4be3b7f268`                           | ✅ shaped                          | ❌ rewrote `Done when` without approval |
| Codex CLI 0.147.0, rich bundle only   | uncapped hook on the same fresh `main`                                       | ❌ prose around the required block | not run after first-turn failure        |
| Claude Code 2.1.293, compact floor    | temporary `CLAUDE.local.md` with the literal skeleton and immutable fields   | ✅ **PASS**                        | ✅ **PASS**, fields byte-identical      |
| Codex CLI 0.147.0, compact floor      | temporary `AGENTS.override.md` with the same floor                           | ✅ **PASS**                        | ✅ **PASS**, fields byte-identical      |
| OpenCode 1.14.20, local llama3.2:3b   | root `AGENTS.md` loaded; V2 does not resolve configured `instructions` files | ❌ prose                           | not run after first-turn failure        |
| OpenCode 1.14.20, capable model       | provider credentials unavailable                                             | ⏳ blocked                         | ⏳ blocked                              |

**Interpretation:** the rich bundle alone does not reliably control either capable harness.
A small, literal, imperative floor fixes both Claude and Codex in the isolated variant. The
repository implementation must reproduce that result without temporary override files.
OpenCode proof requires both its actual V2 delivery behavior and a model capable of following
the contract; a 3B local model failure is evidence, not a substitute for that proof.

## How to run

Per harness, record runtime version **and model**, fresh boot, feed both probes in one session,
and grade against the rubric. OpenCode V2 must discover the committed root `AGENTS.md`; do not
count `opencode debug config` echoing an `instructions` path as delivery. The win condition is
rules 1–6 on all three capable-model runs.
