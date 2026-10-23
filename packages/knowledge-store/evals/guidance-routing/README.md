# guidance-routing eval (external lane)

**What it measures.** Whether an agent can find the hub guidance that governs a real task from the rows a routing mechanism shows it. The gold set (`gold.json`) holds 18 work items and the 55 governing entries that govern them, each with its entry type. The design is the hub entry [`guidance-routing-design`](https://cognidao.org/knowledge/guidance-routing-design).

**How to run.** It is not part of PR CI: it needs a live node, a node API key, and real model calls. It is excluded from the package build and typecheck; only the scorer's unit test (`tests/evals/guidance-routing.score.test.ts`) runs in vitest.

```bash
# Reachable ceiling only — no model calls. Works against any build.
EVAL_API_KEY=<node key> pnpm eval:guidance-routing -- --mechanism A --ceiling-only

# Selector run: mean of 2 blind selector runs, then the decision-table verdict.
EVAL_API_KEY=<node key> \
EVAL_COMPLETIONS_URL=https://openrouter.ai/api/v1/chat/completions \
EVAL_COMPLETIONS_API_KEY=<key> EVAL_MODEL=openai/gpt-oss-120b \
pnpm eval:guidance-routing -- --mechanism A --out /tmp/guidance-routing.json
```

`EVAL_BASE_URL` defaults to `https://cognidao.org` (use `https://test.cognidao.org` for a flighted candidate). Work-item text comes from `EVAL_WORK_BASE_URL` (default `https://cognidao.org`), so no internal text is committed. The node's own chat route caps each message at 4,000 characters, so the selector needs an external OpenAI-compatible endpoint.

**Mechanisms.**

- `A` (default): the whole governing index in context. Rows come from the cognition bundle's `governingIndex`; a pre-governing build serves `skillsIndex`, which is the "before" measurement.
- `--rows <file>`: the same, from a JSON file of rows, such as captured `core__knowledge_index` output (`{"entries":[…]}`). This is the internal path.
- `T` and `T+method`: the selector picks 1–3 shelves from the bundle's domain pointers, the runner pulls each through `/api/v1/knowledge/index?domain=`, keeps governing types, then the selector picks entries. `T+method` always adds the `method` shelf. That route hides EDO types, so `decision` rows are unreachable on this path.

**Scores.** Micro recall@3, @5 and @10 over all labels, and rules@5 over the 19 rule labels, each the mean of `minRuns` runs. The ceiling line is the share of labels present in the rows shown; no selector can beat it.

**The gate.** `thresholds.json` encodes the design's decision table. Row 0 (whole bundle over 64 KiB) takes precedence and skips A. A ships at recall@5 ≥ 0.80 and rules@5 ≥ 0.75 (row 1). Exit code: 0 = the table ships the mechanism (row 1 or 5) or a ceiling-only report; 1 = any other row; 3 = INCONCLUSIVE. `--out` writes the JSON scorecard with the build SHA, row count, per-run scores and picks; don't commit it.

**Bias.** The gold labels and the design's measured selectors were all Claude. Prefer a non-Claude selector model, and get a non-Claude or human relabel of at least 5 tasks before trusting a borderline pass. Change `gold.json` or `thresholds.json` only with a reasoned commit.
