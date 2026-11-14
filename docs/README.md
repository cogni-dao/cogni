id:: docs-system-guide
type:: guide
title:: Documentation System Guide
status:: draft
trust:: draft
summary:: How to navigate, create, and maintain documentation in this repository.
read_when:: You need to create, move, or understand the documentation structure.
owner:: derekg1729
created:: 2026-02-05
verified:: 2026-02-05
tags:: documentation, meta

# Documentation System Guide

> Front door to `/docs`. All curated knowledge lives here.

## Structure

| Directory      | Purpose                               |
| -------------- | ------------------------------------- |
| `spec/`        | Invariants, interfaces, contracts     |
| `decisions/`   | ADRs and EDO governance traces        |
| `guides/`      | Procedures (setup, howto, runbooks)   |
| `postmortems/` | Incident reviews, root cause analysis |
| `archive/`     | Deprecated docs                       |

## Doc Types

| type         | Use for                                  |
| ------------ | ---------------------------------------- |
| `spec`       | System contracts, invariants, interfaces |
| `adr`        | Architecture decision records            |
| `guide`      | Setup, howto, runbook procedures         |
| `postmortem` | Incident reviews, root cause analysis    |

## Metadata Format

Docs in `docs/spec/` use YAML frontmatter:

```yaml
---
id: scheduler-spec
type: spec
title: Scheduled Graph Execution
status: active
spec_state: active
trust: canonical
summary: Invariants for Temporal schedules.
read_when: Changing scheduling or execution grants.
implements:
owner: derekg1729
created: 2026-01-15
verified: 2026-02-05
tags: [scheduler, temporal]
---
```

**Required (specs):** `id`, `type`, `title`, `status`, `spec_state`, `trust`, `summary`, `read_when`, `owner`, `created`, `verified`, `tags`

Work items (`work/projects/`, `work/items/`) use a different field set — see `https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/work/README.md`.

## Trust Levels

| Trust       | Meaning                             |
| ----------- | ----------------------------------- |
| `canonical` | Source of truth, CI-validated       |
| `reviewed`  | Peer-reviewed, accurate at verified |
| `draft`     | Work in progress                    |
| `external`  | Reference only, not authoritative   |

## Creating Docs

Do not add Markdown here. Contribute durable knowledge to the hub through [knowledge-contribution-flow](https://cognidao.org/knowledge/knowledge-contribution-flow). Contracts and invariants, procedures, research and incident lessons each have a hub entry type; [segment-markdown-knowledge](https://cognidao.org/knowledge/segment-markdown-knowledge) maps content to its destination.

## Hard Rules

1. **YAML_FRONTMATTER** — Use YAML frontmatter (`---` delimiters) for all typed docs
2. **NO_WIKILINKS** — Use `[text](path)` markdown links
3. **TYPE_MATCHES_DIR** — `type` must match parent directory
4. **UNIQUE_IDS** — Each `id` unique repo-wide
5. **FIELD_SET_SEPARATION** — Docs fields (`id`, `status`, `trust`) are forbidden in `work/`; work fields (`work_item_id`, `state`) are forbidden in `docs/`

## Related

- [Work Management](https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/work/README.md)
- [Organization Plan](./DOCS_ORGANIZATION_PLAN.md)
