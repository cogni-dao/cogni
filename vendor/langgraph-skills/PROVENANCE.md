# LangGraph skill pack — vendor snapshot for hub-migration triage

Pulled whole (32 skills, both repos, unedited) in commit 1 on this branch so
the complete candidate set was reviewable before any triage decision.
Commit 2 pruned too aggressively — "not used today" was wrongly treated as
a reason to delete. This commit restores 9 directories that are real,
self-hostable or vendor-independent LangGraph/LangChain capabilities we
haven't adopted *yet*, and keeps them staged alongside the active ones.

Per [md-to-hub-design](https://cognidao.org/knowledge/md-to-hub-design),
durable knowledge belongs in the operator hub, not repository Markdown.
These 14 directories are staged here only until the linked hub
contribution merges and is verified live, then they get deleted too — the
content survives in the hub, not here.

| source | commit | license | fetched |
| --- | --- | --- | --- |
| [langchain-ai/langchain-skills](https://github.com/langchain-ai/langchain-skills) | `126c384d8552dcb476b226c244172186cc3f4328` | MIT | 2026-10-27 |
| [soba-labs/langchain-agent-skills](https://github.com/soba-labs/langchain-agent-skills) | `a2d4a1011bd73c5a83670b5119f34acd6e0e2ca9` | MIT | 2026-10-27 |

Hub inbox with the actual port (pending human merge):
https://cognidao.org/knowledge/inbox/contrib-flock-leader-conductor-5c81310a
— the full disposition table with reasons now lives **inline in that hub
entry** (`langgraph-sourced-skills`), not here. This file stays as the
provenance record for the git history, not as the place to read the table.

## What's staged here now (14 of 32)

| skill | repo | disposition |
| --- | --- | --- |
| langgraph-error-handling | soba-labs | active — ported |
| langgraph-testing-evaluation | soba-labs | active — ported (as `langgraph-graph-testing`) |
| langgraph-persistence | langchain-ai | active — ported |
| langchain-middleware | langchain-ai | active — folded into `langgraph-error-handling` |
| langgraph-human-in-the-loop | langchain-ai | active — folded into `langgraph-error-handling` |
| langsmith-trace-analyzer | soba-labs | adapted — ported as `langfuse-trace-debugging` (Langfuse, not LangSmith) |
| langgraph-agent-patterns | soba-labs | parked — ported as `langgraph-multi-agent-patterns` |
| langgraph-state-management | soba-labs | parked — ported as `langgraph-custom-state` |
| langgraph-decision-models | langchain-ai | parked — ported as `langgraph-decision-model-routing` |
| deep-agents-core | langchain-ai | parked — ported as `deep-agents-framework` |
| deep-agents-memory | langchain-ai | parked — ported as `deep-agents-framework` |
| deep-agents-orchestration | langchain-ai | parked — ported as `deep-agents-planning` |
| deepagents-planning-todos | soba-labs | parked — ported as `deep-agents-planning` |
| langchain-rag | langchain-ai | parked — ported as `langgraph-rag-patterns` |

## The 18 still deleted outright

Redundant with our own `agent-development` guide (9: all quickstarts,
`langchain-fundamentals`, `langgraph-fundamentals`, `ecosystem-primer`,
`langchain-dependencies`, `langgraph-project-setup`); alternate platform we
deliberately don't run (3: `langgraph-cli`, `langsmith-deployment`,
`managed-deep-agents` — the last is a LangSmith-*hosted* product, distinct
from the self-hostable `deep-agents-*` skills above, which were restored);
mismatched concept (`eval-engineering` is Harbor benchmark/Task-spec
tooling, a different "eval" than Cogni's `agent-evaluation-loop`);
mislabeled (`swarm` — its actual content doesn't describe a LangGraph
multi-agent pattern despite the listing); not a knowledge atom
(`skill-creator`, soba-labs' own meta-tooling).

`SpillwaveSolutions/mastering-langgraph-agent-skill` (a third, single-file
community skill) was evaluated and never vendored — monolithic, shallower
than the above on both testing and error-handling, mostly subsumed.
