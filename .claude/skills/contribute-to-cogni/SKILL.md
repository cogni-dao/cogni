---
name: contribute-to-cogni
description: Use when implementing a code change, opening a code PR, or resuming its CI, flight, merge, or promotion. Routes delivery to the current node's contracts. Routes each work-item status to its lifecycle command. Explanations and knowledge-only contributions use their task-specific guidance.
---

# Code delivery

Continue from the session cognition already loaded. This file routes code
delivery; it does not supply a second startup contract.

## Recall the current contracts

Read these entries through `GET /api/v1/knowledge/{id}` on the current node,
using its saved `COGNI_NODE_API_KEY`:

| entry                        | use it for                                                   |
| ---------------------------- | ------------------------------------------------------------ |
| `cicd-e2e-required-sequence` | access, CI, operator flight, merge, and promotion            |
| `validate-candidate`         | changed-surface exercise, exact SHA, and observability proof |

Use the session's node identity, candidate URL, approved outcome, and existing
work item. Reuse credentials; register only when no usable node credential exists.
Follow the session's bounded watch gates and local command budget. Verify stale
or draft guidance against the loaded contract and live API discovery before acting.

## Your stage is your work item's status

Run the one command for the status, then advance the status through the
work-item API. Do not skip a stage.

| status            | run                                                                              |
| ----------------- | -------------------------------------------------------------------------------- |
| `needs_triage`    | `/triage`                                                                        |
| `needs_research`  | `/research`                                                                      |
| `needs_design`    | `/design`, then `/review-design` by a fresh agent                                |
| `needs_implement` | `/implement`                                                                     |
| `needs_closeout`  | `/closeout`                                                                      |
| `needs_merge`     | `/review-implementation` by a fresh agent, then flight, validate, operator merge |

A story spanning several tasks belongs to `dev-manager`, which drives each task
through these stages.

Keep delivery authority with the operator. A GitHub developer grant may permit
branch pushes; it does not replace the operator merge gate. Follow the loaded
access instructions, including accepting a pending repository invitation.

## Knowledge is a separate reviewed lane

For knowledge-only work, use `contribute-knowledge-to-cogni` directly. During
code work, use it only when a durable finding earns a contribution; it owns
recall, refinement, citations, and the focused review inbox.

If the hub is unavailable, preserve the loaded cognition and committed floor.
Continue local work and targeted checks; verify remote delivery gates when their
authoritative sources are available. Never invent an endpoint or a passing verdict.
