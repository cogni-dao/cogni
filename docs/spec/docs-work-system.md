---
id: docs-work-system-spec
type: spec
title: Docs + Work System
status: draft
spec_state: proposed
trust: draft
summary: Types, ownership boundaries, linkage rules, and invariants for /docs and /work
read_when: Creating any doc or work item, understanding what goes where
implements: proj.docs-system-infrastructure
owner: derekg1729
created: 2026-02-05
verified: 2026-02-18
tags: [docs, work, meta]
---

# Docs + Work System

> Taxonomy, ownership boundaries, and linkage rules for `/docs` and `/work`. Each has typed directories with enforced frontmatter.

### Key References

|             |                                                                                           |                              |
| ----------- | ----------------------------------------------------------------------------------------- | ---------------------------- |
| **Project** | [proj.docs-system-infrastructure](../../work/projects/proj.docs-system-infrastructure.md) | Tooling roadmap (CI, MkDocs) |
| **Guide**   | [Work Management Guide](../../work/README.md)                                             | Front door to `/work`        |
| **Spec**    | [Development Lifecycle](./development-lifecycle.md)                                       | Workflow flows and commands  |

## Design

### Types

| Type      | Directory             | ID Format      | Owns                                                  |
| --------- | --------------------- | -------------- | ----------------------------------------------------- |
| `spec`    | `docs/spec/`          | `kebab-case`   | Contracts, invariants, design, acceptance checks      |
| `guide`   | `docs/guides/`        | `kebab-case`   | Procedures, howtos, runbooks                          |
| `adr`     | `docs/decisions/adr/` | `kebab-case`   | Architecture decision records                         |
| `charter` | `work/charters/`      | `chr.<slug>`   | Strategic themes, project groupings                   |
| `project` | `work/projects/`      | `proj.<slug>`  | Roadmaps, phases, deliverables, constraints           |
| `item`    | `work/items/`         | `<type>.<num>` | PR-sized execution (task, bug, story, spike, subtask) |

### Content Boundaries

| Content                           | Spec     | Project      | Item     |
| --------------------------------- | -------- | ------------ | -------- |
| SCREAMING_SNAKE invariants        | **owns** | link to spec | —        |
| Design diagrams / file pointers   | **owns** | —            | —        |
| Acceptance checks / test commands | **owns** | —            | —        |
| Crawl/Walk/Run phases             | —        | **owns**     | —        |
| Deliverable tables with status    | —        | **owns**     | —        |
| Work item ID references           | —        | **owns**     | —        |
| Plain-language constraints        | —        | **owns**     | —        |
| Execution plan (checkboxes)       | —        | —            | **owns** |
| PR link, reviewer, attribution    | —        | —            | **owns** |
| Validation commands               | —        | —            | **owns** |

### Linkages

```
charter ──1:N──▶ project          (project.primary_charter → chr.*)
project ──1:N──▶ item             (item.project → proj.*; project roadmap refs item by ID)
item    ──N:M──▶ spec             (item.spec_refs → spec IDs)
spec    ──N:1──▶ project          (spec.implements → proj.*)
```

Rules:

- Projects reference items **by ID only** (`task.0005`), never by file path.
- Items reference specs **by ID only** (`spec_refs: billing-evolution`), never by path.
- Specs link to their parent project via `implements:` in frontmatter.

### ID Conventions

| Kind    | Format         | Example                 | Mutable                          |
| ------- | -------------- | ----------------------- | -------------------------------- |
| Doc     | `kebab-case`   | `activity-metrics`      | No                               |
| Charter | `chr.<slug>`   | `chr.platform-health`   | No                               |
| Project | `proj.<slug>`  | `proj.sandboxed-agents` | No                               |
| Item    | `<type>.<num>` | `task.0042`             | No (slug in filename is mutable) |

Item filenames: `work/items/<type>.<num>.<slug>.md` — prefix immutable, slug editable.

## Goal

One authoritative reference for: what types exist, what content each owns, and how they connect.

## Non-Goals

- Workflow sequencing (see [development-lifecycle](./development-lifecycle.md))
- CI enforcement implementation (future)

## Invariants

| Rule                   | Constraint                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| TYPE_MATCHES_DIRECTORY | A file's `type` field must match its directory. `type: spec` → `docs/spec/`              |
| ID_IMMUTABLE           | Once assigned, no ID changes. Ever.                                                      |
| CONTENT_OWNERSHIP      | Each type owns specific concerns. No bleeding across boundaries (see Content Boundaries) |
| SPECS_OWN_CONTRACTS    | Invariants (SCREAMING_SNAKE), acceptance checks, and design diagrams live in specs only  |
| PROJECTS_OWN_ROADMAPS  | Phases, deliverable tables, timelines, and work item lists live in projects only         |
| ITEMS_OWN_EXECUTION    | Checklists, validation commands, PR links, and attribution live in items only            |
| LINK_DONT_DUPLICATE    | If content exists in its owning type, link to it. Never restate.                         |

### Schema

**Spec** — `docs/spec/*.md`:

```yaml
id: example-spec # kebab-case, immutable
type: spec
title: Example Spec
status: draft|active|deprecated
spec_state: draft|proposed|active|deprecated
trust: draft|reviewed|canonical|external
summary: One line
read_when: When to read this
implements: proj.example # parent project (optional)
owner: handle
created: YYYY-MM-DD
verified: YYYY-MM-DD
tags: []
```

**Project** — `work/projects/proj.*.md`:

```yaml
id: proj.example # immutable
type: project
primary_charter: chr.example
title: Example Project
state: Active|Paused|Done|Dropped
priority: 0-3
estimate: 0-5
summary: One line
outcome: Success criteria
assignees: handle
created: YYYY-MM-DD
updated: YYYY-MM-DD
labels: []
```

**Item** — `work/items/<type>.<num>.*.md`:

```yaml
id: task.0042 # immutable, must match filename prefix
type: task|bug|story|spike|subtask
title: Example Task
status: needs_triage|needs_research|needs_design|needs_implement|needs_closeout|needs_merge|done|blocked|cancelled
priority: 0-3
rank: 99 # positive integer, 1 = highest within priority band
estimate: 0-5
summary: One line
outcome: Deliverable
spec_refs: example-spec # spec IDs, not paths
project: proj.example # parent project
assignees: handle
credit:
pr:
reviewer:
branch:
revision: 0 # integer, incremented on review rejection
blocked_by: # required when status=blocked
deploy_verified: false # set by cleanup agent after production deploy
claimed_by_run: # governance runner lock
claimed_at: # governance runner lock timestamp
last_command: # last /command that acted on this item
created: YYYY-MM-DD
updated: YYYY-MM-DD
labels: []
external_refs:
```

### File Pointers

| File                                 | Purpose                                       |
| ------------------------------------ | --------------------------------------------- |
| `scripts/validate-docs-metadata.mjs` | Enforces frontmatter schemas, IDs, cross-refs |
| `docs/_templates/spec.md`            | Spec template                                 |
| `work/_templates/project.md`         | Project template                              |
| `work/_templates/item.md`            | Item template                                 |
| `work/_templates/charter.md`         | Charter template                              |

## Open Questions

- [ ] Directory placement not yet enforced by CI (validator checks frontmatter only)

## Related

- [Development Lifecycle](./development-lifecycle.md) — workflow flows and commands
- [Work Management Guide](../../work/README.md) — front door to /work
- [Documentation Guide](../README.md) — front door to /docs
