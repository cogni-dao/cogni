# LangGraph skill pack — vendor snapshot for hub-migration triage

Pulled whole (32 skills, both repos, unedited) in the first commit on this
branch so the complete candidate set was reviewable before any triage
decision. This commit prunes to the 5 directories judged relevant, with the
disposition of all 32 recorded below. Per
[md-to-hub-design](https://cognidao.org/knowledge/md-to-hub-design), durable
knowledge belongs in the operator hub, not repository Markdown — the kept
5 are staged here only until the linked hub contribution merges and is
verified live, then they get deleted too.

| source | commit | license | fetched |
| --- | --- | --- | --- |
| [langchain-ai/langchain-skills](https://github.com/langchain-ai/langchain-skills) | `126c384d8552dcb476b226c244172186cc3f4328` | MIT | 2026-10-27 |
| [soba-labs/langchain-agent-skills](https://github.com/soba-labs/langchain-agent-skills) | `a2d4a1011bd73c5a83670b5119f34acd6e0e2ca9` | MIT | 2026-10-27 |

Hub inbox with the actual port (pending human merge):
https://cognidao.org/knowledge/inbox/contrib-flock-leader-conductor-5c81310a

## Disposition of all 32

| skill | repo | verdict | why |
| --- | --- | --- | --- |
| langgraph-error-handling | soba-labs | **KEPT — ported** | Maps to a proven gap: `cogni.ts` + `work-prioritizer/graph.ts` hand-roll the same `recursionLimit`/`GraphRecursionError` catch. Ported as hub skill `langgraph-error-handling`. |
| langgraph-testing-evaluation | soba-labs | **KEPT — ported** | Maps to a proven gap: zero LangGraph-specific testing guidance in `test-expert`. Ported as hub skill `langgraph-graph-testing`. |
| langgraph-persistence | langchain-ai | **KEPT — ported** | Maps to a proven gap: no `checkpointer`/`thread_id`/`interrupt_*` anywhere in `packages/langgraph-graphs/**`, despite `agent-run-lifecycle` naming it as required. Ported as hub skill `langgraph-persistence`. |
| langchain-middleware | langchain-ai | **KEPT — cited, folded in** | `createMiddleware` is the exact extension point our `graph-compiled-not-wrapped` rule already names. Folded into the `langgraph-error-handling` hub entry as a citation rather than a standalone atom. |
| langgraph-human-in-the-loop | langchain-ai | **KEPT — cited, folded in** | Deeper, more authoritative treatment of `interrupt()`/`Command(resume)` mechanics than soba's version of the same topic. Refined into `langgraph-error-handling` rather than duplicated as a sibling atom (knowledge-syntropy-protocol rule 2: one atom per claim). |
| langgraph-agent-patterns | soba-labs | DELETED — not yet applicable | Multi-agent coordination (supervisor/router/orchestrator-worker). No current Cogni graph coordinates multiple agents; nothing to anchor a port to. Revisit if/when one is built. |
| langgraph-state-management | soba-labs | DELETED — redundant / not yet applicable | Checkpointer-backend content duplicates `langgraph-persistence`. Reducer/custom-state-schema content doesn't apply: both current Cogni graphs use the prebuilt `createReactAgent`, not a hand-rolled state schema. |
| langgraph-decision-models | langchain-ai | DELETED — wrong vendor, no proven need | Requires a LangSmith Gateway or TypeSafe account we don't run. No LLM-call-that-only-routes has been identified as a cost problem in our two graphs. |
| langgraph-project-setup | soba-labs | DELETED — redundant | LangGraph.json/project scaffolding superseded by `agent-development`'s Tier-1a file structure, which is repo-specific. |
| langgraph-cli | langchain-ai | DELETED — wrong deploy model | Documents the `langgraph dev/build/deploy` Platform CLI path. Cogni's only live path is InProc; LangGraph Server is spec+compose, not deployed. |
| langsmith-trace-analyzer | soba-labs | DELETED — wrong vendor | We trace through Langfuse (`langfuse-eval-expert`), not LangSmith. |
| langsmith-deployment | soba-labs | DELETED — wrong vendor/deploy model | Same LangSmith/Platform mismatch as `langgraph-cli`. |
| eval-engineering | langchain-ai | DELETED — mismatched "eval" | This is Harbor benchmark/Task-spec authoring for grading coding-agent harnesses, a different "eval" than our agent-quality loop (`agent-evaluation-loop`). Caught only by reading the full body, not the search-result summary. |
| langchain-rag | langchain-ai | DELETED — not applicable | No current Cogni graph does retrieval-augmented generation. |
| deep-agents-core | langchain-ai | DELETED — different paradigm | "Deep Agents" (todo-list planning, subagent delegation, filesystem backend) isn't wired into `packages/langgraph-graphs`; adopting it is an architecture decision, not a knowledge port. |
| deep-agents-memory | langchain-ai | DELETED — different paradigm | Same as above. |
| deep-agents-orchestration | langchain-ai | DELETED — different paradigm | Same as above. |
| managed-deep-agents | langchain-ai | DELETED — different paradigm | Same as above. |
| swarm | langchain-ai | DELETED — different paradigm | Different multi-agent library, not adopted. |
| deepagents-setup-configuration | soba-labs | DELETED — different paradigm | Deep Agents again. |
| deepagents-planning-todos | soba-labs | DELETED — different paradigm | Deep Agents again; the `write_todos` idea is conceptually close to our step-budget loop but adopting it is a separate decision, not a knowledge port. |
| skill-creator | soba-labs | DELETED — not a knowledge atom | Meta-tooling for maintaining soba-labs' own skill repo; we have our own. |
| langchain-fundamentals | langchain-ai | DELETED — redundant | Vendor-101 content; superseded for Cogni contributors by `agent-development`. |
| langgraph-fundamentals | langchain-ai | DELETED — redundant | Same. |
| ecosystem-primer | langchain-ai | DELETED — redundant | Same. |
| langchain-dependencies | langchain-ai | DELETED — redundant | Same. |
| langchain-python-quickstart | langchain-ai | DELETED — redundant | Generic onboarding; our repo-specific guide is more useful to a Cogni contributor. |
| langchain-typescript-quickstart | langchain-ai | DELETED — redundant | Same. |
| langgraph-python-quickstart | langchain-ai | DELETED — redundant | Same. |
| langgraph-typescript-quickstart | langchain-ai | DELETED — redundant | Same. |
| deepagents-python-quickstart | langchain-ai | DELETED — redundant + different paradigm | Same, plus Deep Agents mismatch. |
| deepagents-typescript-quickstart | langchain-ai | DELETED — redundant + different paradigm | Same. |

`SpillwaveSolutions/mastering-langgraph-agent-skill` (a third, single-file community skill) was evaluated in the prior research pass and never vendored here — monolithic, shallower than the above on both testing and error-handling, mostly subsumed.
