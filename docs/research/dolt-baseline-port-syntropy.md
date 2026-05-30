---
id: dolt-baseline-port-syntropy
type: research
title: "Dolt knowledge + work_items baseline before node-template port lands (PR #1377)"
status: draft
trust: draft
summary: "PR #1377 byte-copies operator's knowledge_contributions, knowledge_contribution_commits, and work_items tables into node-template's new doltgres-schema package — institutionalizes per-node table drift before the second node even ships. This PR (#1378) promotes all 3 tables to @cogni/knowledge-base using operator's shape (base_commit + head_commit + commit_count + workItems) and refactors operator's doltgres-schema package to pure re-exports. Drizzle-kit generates ZERO new migrations post-move (byte-equivalent verified locally). Node-template port (#1377) now adopts the shared base via re-export — no new schema definitions on the artifact side."
read_when: Reviewing PR #1377 (node-template doltgres substrate port), deciding whether contribution tables belong in @cogni/knowledge-base, evaluating whether work_items should be promoted, or designing the second-node baseline for any future fork.
owner: derekg1729
created: 2026-05-30
verified:
tags:
  [
    dolt,
    knowledge,
    work-items,
    node-template,
    syntropy,
    port,
    contribution-flow,
  ]
external_refs:
  - spike.5004
---

# Research: Dolt knowledge + work_items baseline before node-template port lands

> spike: spike.5004 | date: 2026-05-30 | written under `/knowledge-syntropy-expert` lens

## Revision history (most recent first)

