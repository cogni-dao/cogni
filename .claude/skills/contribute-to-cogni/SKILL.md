---
name: contribute-to-cogni
description: Use when implementing a code change, opening a code PR, or resuming its CI, flight, merge, or promotion. Routes delivery to the current node's contracts. Routes each work-item status to its lifecycle command. Explanations and knowledge-only contributions use their task-specific guidance.
---

# Code delivery discovery

Use the current node's owned work item and invoke the command for its status.

| status          | invoke                       |
| --------------- | ---------------------------- |
| needs_triage    | /triage                      |
| needs_research  | /research                    |
| needs_design    | /design, then /review-design |
| needs_implement | /implement                   |
| needs_merge     | /review-implementation       |
| needs_closeout  | /closeout                    |

Each command loads its owning procedure and any required dependencies.
A multi-task outcome uses dev-manager. Knowledge-only contributions use
contribute-knowledge-to-cogni.
