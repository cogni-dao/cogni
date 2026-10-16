---
name: knowledge-syntropy-expert
description: Use when curating a Cogni knowledge hub, deciding whether to refine an entry, or migrating durable repository knowledge into the hub. Routes knowledge quality, contribution mechanics, and migration decisions to their existing hub contracts.
---

# Knowledge stewardship

The hub holds the knowledge contracts. This file selects them; session cognition
already supplies the operating contract.

## Recall by decision

Read the relevant entries through `GET /api/v1/knowledge/{id}` on the current
node, using its saved credentials:

| decision                                                 | entry                         |
| -------------------------------------------------------- | ----------------------------- |
| Does this deserve durable knowledge?                     | `knowledge-syntropy-protocol` |
| How do I recall, refine, link work items, and submit it? | `knowledge-contribution-flow` |
| Which domain owns it?                                    | `cogni-domain-taxonomy`       |
| Should this repository document move?                    | `md-to-hub-design`            |
| Would a visual help a human review it?                   | `knowledge-human-visuals`     |

Recall merged entries and relevant open contribution diffs before writing.
Confidence matters: verify draft or stale claims against their evidence and
owning code. Policy sets confidence; authors do not raise it by assertion.

## Preserve these boundaries

- Refine before adding. Keep one claim or executable journey per entry.
- Preserve provenance, contributor lineage, and citation relationships.
- Keep plans, owners, blockers, and next actions in work items.
- Use a focused contribution inbox; a human reviews its merge.
- Before removing a local source, verify its replacement is merged, retrievable,
  and preserves the needed contracts and citations. Unmigrated specs still govern.
- Preserve the complete session contract and outage recovery instructions during
  migration. Moving knowledge must not remove startup instructions.

Migration progress is linked from `md-to-hub-design`; treat dated scoreboards as
snapshots and verify current work-item state. If the hub is unavailable, retain
the loaded context and existing sources until replacements can be verified.
