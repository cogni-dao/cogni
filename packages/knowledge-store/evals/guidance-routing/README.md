# guidance-routing eval (external lane)

**What it measures.** Whether an agent can find the hub guidance that governs a real task from the rows a routing mechanism shows it. The gold set (`gold.json`) holds 18 work items and the 55 governing entries that govern them, each with its entry type. The design is the hub entry [`guidance-routing-design`](https://cognidao.org/knowledge/guidance-routing-design).

**How to run.** It is not part of PR CI: it needs a live node, a node API key, and real model calls. It is excluded from the package build and typecheck; only the scorer's unit test (`tests/evals/guidance-routing.score.test.ts`) runs in vitest.

```bash
# Reachable ceiling only — no model calls. Works against any build.
EVAL_API_KEY=<node key> pnpm eval:guidance-routing -- --mechanism A --ceiling-only

# Selector run: mean of 2 blind selector runs, then the decision-table verdict.
# Default selector: the node's own chat route, free gpt-oss-120b via the pr-review graph (0 credits).
EVAL_API_KEY=<node key> pnpm eval:guidance-routing -- --mechanism A --out /tmp/guidance-routing.json
```

`EVAL_BASE_URL` defaults to `https://cognidao.org` (use `https://test.cognidao.org` for a flighted candidate). Work-item text comes from `EVAL_WORK_BASE_URL` (default `https://cognidao.org`), so no internal text is committed. The node's chat route caps each message, not each request, at 4,000 characters, so the runner splits the prompt across consecutive user messages of at most `EVAL_MAX_MESSAGE_CHARS` (default 3,900). `EVAL_MODEL` and `EVAL_GRAPH` override the model and graph. `EVAL_COMPLETIONS_URL` plus `EVAL_COMPLETIONS_API_KEY` point the selector at any other OpenAI-compatible endpoint, sent as one message unless `EVAL_MAX_MESSAGE_CHARS` is set.

**Mechanisms.**

- `A` (default): the whole governing index in context. Rows come from the cognition bundle's `governingIndex`; a pre-governing build serves `skillsIndex`, which is the "before" measurement.
- `T+method`: the selector picks 1–3 shelves from the bundle's domain pointers, the runner pulls each through `/api/v1/knowledge/index?domain=` plus the `method` shelf, keeps governing types, then the selector picks entries. That route hides EDO types, so `decision` rows are unreachable on this path. Plain `T` (no forced `method`) is reported but is not in the decision table, so it exits INCONCLUSIVE.
- `BM25` (row 7): BM25 over each row's id, type, domain and useWhen keeps the top 50, then the selector picks entries.

**Where rows come from (`--rows`).**

- `bundle` (default): the live cognition bundle — the external path.
- `tool`: the internal path, captured for real. The runner posts one message to `/api/v1/ai/chat` for a graph that binds the tool (`EVAL_TOOL_GRAPH`, default `brain`), asking it to call `core__knowledge_index`. It then reads that call's result from the AI SDK stream: the `tool-output-available` event that matches the `tool-input-start` naming the tool. If the graph never calls the tool, the run fails rather than falling back. On candidate: `EVAL_BASE_URL=https://test.cognidao.org EVAL_API_KEY=<candidate key> pnpm eval:guidance-routing -- --mechanism A --rows tool`.
- `<file>`: a JSON file of rows (`{"entries":[…]}` or an array), such as a saved tool result.

**Scores.** Micro recall@3, @5 and @10 over all labels, and rules@5 over the 19 rule labels, each the mean of at least `minRuns` runs (`--runs` below that exits 2 before any model call). The ceiling line is the share of labels present in the rows shown; no selector can beat it.

**The gate.** `thresholds.json` encodes the design's decision table. Row 0 (whole bundle over 64 KiB) takes precedence: the runner reads the bundle's `governingRender.wholeBytes` (the whole-index render size, whether or not it was served) and scores A only when `governingRender.mode` is `whole-index`. `--bundle-bytes` overrides the size, for example when scoring rows from a file against a pre-governing build. A ships at recall@5 ≥ 0.80 and rules@5 ≥ 0.75 (row 1); T plus `method` at recall@10 ≥ 0.85 (row 5); BM25 top-50 at recall@10 ≥ 0.85 (row 7). Below every bar, row 8 names the best-measured mechanism by recall@10 as a stopgap; A is excluded from that choice past the budget. Rows 7–8 compare mechanisms, so pass earlier `--out` cards with `--prior a.json,b.json`. Exit code: 0 = the table ships the mechanism (row 1, 5 or 7) or a ceiling-only report; 1 = any other row; 3 = INCONCLUSIVE (the row needs a mechanism not yet measured, plain T, or a failed read); 2 = bad arguments. `--out` writes the JSON scorecard with the build SHA, row count, per-run scores and picks; don't commit it.

**Bias.** The gold labels and the design's measured selectors were all Claude; the default selector here is the non-Claude `gpt-oss-120b`. Get a non-Claude or human relabel of at least 5 tasks before trusting a borderline pass. Change `gold.json` or `thresholds.json` only with a reasoned commit.
