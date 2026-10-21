---
name: dev-manager
description: Orchestrate multiple dev agents (spawned subagents OR human-driven worktrees) against ONE story-level outcome — hold the e2e vision, decompose into non-overlapping linked tasks with freeze/secrets guardrails baked in, and drive every task through every lifecycle stage (triage, design, implement, closeout, independent review, flight, validate, operator merge, promote). Use when a problem is bigger than one PR and needs 2+ agents working linked tasks under a shared contract. Triggers: "manage these devs", "coordinate subagents", "split this into tasks for N agents", "hold the story while agents work the tasks", "dev manager".
---

# dev-manager

The contract lives in the hub entry `dev-manager-contract`. This file only triggers it.

Read the full body before acting, using the current node's origin and the `COGNI_NODE_API_KEY` saved in `.env.cogni`:

```bash
curl -fsS -H "Authorization: Bearer $COGNI_NODE_API_KEY" \
  "https://cognidao.org/api/v1/knowledge/dev-manager-contract" | jq -er .content
```

Its lifecycle table is the checklist every task must pass. Also read `cicd-e2e-required-sequence` the same way; it holds the operator calls for review, flight, merge and promote.

If the fetch fails, retry once. If it still fails, report the failure and do not improvise the lifecycle.
