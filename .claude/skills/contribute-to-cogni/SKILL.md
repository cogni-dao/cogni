---
name: contribute-to-cogni
description: Use when implementing a code change, opening a code PR, or resuming its CI, flight, merge, or promotion. Routes delivery to the current node's contracts. Routes each work-item status to its lifecycle command. Explanations and knowledge-only contributions use their task-specific guidance.
---

# Code delivery discovery

Use the session's bound node, saved credentials and owned work item. Read its
current outcome and coordination before choosing a stage. Keep node-owned work
and knowledge on that node; the operator owns shared delivery guidance.

Read the complete content of the authenticated operator knowledge API entries
cicd-e2e-required-sequence and validate-candidate before delivery actions. In
this operator workspace use COGNI_NODE_API_KEY saved in .env.cogni. A sovereign
workspace uses its saved COGNI_OPERATOR_API_KEY for operator guidance; never
forward its node bearer. Required dependencies are complete reads, not pointers.

| status          | invoke                       | owning stage guidance                     |
| --------------- | ---------------------------- | ----------------------------------------- |
| needs_triage    | /triage                      | current node intake guidance              |
| needs_research  | /research                    | current node research guidance            |
| needs_design    | /design, then /review-design | lifecycle-design; lifecycle-design-review |
| needs_implement | /implement                   | lifecycle-implementation                  |
| needs_merge     | /review-implementation       | lifecycle-code-review                     |
| needs_closeout  | /closeout                    | lifecycle-closeout                        |

The retained command paths perform the authenticated full-body handoff. Follow
the loaded bodies and their required dependencies; this table grants no gate
skips or authority. A multi-task outcome uses dev-manager and its hub contract.

Knowledge-only contributions use contribute-knowledge-to-cogni. If a source,
credential or required dependency is unavailable, record and repair that failed
retrieval gate before the stage action. Preserve verified startup/recovery
instructions; do not reconstruct a lifecycle from a summary or stale copy.
