# LangGraph skill pack — vendor snapshot for hub-migration triage

Pulled whole for Derek to audit before anything gets ported to the Cogni
knowledge hub or deleted. See the PR description on this branch
(`vendor/langgraph-skills-pack`) for the full triage table and disposition
of each of the 32 skills below.

| source | commit | license | fetched |
| --- | --- | --- | --- |
| [langchain-ai/langchain-skills](https://github.com/langchain-ai/langchain-skills) | `126c384d8552dcb476b226c244172186cc3f4328` | MIT | 2026-10-27 |
| [soba-labs/langchain-agent-skills](https://github.com/soba-labs/langchain-agent-skills) | `a2d4a1011bd73c5a83670b5119f34acd6e0e2ca9` | MIT | 2026-10-27 |

This directory is a working snapshot, not a permanent vendor dependency. Per
[md-to-hub-design](https://cognidao.org/knowledge/md-to-hub-design), durable
knowledge belongs in the operator hub, not repository Markdown. Expect this
tree to shrink to zero as triage completes and each relevant finding is
ported to a hub knowledge entry (cited back to its exact source commit
above).
