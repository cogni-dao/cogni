It's time to inspect AI graph **traces** for the problem at hand.

Use current context to infer the target graph/env, or get user input: #$PROBLEM

`/traces` is the AI-observability counterpart to [`/logs`](logs.md). **`/logs`
reads Loki (infra + app request logs); `/traces` reads Langfuse (graph runs, LLM
calls, tool calls, token cost, latency).** They are complementary, not redundant
— see "Logs vs Traces" below before picking one.

## 0. Logs vs Traces — pick the right plane

- A request that is **rejected before the graph runs** (auth 401, Zod 400 like
  `modelRef field is required`, rate-limit) lands in **Loki only** — it never
  creates a Langfuse trace. If a scheduled graph "silently does nothing",
  check `/logs` first; the 400 is there, not here.
- A graph that **runs but produces a bad/empty/aborted answer** (wrong tool,
  hallucinated output, `status:"error"` with `errorCode:"abort"`, tool returned
  no git) lands in **Langfuse**. That is this skill.
- Cost / token / latency per LLM call, and per-graph eval scoring, are
  Langfuse-only.

## 1. Access

Langfuse has **no MCP server** — use the curl helper
[`scripts/langfuse-query.sh`](../../scripts/langfuse-query.sh). It reads
`LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` from `.env.cogni` and hits the
Langfuse Public API.

```bash
scripts/langfuse-query.sh '/api/public/traces?limit=20&fromTimestamp=2026-06-01T00:00:00Z' | jq
```

- **Host:** `https://us.cloud.langfuse.com` — the Cogni project lives on the
  **US** region. The EU host (`https://cloud.langfuse.com`, the stale "Default"
  in `infra/secrets-catalog.yaml`) returns `Invalid credentials. Confirm that
  you've configured the correct host.` for the same keys. Override with
  `LANGFUSE_BASE_URL` only if the project moves.
- **UI:** https://us.cloud.langfuse.com → org `Cogni` → project `cogni-template`.
- One project holds **all envs** (production + candidate-a + local). Filter by
  `userId` / `sessionId` / `tags` to scope — there is no `env` field on traces.

## 2. The data model

- **Trace** = one graph run. Key fields: `name` (e.g. `graph-execution`),
  `timestamp`, `latency` (s), `sessionId`, `userId`, `input`, `output`,
  `observations[]`, `tags`. The graph's verdict is in `output.status`
  (`success` | `error`) and `output.assistantResponse`.
- **Observation** = a span inside a trace: an LLM `GENERATION` (has `model`,
  `usage`, `calculatedTotalCost`) or a tool/span `SPAN` (`name` = tool name).
  `level` ∈ `DEBUG|DEFAULT|WARNING|ERROR`; `statusMessage` carries the error.
- **Session** = a chat thread (`sessionId` like `ba:<acct>:s:<hash>` for a
  human chat, `run:<uuid>` for a one-shot scheduled run).

## 3. Collect — top-down, same discipline as /logs

1. **Is the graph even producing traces?** Low/zero volume means the run is
   failing upstream (route 400, schedule not firing) — pivot to `/logs`.
   ```bash
   scripts/langfuse-query.sh '/api/public/traces?limit=50&fromTimestamp=<ISO>' \
     | jq -r '.data[].timestamp[:10]' | sort | uniq -c
   ```
2. **Any hard failures?** ERROR-level observations + `status:"error"` traces:
   ```bash
   scripts/langfuse-query.sh '/api/public/observations?level=ERROR&limit=50&fromStartTime=<ISO>' \
     | jq -r '.data[]? | "\(.startTime[:19]) | \(.name) | \(.statusMessage)"'
   scripts/langfuse-query.sh '/api/public/traces?limit=100&fromTimestamp=<ISO>' \
     | jq -r '.data[]? | select(.output.status=="error") | "\(.timestamp[:19]) \(.output.errorCode)"'
   ```
3. **Read one trace end-to-end** — what tools fired, what the model saw:
   ```bash
   scripts/langfuse-query.sh '/api/public/traces/<traceId>' \
     | jq '{out:.output, obs:[.observations[]|{name,type,level,model,cost:.calculatedTotalCost,msg:.statusMessage}]}'
   ```
4. **Watch for capability gaps, not just crashes.** A `status:"success"` trace
   whose `assistantResponse` says "the repo tools are failing (no git…)" or
   that only ever calls `knowledge_search` is a **missing-tool** finding — the
   graph ran fine but had no adapter wired. Cross-check the tool list in the
   observations against what the graph should have.

Useful filters: `&name=<graph>`, `&userId=<id>`, `&sessionId=<id>`,
`&tags=<tag>`, `&fromTimestamp=`/`&toTimestamp=` (traces) or
`&fromStartTime=`/`&toStartTime=` (observations). Paginate with `&page=N`.

## 4. Synthesize

1. **Verdict mix:** success vs error vs aborted, with counts + time range.
2. **Failure modes:** distinct `errorCode` / `statusMessage`, ranked.
3. **Capability gaps:** graphs that succeed but lack a tool they needed.
4. **Cost/latency outliers:** slow or expensive generations (`usage`,
   `calculatedTotalCost`, `latency`).
5. **Cross-plane:** if traces are sparse or absent, state the upstream `/logs`
   query that explains why (the 400/401 that pre-empts the trace).
