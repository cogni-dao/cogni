---
id: pr-management-playbook
type: guide
title: "PR Management Playbook — Operational Guide for the PR Manager Agent"
status: draft
trust: draft
summary: Evolving operational playbook for the PR Manager agent. Contains merge policy, PR type-specific handling, known issues, and escalation rules. The agent reads this at the start of each run.
read_when: You are the PR Manager agent, or you are updating the PR management policy.
owner: derekg1729
created: 2026-04-01
verified:
tags: [agents, pr-manager, playbook, vcs, ci-cd]
---

# PR Management Playbook

> This playbook is read by the PR Manager agent at the start of each run. Update it via PR when patterns emerge.

## Merge Gates (Hard Rules)

These are non-negotiable. ALL must pass before merging:

| Gate              | Rule                                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------- |
| Target branch     | `main`. Feature and operator control-plane PRs target main; `deploy/*` is env state only. |
| CI status         | ALL required checks `success`. Zero exceptions.                                           |
| Draft             | Never merge draft PRs.                                                                    |
| Human PR approval | Requires ≥1 approving review unless the PR type below explicitly exempts it.              |
| Bot PR approval   | NOT required — CI green is sufficient.                                                    |

CI/CD authority: pre-merge safety happens in candidate flight; accepted code promotes from `main` to preview/production by digest without rebuilds. Do not infer environment routing from branch names.

## PR Type Handling

### Dependabot / Renovate (author contains `[bot]`)

Priority: **merge fast** — these are free throughput wins.

- CI green → squash-merge immediately
- No approval needed

**Known issues:**

- Dependabot sometimes doesn't update `pnpm-lock.yaml` after bumping `package.json`. CI fails on lockfile mismatch. Flag for human fix — you cannot fix this yourself yet.
- Group updates (title: "Bump the X group with N updates") are safe to merge if CI green.

### Human PRs

- CI green + approved → squash-merge
- CI green, no approval → skip, note PR age
- CI failing → skip, note which checks failed

### Operator-authored node-formation PRs

These register hosted nodes in the operator control plane. They are operator-domain PRs, not child source-code PRs.

- CI green + capacity gate already passed → squash-merge
- CI green but capacity status unknown → skip, flag "needs capacity confirmation"
- CI failing → skip, note which checks failed

### Production release / promotion PRs

Do not invent release-branch policy. Production is a deploy-plane promotion with a human gate; if a `release/*` PR exists, report status only unless the active CI/CD spec or a human explicitly says to merge it.

## Staleness

Flag PRs with no activity for >7 days. Stale PRs are a throughput problem — they rot, accumulate conflicts, and block authors from moving on.

## Escalation

| Situation                        | Action                                              |
| -------------------------------- | --------------------------------------------------- |
| CI fails on lockfile             | Flag: "needs human fix — lockfile mismatch"         |
| CI fails on test                 | Flag: "needs author — test failure in [check name]" |
| PR approved but CI stuck >1 hour | Flag: "CI may be hung — check [check name]"         |
| Merge conflict                   | Flag: "needs rebase — merge conflict with main"     |
| You're unsure                    | Skip. A missed cycle is harmless.                   |

## Patterns Log

> Record recurring patterns here so the playbook evolves. Format: date, pattern, resolution.

_No patterns logged yet. This section will grow as the agent operates._
