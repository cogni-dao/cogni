---
id: agent-design-guide
type: guide
title: "Agent Design Guide — KPIs, Data Streams, and Evolving Playbooks"
status: draft
trust: draft
summary: How to design autonomous agents for the Cogni platform. Agents are thin prompts with KPIs, data stream awareness, and links to evolving domain playbooks. This guide captures the paradigm; agent-development.md covers the mechanical steps.
read_when: Designing a new autonomous agent, defining agent KPIs, choosing trigger models, or writing agent playbooks.
owner: derekg1729
created: 2026-04-01
verified:
tags: [agents, design, kpis, data-streams, playbooks]
---

# Agent Design Guide

> Agents are thin prompts with clear KPIs, connected to data streams, linking to evolving playbooks.

**This guide is about agent design** — what to think about before writing code. For the mechanical steps of creating a graph, see [agent-development.md](./agent-development.md). For the knowledge plane that will back these playbooks, see [knowledge-data-plane spec](../spec/knowledge-data-plane.md).

## The Agent Paradigm

Every autonomous agent has four components:

```
┌──────────────────────────────────────────────────────────┐
│  PROMPT (thin)                                            │
│  Identity + KPIs + capabilities + pointer to playbook    │
│  Lives in: packages/langgraph-graphs/src/graphs/<name>/  │
└──────────────────────────────────────────────────────────┘
         │ reads at runtime via core__repo_open
         ▼
┌──────────────────────────────────────────────────────────┐
│  PLAYBOOK (evolving)                                      │
│  Domain-specific operational guide                        │
│  Lives in: docs/guides/<domain>-playbook.md (now)        │
│  Future:   Doltgres knowledge store (versioned, diffable)│
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│  DATA STREAMS (observed)                                  │
│  What the agent watches between runs                      │
│  Sources: webhooks, polling, observation_events           │
│  Spec: docs/spec/data-streams.md                         │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│  TRIGGER (when to run)                                    │
│  Cron schedule, webhook event, or manual invocation       │
│  Infra: Temporal schedules, webhook dispatch              │
└──────────────────────────────────────────────────────────┘
```

## Designing an Agent: Checklist

### 1. Define KPIs First

Every agent needs measurable success criteria. Without KPIs, you can't tell if the agent is helping or hallucinating.

| Question                     | Example (PR Manager)                                           |
| ---------------------------- | -------------------------------------------------------------- |
| What does success look like? | Staging CI always green, PRs merged within 1 hour of readiness |
| What does failure look like? | Broken staging, stale PRs piling up                            |
| How do you measure it?       | CI health status, PR age at merge time, merge count            |

KPIs go in the agent's prompt, and the agent reports them in every run output. This creates the data stream for the EDO (Event-Decision-Outcome) feedback loop.

### 2. Identify Data Streams

What information does the agent need to observe?

| Stream Type    | Example                                   | Infrastructure                        |
| -------------- | ----------------------------------------- | ------------------------------------- |
| VCS events     | PR opened, CI completed, review submitted | GitHub webhooks → WebhookNormalizer   |
| System metrics | Error rate, latency, uptime               | Prometheus → MetricsQueryPort         |
| Work items     | Backlog state, stuck items                | WorkItemCapability                    |
| Previous runs  | Own past reports and decisions            | graph_runs.structured_output (future) |

For now, agents query data at run time via tools. Future: agents subscribe to Redis streams for real-time awareness (see [data-streams spec](../spec/data-streams.md)).

### 3. Choose a Trigger Model

| Model         | When to Use                    | Infrastructure                                      |
| ------------- | ------------------------------ | --------------------------------------------------- |
| **Cron**      | Periodic sweeps, health checks | Temporal schedule → ScheduledSweepWorkflow          |
| **Webhook**   | React to external events       | Webhook route → dispatch facade → Temporal workflow |
| **Manual**    | On-demand analysis, debugging  | Chat UI → graph execution                           |
| **Composite** | Fast reaction + catch-all      | Webhook for events + cron as backup                 |

Start with cron. It's simpler and the catch-all guarantees nothing is missed. Add webhook triggers when latency matters.

### 4. Write a Thin Prompt

The prompt should be **identity + KPIs + capabilities + playbook pointer**. Domain logic lives in the playbook, not the prompt.

**Pattern:**

```
You are the [Role Name] for [context].

## KPIs
1. [Metric]: [target]
2. [Metric]: [target]

## Capabilities
You CAN: [tool list]
You CANNOT: [boundaries]

## Playbook
Read your operational playbook at the start of each run:
  core__repo_open({ path: "docs/guides/<domain>-playbook.md" })

Follow the playbook. If you encounter a situation not covered, note it
in your report — the playbook will be updated by the team.

## Output
[Structured report format with KPI section]
```

### 5. Create the Playbook

The playbook is a markdown file that evolves over time. It contains:

- Decision trees for recurring situations
- Known issues and workarounds
- Historical patterns ("Dependabot eslint bumps always fail lockfile")
- Escalation rules ("if X, flag for human")

**Playbook lifecycle:**

1. Human writes initial playbook based on domain knowledge
2. Agent follows playbook, reports outcomes
3. When patterns emerge (EDO feedback), human or head agent updates playbook
4. Playbook changes are PRs — reviewed and versioned like code

**Future:** Playbooks migrate from `.md` files to the Doltgres knowledge store. Same content, but versioned with `dolt_commit`, diffable with `dolt_diff`, and queryable via `KnowledgeStorePort`. The agent reads via port instead of `core__repo_open`.

### 6. Wire the EDO Spine

Every agent run should produce data for the Event-Decision-Outcome loop:

```
Agent Run Output
├── KPI snapshot (current values vs targets)
├── Actions taken (decisions with rationale)
├── Expected outcomes ("merging PR #123 should keep CI green")
└── Blockers flagged (situations that need escalation)

Next Run
├── Compare KPI snapshot to previous
├── Check: did expected outcomes hold?
│   ├── Yes → playbook is working
│   └── No → flag for playbook update
└── Process new observations
```

**Current state:** Agent output is ephemeral (not persisted between runs). The structured report format seeds this data. Persistence (via `graph_runs.structured_output` or `GovernanceBriefPort`) is the next infrastructure step.

## Agent Inventory

| Agent            | KPIs                             | Trigger    | Playbook                                | Status   |
| ---------------- | -------------------------------- | ---------- | --------------------------------------- | -------- |
| Operating Review | Backlog health, stuck item count | 12h cron   | (inline prompt)                         | Active   |
| PR Manager       | Staging CI health, PR throughput | 15min cron | `docs/guides/pr-management-playbook.md` | v0       |
| Git Reviewer     | (observer only)                  | Manual     | (inline prompt)                         | Inactive |

## Related

- [Agent Development Guide](./agent-development.md) — mechanical steps for creating a graph
- [Knowledge Data Plane Spec](../spec/knowledge-data-plane.md) — Doltgres-backed expertise store (playbook future)
- [Data Streams Spec](../spec/data-streams.md) — three-tier observation architecture
- [AI Governance Data Spec](../spec/ai-governance-data.md) — EDO records, brief generation, signal provenance
- [Development Lifecycle](../spec/development-lifecycle.md) — work item status machine that agents operate on
