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
| `projects/`   | Phased roadmaps (`proj.<slug>.md`)                                      |
| `handoffs/`   | Agent handoff packets (bounded, per work item)                          |
| `_templates/` | Templates for charters, projects, items, handoffs                       |
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

## Handoffs

Handoffs are bounded, derived summaries that give the next developer (human or agent) enough context to resume work on a specific item. They are **not** canonical state — the work item is the source of truth.

### Layout

```
work/handoffs/
  {workItemId}.handoff.md                          # rolling (overwritten each run)
  archive/{workItemId}/{YYYY-MM-DDTHH-MM-SS}.md   # snapshots (archived before overwrite)
```

### Contract

Handoff files use the template at `_templates/handoff.md`. Required frontmatter:

| Field          | Req | Description                           |
| -------------- | --- | ------------------------------------- |
| `id`           | Yes | Same as filename stem                 |
| `type`         | Yes | `handoff`                             |
| `work_item_id` | Yes | Parent work item ID (e.g. `bug.0004`) |
| `status`       | Yes | `active` or `archived`                |
| `created`      | Yes | YYYY-MM-DD                            |
| `updated`      | Yes | YYYY-MM-DD                            |
| `branch`       | No  | Git branch                            |
| `last_commit`  | No  | Short SHA of last relevant commit     |

Required sections (6 max):

1. **Context** — 3-5 bullets, no prose
2. **Current State** — facts only
3. **Decisions Made** — link to spec/ADR/PR, not prose
4. **Next Actions** — checklist, max 10 items
5. **Risks / Gotchas** — max 5 bullets
6. **Pointers** — key files, commands, dashboards

### Limits

| Constraint            | Limit                                      |
| --------------------- | ------------------------------------------ |
| Max lines             | 200                                        |
| Max sections          | 6                                          |
| Max links per section | 12                                         |
| Stack traces          | max 30 lines                               |
| Code blocks           | max 60 lines (link to file/commit instead) |
| Full transcripts/logs | never (link to run log instead)            |

### Rules

- **HANDOFF_IS_DERIVED** — Handoffs summarize; canonical state lives in the work item
- **HANDOFF_IS_BOUNDED** — Rolling handoff is regenerated, not appended; archive old versions
- **NO_LOGS_IN_HANDOFF** — Raw tool calls, transcripts, and verbose logs belong in `work/runs/` or observability, not handoffs

## Hard Rules

1. **ID_IMMUTABLE** — `id` never changes once assigned
2. **PROJECTS_REF_BY_ID** — Projects reference work items by ID only, never by file path
3. **ITEMS_NOT_IN_CODE** — Work items must not be referenced in code or docs/spec; only projects may reference item IDs
4. **SPECS_ARE_AS_BUILT** — Specs describe what IS, not what WILL BE; roadmaps live in projects
5. **ITEMS_ARE_PR_SIZED** — If an item spans multiple PRs, break it up
6. **PR_LINKS_ITEM** — Every PR references exactly one Work Item ID (e.g., `WI: bug.0004`)
7. **SLUG_RENAME_OK** — Renaming the slug portion of a filename is allowed; renaming `<type>.<num>` is forbidden
8. **WORK_ITEMS_MOVE_TO_API** — New work items live in the Cogni API/Dolt source of truth, not a generated markdown index.

## Agent Safety

- All work-item reads and writes go through the Cogni API (`https://cognidao.org/api/v1/work/items`). The legacy `work/items/*.md` corpus was imported 2026-05-04 and removed; do not recreate it.
- Do not create or update a generated work item index.
- The server allocates new IDs in the `5000+` range; legacy IDs (`<5000`) are preserved from the markdown corpus.

## Related

- [Documentation System](../docs/README.md)
- [Spec + Project Lifecycle](../docs/spec/development-lifecycle.md)
