---
id: work-system-guide
type: guide
title: Work Management System Guide
status: active
trust: draft
summary: How to track charters, projects, and work items in this repository.
read_when: Creating work items, understanding the project/item lifecycle.
owner: derekg1729
created: 2026-02-05
verified: 2026-02-09
tags: [work, meta]
---

# Work Management System Guide

> Front door to `/work`. Planning and execution tracking lives here.

## Structure

| Directory     | Purpose                                                                 |
| ------------- | ----------------------------------------------------------------------- |
| `charters/`   | Strategic themes (`chr.<slug>.md`)                                      |
| `_templates/` | Charter template                                                        |
| ~~`items/`~~  | Removed 2026-05-04 — work items now in prod Doltgres at `cognidao.org`. |

## Work Item Types

### Charter (`chr.*`)

Strategic theme — an aspirational area of development. Groups related projects.

Contains: Goal, project index, constraints.

### Project (`proj.*`)

Phased roadmap for a multi-PR effort. **May exist before any code.**

Contains: Goal, crawl/walk/run roadmap, constraints, dependencies, work item list.

Projects reference work items by **ID only** (e.g., `task.0042`), never by file path.

### Work Item (`<type>.<num>`)

PR-sized unit of work. Types: `task`, `bug`, `spike`, `story`, `subtask`.

Contains: Requirements, allowed changes, plan, validation, review checklist, attribution.

## ID Conventions

| Kind    | Format         | Example                 | Immutable |
| ------- | -------------- | ----------------------- | --------- |
| Charter | `chr.<slug>`   | `chr.platform-health`   | Yes       |
| Project | `proj.<slug>`  | `proj.sandboxed-agents` | Yes       |
| Item    | `<type>.<num>` | `task.0042`             | Yes       |

**Item filenames:** `work/items/<type>.<num>.<editable_slug>.md`

- The `<type>.<num>` prefix is immutable and must match the `id` in frontmatter.
- The slug is editable and optional.

## Metadata Format

### Project

```yaml
---
id: proj.sandboxed-agents
type: project
primary_charter:
title: Sandboxed Agent Runtime
state: Active
priority: 1
estimate: 5
summary: Isolated execution environment for untrusted agent code
outcome: Agents run in gVisor containers with resource limits
assignees: derekg1729
created: 2026-02-05
updated: 2026-02-06
labels: [security, ai]
---
```

### Work Item

```yaml
---
id: task.0042
type: task
title: Add resource limits to sandbox containers
status: needs_implement
priority: 1
rank: 99
estimate: 2
summary: Configure CPU/memory limits for sandbox containers
outcome: All sandbox containers have enforced resource limits
spec_refs: sandboxed-agents
assignees: derekg1729
credit:
project: proj.sandboxed-agents
branch:
pr:
reviewer:
revision: 0
blocked_by:
created: 2026-02-09
updated: 2026-02-09
labels: [security]
external_refs:
---
```

## Field Reference

### Project

| Field             | Req | Description                   |
| ----------------- | --- | ----------------------------- |
| `id`              | Yes | `proj.{slug}` immutable       |
| `type`            | Yes | `project`                     |
| `primary_charter` | No  | `chr.{slug}` parent charter   |
| `title`           | Yes | Human readable                |
| `state`           | Yes | Active, Paused, Done, Dropped |
| `priority`        | Yes | 0-3                           |
| `estimate`        | Yes | 0-5                           |
| `summary`         | Yes | What is this about?           |
| `outcome`         | Yes | What does success look like?  |
| `assignees`       | Yes | CSV of handles                |
| `created`         | Yes | YYYY-MM-DD                    |
| `updated`         | Yes | YYYY-MM-DD                    |

### Work Item

| Field            | Req         | Description                                                                                                        |
| ---------------- | ----------- | ------------------------------------------------------------------------------------------------------------------ |
| `id`             | Yes         | `<type>.<num>` immutable                                                                                           |
| `type`           | Yes         | task, bug, spike, story, subtask                                                                                   |
| `title`          | Yes         | Human readable                                                                                                     |
| `status`         | Yes         | needs_triage, needs_research, needs_design, needs_implement, needs_closeout, needs_merge, done, blocked, cancelled |
| `priority`       | Yes\*       | 0-3 (\*optional when `needs_triage`)                                                                               |
| `rank`           | Yes\*       | Positive integer, 1 = highest within priority band (\*optional when `needs_triage`, default: 99)                   |
| `estimate`       | Yes\*       | 0-5 (\*optional when `needs_triage`)                                                                               |
| `summary`        | Yes         | What needs to be done?                                                                                             |
| `outcome`        | Yes         | What is the deliverable?                                                                                           |
| `spec_refs`      | No          | Spec IDs (not paths)                                                                                               |
| `assignees`      | Yes         | CSV of handles                                                                                                     |
| `credit`         | No          | Attribution for contributors                                                                                       |
| `project`        | No          | `proj.{slug}` parent (optional)                                                                                    |
| `branch`         | No          | Git branch name for this work                                                                                      |
| `pr`             | Before done | PR number/URL                                                                                                      |
| `reviewer`       | Before done | Review assignee                                                                                                    |
| `revision`       | Yes         | Integer, incremented on review rejection (default: 0)                                                              |
| `blocked_by`     | If blocked  | Required when status=blocked                                                                                       |
| `claimed_by_run` | No          | Governance runner lock (automation-only)                                                                           |
| `claimed_at`     | No          | Timestamp, set with claimed_by_run                                                                                 |
| `last_command`   | No          | Last `/command` that acted on this item                                                                            |
| `created`        | Yes         | YYYY-MM-DD                                                                                                         |
| `updated`        | Yes         | YYYY-MM-DD                                                                                                         |
| `labels`         | No          | CSV labels                                                                                                         |
| `external_refs`  | No          | External URLs                                                                                                      |

## Hard Rules

1. **ID_IMMUTABLE** — `id` never changes once assigned
2. **ITEMS_NOT_IN_CODE** — Work items must not be referenced in code or docs/spec
3. **SPECS_ARE_AS_BUILT** — Specs describe what IS, not what WILL BE; roadmaps live in `story` work items
4. **ITEMS_ARE_PR_SIZED** — If an item spans multiple PRs, break it up
5. **PR_LINKS_ITEM** — Every PR references exactly one Work Item ID (e.g., `WI: bug.0004`)
6. **SLUG_RENAME_OK** — Renaming the slug portion of a filename is allowed; renaming `<type>.<num>` is forbidden
7. **WORK_ITEMS_MOVE_TO_API** — New work items live in the Cogni API/Dolt source of truth, not a generated markdown index.

## Agent Safety

- All work-item reads and writes go through the Cogni API (`https://cognidao.org/api/v1/work/items`). The legacy `work/items/*.md` corpus was imported 2026-05-04 and removed; do not recreate it.
- Do not create or update a generated work item index.
- Do not write Markdown handoffs or project files. Handoff, rollout and plan state live in the work item (`summary` and `outcome`, reconciled in place with a PATCH `reason`). A `story` replaces a project file.
- The server allocates new IDs in the `5000+` range; legacy IDs (`<5000`) are preserved from the markdown corpus.

## Related

- [Documentation System](../docs/README.md)
- [Spec + Project Lifecycle](../docs/spec/development-lifecycle.md)
