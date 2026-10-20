---
name: knowledge-syntropy-expert
description: Use when organizing or curating a Cogni knowledge hub, deciding where durable knowledge belongs, or migrating Markdown docs and skills into the hub. Read the node knowledge axioms first, then the complete guide for the task.
---

# Knowledge stewardship

This file is the local discovery shell. The hub owns the axioms and procedures;
session cognition supplies the operating contract.

## Read the axioms first

On every invocation, read the full `content` of
`GET /api/v1/knowledge/md-to-hub-design` before proposing or changing knowledge.
Use the current node's verified origin and saved `COGNI_NODE_API_KEY`; do not
default a sovereign node's reads or writes to the operator.

Then fetch the complete guide for the task through
`GET /api/v1/knowledge/{id}`. Index rows and citation links are pointers, not
the instructions: read the selected bodies and their required dependencies.

| task                                                                           | read                          |
| ------------------------------------------------------------------------------ | ----------------------------- |
| Migrate repository Markdown, including specs and skills                        | `migrate-markdown-to-hub`     |
| Split a mixed document into skills, guides, contracts, rationale, and findings | `segment-markdown-knowledge`  |
| Thin a skill while preserving harness discovery and local resources            | `migrate-skill-to-hub`        |
| Repair links, anchors, loaders, and references before thinning or purging      | `retire-markdown-sources`     |
| Judge whether knowledge deserves an entry or refinement                        | `knowledge-syntropy-protocol` |
| Recall both planes, contribute, cite, and obtain human review                  | `knowledge-contribution-flow` |
| Choose a registered domain                                                     | `cogni-domain-taxonomy`       |
| Choose a useful human visual                                                   | `knowledge-human-visuals`     |

Use the migration guide's full sequence rather than stopping after classification
or an upload. Preserve the source until its reviewed replacement and consumers
pass the guide's cutover gates. Progress and current blockers belong in the
existing work item, not this shell.

If an entry is missing or unreachable, retain the source documents and use only
verified startup/recovery instructions. Record and resolve the failed retrieval
gate; do not invent missing guidance or claim the migration is complete.