- **rev 2 (current, implemented in this PR)** — `/review-design` strengthened the rev-1 recommendation: promote ALL 3 tables (contributions + contribution_commits + work_items), not just 2. PR scope expanded from research-only to **research + operator refactor + work_items promotion + drizzle-kit verification**. Drizzle-kit confirms zero new migrations post-move (`No schema changes, nothing to migrate 😴`) — byte-equivalent against the existing 0004 snapshot. Node-template port (#1377) now needs to adopt the shared base via re-export instead of duplicating definitions.
- **rev 1** (superseded on work_items scope) — recommended promoting contributions + contribution_commits, leaving work_items duplicated for v0 pending PR #1175 (corpus-as-knowledge draft). Self-review found this inconsistent with the same `SCHEMA_GENERIC_CONTENT_SPECIFIC` rule it cited for contributions; if PR #1175 ever lands and dissolves work_items into knowledge entries, removing the shared table at that point is trivial.

## Question

PR #1377 (task.5077, "node-template doltgres substrate + knowledge contributions API + DoltHub mirror") is open and adds 43 files / +3155 LoC. It copies operator's `knowledge_contributions`, `knowledge_contribution_commits`, and `work_items` table definitions verbatim into a new `nodes/node-template/packages/doltgres-schema/` package. The shared base `@cogni/knowledge-base` already holds `knowledge` + `domains` + `sources` + `citations`. What's the syntropy-correct baseline for the second node — and what needs to change before #1377 merges?

## Context (verified at PR #1377 head 68cde05a)

**Shared base** (`packages/knowledge-base/src/schema.ts`) exports 4 tables: `knowledge`, `domains`, `sources`, `citations`. The footer comment (lines 148-151) explicitly states `knowledge_contributions` was kept operator-local "for now."

**Operator schema** (`nodes/operator/packages/doltgres-schema/src/{knowledge,work-items}.ts`):

- `knowledge_contributions` (newer shape): `id, branch, state, principalId, principalKind, message, baseCommit, headCommit, commitCount, mergedCommit, closedReason, idempotencyKey, confidencePct, createdAt, resolvedAt, resolvedBy`
- `knowledge_contribution_commits`: per-dolt-commit principal attribution (composite PK `contributionId + seq`, references `commitHash`)
- `work_items`: full operator workflow table (id, type, title, status, node, projectId, parentId, priority, rank, estimate, summary, outcome, branch, pr, reviewer, revision, blockedBy, deployVerified, JSONB assignees/externalRefs/labels/specRefs)

**Node-template current state** (pre-#1377):

- `nodes/node-template/packages/knowledge/src/schema.ts` — re-exports the 4 shared tables + defines its OWN `knowledgeContributions` with an **older divergent shape** (`entryCount + commitHash` instead of operator's `baseCommit + headCommit + commitCount`). No `knowledgeContributionCommits`. No `work_items`.

**PR #1377 in-flight changes:**

- New `nodes/node-template/packages/doltgres-schema/src/knowledge.ts` — **byte-copy of operator's contribution tables** (only the module-docstring name changed)
- New `nodes/node-template/packages/doltgres-schema/src/work-items.ts` — **byte-copy of operator's work_items table** (only module-docstring + a `task.5077` reference changed)
- New doltgres-migrations + Dockerfile stage + contribution API routes (all node-template-local)
- Old `nodes/node-template/packages/knowledge/` directory likely deprecated (PR replaces it with the new doltgres-schema package)

## Findings

### Finding 1 — PR #1377 institutionalizes the drift class the doctrine forbids

Three table definitions now live in two packages with no shared base:

```
@cogni/operator-doltgres-schema/{knowledge,work-items}   ← canonical today
@cogni/node-template-doltgres-schema/{knowledge,work-items}   ← byte-copy added by #1377
```

Both packages re-export the 4 base tables from `@cogni/knowledge-base` for the knowledge family. But `knowledge_contributions`, `knowledge_contribution_commits`, and `work_items` are duplicated in two places. The moment the contribution model evolves (new column for retry tracking, change to `confidencePct` default, new index), we have to remember both. The 7-harness drift we just purged (PR #1373, spike.5003) proves we _will_ forget.

This violates `SCHEMA_GENERIC_CONTENT_SPECIFIC`: tables are generic infrastructure; what differs per node is `domain` registry contents + `source_node` values + per-row `tags`. The tables themselves should not vary.

### Finding 2 — The contribution table shape question is settled; promote operator's

Node-template's pre-#1377 schema has the older shape (`entryCount + commitHash`). PR #1377 ports the newer shape (`baseCommit + headCommit + commitCount`) via byte-copy. `baseCommit` matters because branches aren't always cut from main's current HEAD; `commitCount` is dolt-canonical, while `entryCount` blurs commits-vs-entries. Operator's shape wins.

### Finding 3 — `work_items` is a different question; possibly premature to promote at all

PR #1175 (April 2026, draft) proposed migrating specs/projects/items into doltgres as knowledge entries (`entry_type: task` / `entry_type: bug` / `entry_type: spike`). If that direction holds, `work_items` collapses into `knowledge` rows and the dedicated table goes away. Promoting `work_items` to shared base now is wasted churn **if** the corpus-as-knowledge direction lands. **But** node-template already needs `work_items` today for its own lifecycle (task.5077 says so), so the table exists either way; the question is whether the long-arc dissolves it.

Per `RECALL_BEFORE_WRITE`, the syntropy-correct move on work_items is: don't promote yet, don't block PR #1377 on it, but flag the duplication explicitly so the porter is aware that work_items shape is on a shorter half-life than the contribution tables.

### Finding 4 — Adapter is already correctly factored; only schemas drift

`packages/knowledge-store/src/adapters/doltgres/contribution-adapter.ts` already lives in a SHARED package (`@cogni/knowledge-store`), uses native `dolt_commit` / `dolt_merge` / `dolt_diff` / `dolt_hashof` calls, and works against whichever Drizzle table is injected. The adapter doesn't drift across nodes — only the table definitions do. So promoting the tables to shared base is **cheap**: no adapter change, just move the file and update two re-export sites.

### Finding 5 — The dolt-commit-metadata question (whether `principal_id` could live in dolt commit metadata, collapsing `knowledge_contribution_commits` entirely) remains open

I flagged this last turn. The contribution-api design doc explicitly chose the metadata-table approach: _"Dolt owns history. Cogni metadata exists only for app-level facts Dolt does not know..."_ But Doltgres may support arbitrary commit attributes (git-notes / trailers style) that would let `principal_id` live IN the commit. If yes, `knowledge_contribution_commits` collapses to zero rows. This is a separate spike, not blocking #1377 — the promotion to shared base is correct either way, and the table simply gets retired or shrunk later.

## Recommendation

**Pause PR #1377 before merge. Make the schema-promotion change in this PR (or as a small predecessor PR), then resume.** Concretely:

### Required before #1377 merges

1. **Promote both contribution tables to `@cogni/knowledge-base`.** Move the definitions from `nodes/operator/packages/doltgres-schema/src/knowledge.ts` (lines 38-93) into `packages/knowledge-base/src/schema.ts`, after the existing `citations` block. Update the footer comment that said "moved to operator's own doltgres-schema package — per-node, not shared base" — that decision is being reversed.

2. **Use operator's shape (newer)**: `baseCommit + headCommit + commitCount`, not node-template's older `entryCount + commitHash`. The old node-template `knowledgeContributions` had zero production data per the package version history (it was the syntropy seed from PR #1141, never wired to a live route on node-template until #1377).

3. **Both packages re-export from base.** `nodes/operator/packages/doltgres-schema/src/knowledge.ts` becomes a re-export of all 6 tables (4 from base + 2 contribution tables). `nodes/node-template/packages/doltgres-schema/src/knowledge.ts` does the same. No duplicate table definitions anywhere.

4. **Migration check**: operator already has live contribution rows. Verify the new shared-base schema is byte-equivalent to operator's existing in-prod definition — no migration needed, just a code-side refactor. Doltgres won't notice. (If any column is silently different, that's a separate migration.)

### Acceptable as-is in #1377

5. **`work_items` byte-copied to node-template's doltgres-schema** — acceptable for v0 because (a) operator and node-template will be the only two nodes with work_items for the foreseeable future, and (b) PR #1175 may dissolve the table into knowledge entries, making promotion wasted churn. Flag in #1377 review: "work_items duplicated intentionally; revisit when corpus-as-knowledge direction is decided." Add a TODO comment in both copies citing PR #1175 + this spike.

6. **DoltHub mirror folded into #1377** — per `feedback_one_pr_per_task`, that's borderline scope-creep; if it's <100 LoC and tightly coupled it can ride along, otherwise split. Not blocking, reviewer's call.

### Deferred (separate spikes / tasks, prose only)

7. **Dolt commit metadata as `principal_id` substrate** — file as its own spike if and when we see drift in `knowledge_contribution_commits`. Until then the table is correct.

8. **work_items → knowledge entries** — wait for PR #1175 to either land or formally close. If it lands, the work_items table retires across all nodes. If it closes-as-rejected, promote work_items to shared base then.

9. **External `Cogni-DAO/node-template` repo** — once #1377 merges with the shared-base promotion, sync-drift detector auto-propagates the new shared package + the re-export site. No manual action needed; the drift report (issue #1366) surfaces any artifact-side gap.

## Open Questions

- **Drizzle config globbing**: does `nodes/operator/drizzle.doltgres.config.ts` glob `@cogni/knowledge-base` for table definitions, or only its own package? If only own, the re-export needs to surface the tables at the same path or the config needs adjustment. Verify before promoting.
- **Existing operator data + idempotency keys**: the `uniq_kc_idempotency` unique index spans `(principal_id, idempotency_key)`. If the promotion changes the index name or columns, operator's live data needs care. Should be byte-equivalent if done right.
- **Per-node domain registry**: domains are shared via the `domains` table but their _registered values_ are per-node. Confirm node-template's domain seed (`packages/knowledge/src/seeds/domains.ts` in the PR) is appropriate — not just operator's domains copied.
- **PR #1175 status**: who owns it? Is it close to landing, or stalled? The answer determines whether `work_items` promotion ever happens.

## Proposed Layout

> Captured as prose. Single concrete change before #1377 merges.

### The one action

Edit `packages/knowledge-base/src/schema.ts` to add `knowledgeContributions` + `knowledgeContributionCommits` (operator shape). Update operator's `nodes/operator/packages/doltgres-schema/src/knowledge.ts` to re-export instead of define. Update PR #1377's `nodes/node-template/packages/doltgres-schema/src/knowledge.ts` to re-export instead of define. Three small edits, no schema migration, ~50 LoC delta.

### How this fits

- `@cogni/knowledge-base` becomes the single source of truth for all 6 dolt knowledge-family tables. Drift class eliminated.
- `@cogni/knowledge-store` adapter stays put; no change needed.
- Sync-drift detector (PR #1373's mechanism) auto-flags any future fork that diverges.
- `work_items` stays duplicated for v0, flagged as short-half-life pending PR #1175.

### Why this isn't preemptive

This is _refining_ the existing PR (#1377), not fanning out new work items. The spike captures the syntropy reason; the change rides in the same PR or a tiny predecessor. No work-item fan-out beyond this spike + the open-question follow-ups (which stay prose).
