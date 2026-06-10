---
name: agent-infrastructure-scorecard
description: Living status scorecard for Cogni agent infrastructure — InProc↔LangGraph-Server alignment, built-vs-designed inventory, and the agent/langgraph doc DRY/drift/consolidation state. The stable mental model lives in agent-infrastructure-expert; this is the dated state that moves as graphs, executors, and evals ship. Use to check "what's actually built vs paper", "where do InProc and Server diverge", "which agent specs are stale/duplicated/safe-to-delete". Update THIS, not the expert skill.
---

# Agent Infrastructure Scorecard

> Living state under [`agent-infrastructure-expert`](../agent-infrastructure-expert/SKILL.md). The expert skill holds the stable mental model + operating rules; this scorecard holds dated status that moves as things ship. **When something changes, refine this file — the skill stays constant.**

**Last verified:** 2026-06-09

## InProc ↔ LangGraph Server Alignment

`langgraph-patterns.md` north-star: _"InProc must model as closely to LangGraph Server's I/O as possible."_ Where they stand:

| Dimension              | InProc (live, P0)                             | LangGraph Server (designed)                                                | Aligned?                           |
| ---------------------- | --------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------- |
| `GraphExecutorPort`    | ✅                                            | ✅                                                                         | 🟢 same port                       |
| `providerId` / graphId | `langgraph` / `langgraph:<name>`              | `langgraph` / `langgraph:<name>`                                           | 🟢 backend swaps via env, not id   |
| Output vocabulary      | ai-core `AiEvent`                             | ai-core `AiEvent`                                                          | 🟢 nothing vendor-specific crosses |
| Tool events            | full (`tool_call_*`)                          | P0: text/usage/done/error only                                             | 🟡 InProc richer                   |
| `stateKey` / threads   | **ignored** — no persistence                  | required; UUIDv5 tenant-scoped checkpoints                                 | 🔴 divergent                       |
| Resume / time-travel   | none (graph loss = full re-run)               | native checkpointer (Redis)                                                | 🔴 divergent                       |
| Billing path           | stream `usage_report` → `commitUsageFact()`   | async reconciliation via LiteLLM `end_user`/spend-logs                     | 🔴 different mechanism             |
| LLM routing            | `CogniCompletionAdapter` (ALS `completionFn`) | LiteLLM proxy, per-user virtual key                                        | 🟡 different                       |
| Deployment             | **only live path** — bundled in app image     | **not deployed** (no catalog target, no `LANGGRAPH_SERVER_URL` in any env) | 🔴 Server is paper                 |

**Takeaway:** InProc is production; Server is a spec + compose file with no running instance. They diverge most exactly where durability lives (threads/resume/billing) — the same seam as the synchronous-HTTP execution boundary. Never claim Server parity in a design without confirming it's actually deployed.

## Built vs Designed-Only

| Capability                                                 | Status                                                                                                    |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| InProc execution, billing, observability, credit preflight | 🟢 built                                                                                                  |
| Temporal orchestration + HTTP-delegated graph runs         | 🟢 built                                                                                                  |
| Node-sovereign graph packages (`@cogni/<node>-graphs`)     | 🟢 built                                                                                                  |
| LangGraph Server executor                                  | 🔴 spec + compose only, not deployed                                                                      |
| **Evals — datasets, LLM-judge, CI gate, canary gate**      | 🔴 **0/8; `evals/` dir does not exist; nothing gates promotion** (`proj.ai-evals-pipeline.md`, task.0286) |
| UI graph picker                                            | 🟡 `AVAILABLE_GRAPHS` hardcoded in `ChatComposerExtras.tsx`, not from `/api/v1/ai/agents`                 |

## DRY, Drift & Consolidation — agent/langgraph cluster

Evidence-backed. **CICD docs are out of scope and on HOLD until the pipeline is green** — no edits to `ci-cd.md` / `cd-pipeline-*` / `legacy-cicd-to-remove.md`.

| #   | Finding                                                                | Evidence                                                                                                                                                                                      | Fix                                                                          |
| --- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1   | Invariant duplication; `graph-execution.md` is SSOT yet others restate | `GraphExecutorPort`+`AiEvent` in all 4 of graph-execution / langgraph-patterns / langgraph-server / unified-graph-launch; `PACKAGES_NO_SRC_IMPORTS` ×3; `NO_LANGCHAIN_IN_SRC` ×2              | each restated invariant → one-line link to graph-execution                   |
| 2   | Speculative executor specs for unbuilt paths                           | `claude-sdk-adapter` (_not implemented_), `n8n-adapter` (_P2_), `multi-provider-llm` (_future_), `completions-api` (_proposed_) — all `draft`                                                 | collapse to one "Future Executors" stub under graph-execution                |
| 3   | `ai-evals.md` status lie + proj overlap                                | `status: active` + full eval charter for a 0/8-built pipeline; fuses "AI Architecture" + "Evals"                                                                                              | roadmap → proj; keep ai-evals arch-only or fold into graph-execution         |
| 4   | Path drift                                                             | `apps/operator` (real `nodes/<node>/app`) in unified-graph-launch, ai-pipeline-e2e, multi-provider-llm; `../LANGGRAPH_SERVER.md` (real `docs/spec/langgraph-server.md`) in langgraph-patterns | mechanical rewrite                                                           |
| 5   | `agent-development.md` operator-centric + missing ship/run             | leads shared Tier 1a; no runtime/CI link                                                                                                                                                      | lead node-local `packages/graphs`; add Build→Ship→Run paragraph              |
| 6   | Paradigm doc masquerading as guide                                     | `agent-design.md` = KPIs/paradigm, not a runbook                                                                                                                                              | → operator knowledge Dolt. Rule: guide = runbook; paradigm = knowledge entry |

**Target shape:** ~6 core specs (graph-execution = single invariant SSOT, + langgraph-patterns, langgraph-server, temporal-patterns, unified-graph-launch, ai-pipeline-e2e) and 3 guides (agent-development, tools-authoring, langgraph-server). Everything else links up or merges; nothing restates invariants.

## Canonical Doc Map (read order + stale flags)

1. [`graph-execution.md`](../../../docs/spec/graph-execution.md) — **authoritative spec.** Executor port, decorator stack, routing, catalog, ALS.
2. [`langgraph-patterns.md`](../../../docs/spec/langgraph-patterns.md) — package boundaries, InProc flow, anti-patterns. 🟡 fix `../LANGGRAPH_SERVER.md` link.
3. [`unified-graph-launch.md`](../../../docs/spec/unified-graph-launch.md) — run topology (Temporal → app → Redis → SSE). 🟡 `apps/operator` drift.
4. [`temporal-patterns.md`](../../../docs/spec/temporal-patterns.md) — durability boundary, webhook→workflow→graph→write.
5. [`langgraph-server.md`](../../../docs/spec/langgraph-server.md) — alternate executor (designed, not live).
6. [`ai-pipeline-e2e.md`](../../../docs/spec/ai-pipeline-e2e.md) — auth→execution→billing→security E2E. 🟡 `apps/operator` drift.

**Narrower/adjacent:** `agent-discovery`, `agent-registry`, `ai-setup`, `sandboxed-agents`, `node-baas-architecture`.
**Speculative (see DRY #2):** `claude-sdk-adapter`, `n8n-adapter`, `multi-provider-llm`, `completions-api`.
**Authoring tier:** [`agent-development.md`](../../../docs/guides/agent-development.md) 🟡, [`agent-design.md`](../../../docs/guides/agent-design.md) → knowledge, [`tools-authoring.md`](../../../docs/guides/tools-authoring.md).
