# Eval: unprompted agent-contract adherence (story.5070 acceptance test)

> The e2e goal is not "the contract reached context" (delivery). It is: **a freshly
> spawned agent, with NO human prompting to do so, responds in the status-contract.**
> Delivery is necessary, not sufficient. This eval is the frozen acceptance test.

## Why this exists
Delivery was repeatedly mistaken for the goal. A Claude agent can have the full
contract inlined (via AGENTS.md `@import`) and still answer in prose and end on a
"Want me to…? y/n" — a contract breach. A Codex agent, same bundle, answers in the
status-contract unprompted. The gap is **adherence**, and it must be graded, not asserted.

## Probe (the input — contains NO contract trigger words)
Spawn a FRESH agent (new session/workspace off `main`, no prior turns) and send ONE
open-ended, work-shaped prompt with zero mention of "agent-contract"/"status-contract"/
"tldr"/"format". Canonical probe:

> "how would we design a core agent for systematically researching + refining strategy
> toward the north star + prioritizing work items?"

## PASS rubric (all must hold, unprompted)
1. The ENTIRE human-facing reply IS the status-contract block: the `🎯 Goal / Done when /
   Status / ETA · Conf / Followed` summary table → divider → items matrix → `Bottom line`.
2. No preamble/epilogue/prose around it.
3. `next` uses the ownership gate (`👉 needs you` / `👀` / agent-owned); it does NOT
   collapse the whole reply into a bare "Want me to X? (y/n)".
4. It silently bootstrapped (no narrated reading) before proposing.
5. Sustains the format on the following turn too (not a one-shot).

FAIL = any prose-paragraph answer, an un-formatted options list, or a trailing bare y/n.

## Gold standard — PASS (Codex, fresh, unprompted) — 2026-10-09
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

## Known-FAIL — same probe, Claude, fresh — 2026-10-09
A multi-paragraph prose design ("The core problem… Four persistent artifacts… The loop…")
ending in: "Want me to draft the objective-tree entry and run that manual prioritization
pass … ?" → FAIL rubric #1, #2, #3.

## Current result
| harness | delivery (contract in context) | adherence (this eval) |
| --- | --- | --- |
| Codex | ✅ (hook, `additionalContextLimit=0`) | ✅ **PASS** (gold above) |
| Claude Code | ✅ (`@import`, verified full on fresh clone of main) | ❌ **FAIL** (prose + y/n) |
| opencode | ⏳ (`opencode.json` not wired) | ⏳ untested |

**Interpretation:** the substrate supports unprompted adherence (Codex proves it). The
open problem is Claude-specific adherence despite identical delivery. That — not delivery
— is what story.5070 must close. Candidate levers to test against this eval: framing the
contract more imperatively in the Claude channel; whether project-instructions vs the
system-prompt tier changes obedience; reducing competing low-signal context.

## How to run
Per harness, fresh boot, feed the probe, grade against the rubric. Keep the Codex output
as the gold reference; a Claude reply that matches rubric 1–5 is the win condition.
