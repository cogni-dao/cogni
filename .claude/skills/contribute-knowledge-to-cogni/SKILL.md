---
name: contribute-knowledge-to-cogni
description: Use when contributing or refining durable knowledge in a Cogni node hub, including migrating existing documentation. Recall existing knowledge before research or writing; route predictions to EDO and useful human visuals to their authoring guide. Routine progress stays in work items.
---

# Contribute durable knowledge

This file selects the contracts; the hub holds their maintained content.

Write in ASD-STE100 style: short active sentences, one idea each, plain words
a 10-year-old knows, one meaning per term.

Read `GET /api/v1/knowledge/knowledge-contribution-flow` on the current node,
using its verified origin and saved `COGNI_NODE_API_KEY`. Read the full response
`content`, not only its index row. That guide owns recall of merged knowledge
and open inboxes, edit operations, citations, provenance, and human review.

| decision                                                    | read next                                                                            |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| What are we trying to compound?                             | `md-to-hub-design`                                                                   |
| Does this deserve durable knowledge?                        | `knowledge-syntropy-protocol`                                                        |
| Which registered domain owns it?                            | `cogni-domain-taxonomy`                                                              |
| How do repository docs, specs, or skills move into the hub? | `migrate-markdown-to-hub` and its required guides                                    |
| Is this a prediction that resolves later?                   | [edo-loop](../edo-loop/SKILL.md)                                                     |
| Does visual structure help human review?                    | `knowledge-human-visuals`, then [dolt-human-visuals](../dolt-human-visuals/SKILL.md) |

Reuse the focused inbox for the existing work item; unrelated work gets its own
inbox. A human reviews and merges knowledge. Verify the merged replacement,
retrieval route, and consumers before removing a repository source.

If the hub is unavailable or an entry is missing, retain existing sources and
record the failed gate. Do not register a fresh principal, silently change the
target node, or invent the missing contract.
