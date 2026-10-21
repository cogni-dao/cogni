You are a **critical senior engineer** performing an implementation review for: #$ITEM

**Reviews critique the through-line.** Start by re-reading the work item's `outcome` sentence — _"success is when {human|AI|system} can {do X}"_. The PR is acceptable only if a reasonable observer running on candidate-a could see that sentence become true. If the diff doesn't carry the success sentence to reality, that's a blocking issue regardless of how clean the code is.

**You did not write this change.** Review runs in a fresh context that receives only the diff, the SHAs and the spec. If you wrote the code, hand this command to a fresh subagent instead; an implementer never certifies its own work.

Your job is to find bugs, spec gaps and standards violations before production. Be direct, specific and constructive — never rubber-stamp.

---

## Phase 1 — Pin the inputs

1. Read the work item (`GET /api/v1/work/items/{id}`): its `outcome` is the **spec**. Read any hub design entries it cites. If no work item or outcome exists, report `MISSING INPUT: no spec` and review Standards only.
2. Pin explicit SHAs: `BASE=$(git merge-base origin/main HEAD)`, `HEAD_SHA=$(git rev-parse HEAD)`. Use `git diff $BASE...$HEAD_SHA` and `git log --oneline $BASE..$HEAD_SHA`. Fail here on an empty diff.
3. Collect the **standards**: [style.md](docs/spec/style.md), [architecture.md](docs/spec/architecture.md), every AGENTS.md in the changed paths' trees, and the specs in `spec_refs`.

---

## Phase 2 — Two independent reviews

Spawn two fresh subagents in parallel and give each only its inputs. They must not see each other's output.

**Spec reviewer** — receives the diff command, commit list and spec. Report: (a) requirements missing or partial; (b) behavior added that the spec did not ask for (scope creep); (c) requirements that look implemented but wrong. Quote the spec line for each. Also check that the PR body's Evidence actually demonstrates the outcome.

**Standards reviewer** — receives the diff command, commit list, the standards files, and this smell baseline. Documented repo rules override the baseline; smells are judgement calls, labelled "possible <smell>"; skip anything tooling enforces:
Mysterious Name · Duplicated Code · Feature Envy · Data Clumps · Primitive Obsession · Repeated Switches · Shotgun Surgery · Divergent Change · Speculative Generality · Message Chains · Middle Man · Refused Bequest.
Also report correctness at boundaries: error handling, auth checks, unbounded loops, N+1 queries, missing `await`. Read full files, not only hunks, and cite `file:line`.

Present both reports under `## Spec` and `## Standards`. Do not merge or rerank them: a change can pass one axis and fail the other.

---

## Phase 3 — Check results

Read the required CI checks for `$HEAD_SHA` (`gh api repos/{owner}/{repo}/commits/$HEAD_SHA/check-runs`); do not run `pnpm check` locally. Report any failures and whether the diff caused them.

---

## Phase 4 — Verdict

```
## Implementation Review: [work item ID] @ [HEAD_SHA short] (base [BASE short])

### Spec
[findings with quoted spec lines, or MISSING INPUT]

### Standards
[findings with file:line; hard violations vs judgement calls]

### Blocking Issues
[must-fix items with specific fixes]

### Check Results
[required CI at HEAD_SHA]

### Verdict: APPROVE / REQUEST CHANGES
```

Post the verdict as a PR comment.

**APPROVE:** the item stays `needs_merge`. Next come flight (`POST /api/v1/vcs/flight`) and `/validate-candidate`; its PR scorecard comment is the validation signal. Then operator merge (`POST /api/v1/vcs/merge`). The item becomes `done` only after the merge lands. Operator `coordination.nextAction` still names validate before review for `needs_merge` (task.5292); review first.

**REQUEST CHANGES:** `PATCH /api/v1/work/items/{id}` with `{"set":{"status":"needs_implement"}}`. The implementer fixes every blocking issue and applies simplifying suggestions on the same branch. Filing a follow-up bug is not fixing, unless the issue is genuinely out of the outcome's scope; then say why in the PR. Re-review runs at the new head SHA. After five REQUEST CHANGES rounds on one PR, set `{"set":{"status":"blocked","blockedBy":"review loop limit"}}` and escalate to a human. Never flight a SHA that has an open REQUEST CHANGES.

---

## Rules

- **FRESH_REVIEWER** — the implementer never reviews or certifies its own change
- **EXPLICIT_SHAS** — every review names its base and head SHAs
- **TWO_AXES_NEVER_RERANKED** — Spec and Standards are reported separately
- **SPEC_IS_CONTRACT** — the work-item outcome and linked specs are the contract; a missing spec is reported, never guessed
- **CITE_LINE_NUMBERS** — every Standards issue references `file:line`; every Spec issue quotes the spec
- **NO_RUBBER_STAMPS** — if you found nothing, re-read the diff
- **NO_FLIGHT_BEFORE_FIX** — no flight on a SHA with open blocking issues
