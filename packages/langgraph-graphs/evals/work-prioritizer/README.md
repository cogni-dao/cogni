# mission-loop scores eval (external lane)

**What it measures.** Whether the free model, given the mission-loop agent's own scoring lines (`WORK_ITEM_SCORES_PROMPT_LINES` in `src/graphs/work-prioritizer/prompts.ts`, the same constant the system prompt embeds), scores five work items close to a hand-scored gold on the six do-it-now axes: goal, time, unblocks, ease, confidence, agent. The design is the hub entry [`work-item-scores-design`](https://cognidao.org/knowledge/work-item-scores-design) (story.5111 step 6a). It grades the prompt + model, not a black-box graph cycle: it never patches a work item.

**Informational.** The verdict never fails a build or a PR: PASS and FAIL both exit 0 (`gating: false`). Post the candidate scorecard in /validate-candidate as the 6a evidence.

**How it differs from the agent.** On the candidate route the model runs under the PR-review graph's system prompt (`PR_REVIEW_SYSTEM_PROMPT`, "You are a code review evaluator"), not the mission-loop system prompt, and with no tools. So the eval grades the two scoring lines plus the model on fetched goal and item text, not the agent's full context, and the store-valid row mostly measures whether the model invents allow-listed URLs.

**How to run.** It is not part of PR CI: it needs a live node, API keys, and real model calls. It is excluded from the package build and typecheck; only the grader's unit test (`tests/evals/work-prioritizer-scores.score.test.ts`) runs in vitest.

```bash
# On the flighted candidate: the candidate's chat route runs the free gpt-oss-120b (via the pr-review graph, 0 credits);
# goals and the 5 items are read from prod (cognidao.org), where the gold items live.
set -a; . ./.env.cogni; set +a
EVAL_API_KEY=<candidate key> pnpm eval:prioritizer-scores -- --runs 2 --out /tmp/prioritizer-scores.json
```

`EVAL_BASE_URL` (default `https://test.cognidao.org`) is the node whose chat route runs the model; `EVAL_API_KEY` (or `COGNI_CANDIDATE_API_KEY`) is its key. `EVAL_WORK_BASE_URL` (default `https://cognidao.org`) and `EVAL_WORK_API_KEY` (or `COGNI_NODE_API_KEY`) supply the goals (the cognition bundle's `## Goals`) and each item's title, status, priority, and the first 600 characters of summary and outcome; no item text is committed. `EVAL_MODEL`, `EVAL_GRAPH`, `EVAL_MAX_MESSAGE_CHARS`, and `EVAL_COMPLETIONS_URL` + `EVAL_COMPLETIONS_API_KEY` behave as in the guidance-routing eval.

**The bar** (`thresholds.json`). A run passes when ≥ 80% of the 30 cells (5 items × 6 axes) are within ±1 of gold AND the top-1 item by `rankScore` (from `@cogni/work-items`, so it ranks as every node does) matches gold (`story.5107`). A missing or out-of-range score counts as a miss. The verdict passes only when every run passes. It is **informational** (`gating: false`): PASS and FAIL both exit 0; 2 = bad arguments; 3 = a failed read or model call. Flip `gating` once a lane runs it.

**Output.** A markdown scorecard on stdout: the verdict, the cell share, top-1 matches, per-axis agreement, a gold-vs-model table with both rank scores, and an info row counting how many of the model's score objects the store would accept (`parseWorkItemScores`: SCORE_NEEDS_EVIDENCE, evidence allow-list, bounds). `--out` writes the JSON scorecard; don't commit it.

**Gold** (`gold.json`). Hand-scored by the goals architect on 2026-10-23 against the items as they stood that day. Items move (bug.5486 replaced story.5108 when it closed), so re-score or replace an item in a reasoned commit when its hand score no longer holds; never edit a cell to make a run pass (GOLDEN_UPDATE_DISCIPLINE, `docs/spec/ai-evals.md`). The gold is one author's judgement: get an independent human re-score before trusting a borderline result.
