---
name: contribute-to-cogni
description: Use when implementing a code change, opening a code PR, or resuming its CI, flight, merge, or promotion. Routes delivery to the current node's contracts. Routes each work-item status to its lifecycle command. Explanations and knowledge-only contributions use their task-specific guidance.
---

# Code delivery discovery

Use the current node's owned work item and invoke the command for its status.

| status                      | invoke                                                   |
| --------------------------- | -------------------------------------------------------- |
| needs_triage                | /triage                                                  |
| needs_research              | /research                                                |
| needs_design                | /design                                                  |
| needs_design_review         | /review-design                                           |
| needs_implement             | /implement                                               |
| needs_implementation_review | /review-implementation                                   |
| needs_validation            | /validate-candidate                                      |
| needs_merge                 | wait for the operator merge, then move to needs_closeout |
| needs_closeout              | /closeout (record the closeout artifact, then done)      |
| blocked (legacy)            | /triage (moved back to needs_triage first)               |

An item moves forward one stage at a time, and only with the exit artifact or fact of the
stage it leaves; the store refuses anything else as `gate_unmet` and names what is missing.
It may move back to needs_triage or an earlier stage with a reason. `blocked` is not a stage:
record the blocker in `blockedBy`, and move back if it invalidates the stage.

Each command loads its owning procedure and any required dependencies.
A multi-task outcome uses dev-manager. Knowledge-only contributions use
contribute-knowledge-to-cogni.
