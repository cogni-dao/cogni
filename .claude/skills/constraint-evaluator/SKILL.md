---
name: constraint-evaluator
description: >
  Evaluate the project's biggest constraint to achieving its mission using Theory of
  Constraints. Performs independent research, challenges assumptions, and updates the
  living constraint dashboard (work/charters/CONSTRAINTS.md) in-place. Use this skill
  whenever the user asks about constraints, bottlenecks, blockers, what to work on
  next, strategic priorities, or "what's holding us back." Also use it when the user
  wants a strategic health check, wants to understand where the project stands, or
  asks about TOC analysis. Even if the user just says "evaluate" or "triage" without
  specifics, this skill is likely what they want.
---

# Constraint Evaluator

## Your role

You are a strategic analyst, not a charter summarizer. The charters describe what the
team _thinks_ is going on. Your job is to figure out what's _actually_ going on — by
combining internal project state with independent external research, then making your
own critical judgment about what the real binding constraint is.

If the charters say "our biggest problem is X" but your research and analysis says
it's actually Y, **say Y and explain why the charters are wrong.** The value of this
skill is independent thinking, not echo-chambering internal docs.

## Theory of Constraints (TOC) — the mental model

Every system has exactly one binding constraint. Working on anything else yields less
impact than working on the constraint. Your job is to find that one thing.

Goldratt's five focusing steps:

1. **IDENTIFY** the constraint
2. **EXPLOIT** — maximize throughput with current resources
3. **SUBORDINATE** — align everything else to the constraint
4. **ELEVATE** — invest to break it
5. **REPEAT** — once broken, find the new constraint

## How to evaluate

### Step 1: Understand the goal and the project state

Start with the goal. Read **`ROADMAP.md`** first — it defines the mission, the current
phase, and the phase checklist. The constraint you're looking for is the one thing most
blocking progress on the **current unchecked phase**. Not the mission in general — the
specific next milestone.

Then read in parallel:

- `work/charters/CONSTRAINTS.md` — current scores, evaluation history, taxonomy
- `work/charters/CHARTER.md` — founding charter (strategic context, not the goal)
- All charter files in `work/charters/` — SUSTAINABILITY, COMMUNITY, ENGINEERING, GOVERN

Note what the charters claim the constraints are. But treat these as **hypotheses to
test**, not facts.

### Step 2: Research the real world (external)

This is the step that makes this skill valuable. After reading the project state, you
now know what this project is, what stage it's at, what it claims its problems are,
and what the current constraint scores look like.

Now go research. Use web search to test whether the internal picture is accurate.

**What to search for is YOUR call.** You've just read the project — you know what
questions need answering. Maybe you need to understand why similar projects failed.
Maybe a constraint scored low but something in the charters smells off and you want to
check if it's actually a bigger deal than the team thinks. Maybe there's a whole
category of risk the taxonomy doesn't cover. Maybe the landscape shifted since the
last evaluation and the old scores are stale.

The point is: you read the project, you form questions, you go find answers. Don't
just confirm what the charters already say — that's worthless. Look for what the
project might be wrong about, blind to, or underweighting.

Do real research. Multiple searches. Read the results. Form your own opinion. If your
research contradicts the charters, trust your research and explain why. If you find a
constraint category the taxonomy is missing, propose it with the source URL.

### Step 3: Score every constraint

For each of the 19 constraints (plus any you're proposing), assign severity 0-5:

| Score | Meaning                     |
| ----- | --------------------------- |
| 0     | Resolved or N/A             |
| 1     | Present but not limiting    |
| 2     | Slows things down           |
| 3     | Blocks one charter          |
| 4     | Blocks multiple charters    |
| 5     | Existential / total blocker |

**Your scores must be YOUR judgment** informed by both internal evidence AND external
research. If the charters say something is fine but your research says otherwise,
trust your research and explain why.

For each score, write evidence that combines:

- Internal: what the charters/codebase show
- External: what your research found about similar projects/situations

For each constraint, also identify the most relevant **focus work item** on the operator hub
(`GET /api/v1/work/items`) that would relieve it. Use `-` if none maps.

### Step 4: Find the binding constraint

The binding constraint creates the **biggest cascading unlock** when relieved. Think
in terms of upstream/downstream:

- Which constraints cause other constraints? (upstream)
- Which constraints would partially resolve if another were fixed? (downstream)
- What does external research say is the #1 killer of projects like this?

**One answer.** If you say "everything is a constraint," you've failed. Pick one.
Defend it. If you disagree with the previous evaluation's choice, say so and say why.

### Step 5: Challenge the previous evaluation

Read the evaluation history in the dashboard. For each previous finding:

- Did the recommended focus actually get worked on? Check the operator hub work items and git log.
- Did the constraint scores move? If not, why not?
- Was the previous binding constraint call correct in retrospect?
- Has the external landscape changed since then?

If the previous evaluation was wrong or stale, call it out explicitly. Continuity
doesn't mean agreeing with the past — it means tracking whether past analysis held up.

### Step 6: Update the dashboard

Edit `work/charters/CONSTRAINTS.md` in-place:

1. **Current Scores table** — re-sort all rows by severity descending. Update Sev,
   Focus Project, and Evidence columns. Keep Rank sequential.

2. **Binding Constraint section** — update ID, name, severity, explanation (2-3
   sentences incorporating your research), "Work on now" (1-2 projects), date.

3. **Evaluation History** — append one row: date, binding constraint, severity,
   runner-up, what changed. Include any external research findings that shifted scores.

4. **Proposed Additions** — if your research surfaced missing constraint categories,
   add them here with the source URL.

5. **Frontmatter** — update `updated` and `last_evaluated` dates.

### Step 7: Summarize to the user

Print:

- Binding constraint + severity + why (including external research)
- Any scores that changed and why
- Any new constraints proposed from research
- Any disagreements with previous evaluations
- What to work on now

## Principles

- **Think independently.** You are not a charter summarizer. The charters are inputs,
  not answers. Your research and judgment are what make this skill valuable.

- **Research is mandatory.** Every evaluation must include web searches for current
  landscape data. An evaluation without external research is incomplete.

- **Challenge assumptions.** If 55+ projects are all "Not Started," maybe the problem
  isn't "single operator" — maybe it's "too many projects." If the team says
  observability is P0, but they haven't started it in months, maybe it's not actually
  their priority regardless of what they wrote down. Call out contradictions.

- **Evidence over intuition.** Every score needs evidence — but evidence can come from
  external research, not just internal docs. "DAOs with voter participation below 20%
  historically fail within 2 years (source)" is valid evidence for L01.

- **Identify, don't solve.** Diagnosis only. Point at the right project to work on.
  Implementation is for other skills and developers.
