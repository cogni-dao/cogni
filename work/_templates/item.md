---
id: # <type>.<num> — must match filename prefix
type: # task | bug | story | spike | subtask
title:
status: needs_triage
priority: 1
rank: 99
estimate: 2
summary:
outcome:
spec_refs:
assignees:
credit:
project:
branch:
pr:
reviewer:
revision: 0
blocked_by:
created:
updated:
labels: []
external_refs:
---

# [Item Title]

## Requirements

<!-- What must be true when this is done? Be specific. -->

- Requirement 1
- Requirement 2

## Allowed Changes

<!-- What files/areas may this item touch? Scope boundaries. -->

- Area 1
- Area 2

## Plan

<!-- Step-by-step execution plan. -->

- [ ] Step 1
- [ ] Step 2
- [ ] Step 3

## Validation

<!-- Name exact commands/tests and expected outcome. -->

**Command:**

```bash
pnpm test path/to/test.ts
```

**Expected:** All tests pass.

## Review Checklist

<!-- All required before status=done. -->

- [ ] **Work Item:** `<type>.<num>` linked in PR body
- [ ] **Spec:** all invariants of linked specs (here, or project) are upheld
- [ ] **Tests:** new/updated tests cover the change
- [ ] **Reviewer:** assigned and approved

## PR / Links

<!-- PR URL and any related links. -->

-

## Attribution

<!-- Credit contributors. -->

-
