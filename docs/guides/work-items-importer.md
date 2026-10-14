---
id: work-items-importer-guide
type: guide
title: Work-Items Importer — One-Shot Bootstrap
status: active
trust: draft
summary: "How to bootstrap a Cogni Doltgres `work_items` table from the legacy `work/items/*.md` corpus via a single HTTPS POST loop. Source IDs preserved (bug.0153 stays bug.0153). Prod cutover ran 2026-05-04; 477 items imported. The `.md` corpus has been removed from the repo."
read_when: "Bootstrapping a new env's knowledge_operator Doltgres, or re-running against a fresh DB."
owner: derekg1729
created: 2026-04-30
verified: 2026-05-04
tags: [work-system, doltgres, importer, operator, bootstrap]
---

# Work-Items Importer

> One CLI. POSTs every `work/items/*.md` row to `/api/v1/work/items` with `id` in the body. Server preserves the id. **Prod cutover ran 2026-05-04** — 477 items imported, source IDs preserved, `.md` corpus removed. Re-runs are idempotent (preflight skips IDs already in the target env).

## How it works

`nodes/operator/app/scripts/import-work-items-via-api.ts`:

1. Reads every `.md` under `work/items/` via `MarkdownWorkItemAdapter.list({})`.
2. Filters to valid `WorkItemType`s (skips `proj.*` — projects aren't work items).
3. For each item, POSTs to `<api>/api/v1/work/items` with the source id and all fields the contract accepts (`id`, `type`, `title`, `summary`, `outcome`, `node`, `projectId`, `parentId`, `specRefs`, `labels`, `priority`, `rank`, `estimate`, `status`).
4. Prints progress every 25 items + final `posted=N failed=N` summary.

Server-side:

- `POST /api/v1/work/items` (contract: `work.items.create.v1.contract`) accepts an optional `id` matching `^(task|bug|story|spike|subtask)\.\d{4,}$`. The Doltgres adapter rejects collisions with a clear error; missing `id` falls back to the `5000+` auto-allocator.

## Run

```bash
# 1. Get an apiKey
curl -X POST https://<env>.cognidao.org/api/v1/agent/register \
  -H 'content-type: application/json' \
  -d '{"name":"task.5002-importer"}' | jq -r .apiKey
# → COGNI_KEY=cogni_ag_sk_v1_...

# 2. Dry-run (no POSTs, just count + filter)
COGNI_KEY=... pnpm --filter operator import:work-items \
  --api https://<env>.cognidao.org --dry-run

# 3. Smoke (3 items)
COGNI_KEY=... pnpm --filter operator import:work-items \
  --api https://<env>.cognidao.org --limit 3

# 4. Full bulk
COGNI_KEY=... pnpm --filter operator import:work-items \
  --api https://<env>.cognidao.org
```

Args: `--api <baseUrl>` (default `https://preview.cognidao.org`; pass `https://cognidao.org` for prod), `--limit <N>`, `--dry-run`.

## Validation

```bash
# Spot-check a known legacy ID round-trips with original ID
curl https://<env>.cognidao.org/api/v1/work/items/bug.0002 \
  -H "authorization: Bearer $COGNI_KEY" | jq '{id,status,priority}'
# → id: "bug.0002" (NOT bug.5xxx); status + priority preserved

# Counts by type
curl "https://<env>.cognidao.org/api/v1/work/items?limit=500" \
  -H "authorization: Bearer $COGNI_KEY" \
  | jq '[.items[] | .type] | group_by(.) | map({type:.[0],count:length})'
```

## Promotion path

1. **candidate-a** (`test.cognidao.org`) — proven first. Validate spot-check.
2. Derek approves.
3. **preview** (`preview.cognidao.org`) — same script, different `--api`.
4. Derek approves.
5. **prod** (`cognidao.org`) — same script, different `--api`.

The importer **is** idempotent: a preflight `GET /api/v1/work/items?ids=…` skips any source IDs already present, so re-runs against a populated table are safe (already-imported items show as "already present, skipping" and POSTs are not attempted).

## Out of scope

- Project rows (`proj.*`). Skipped — projects aren't a `WorkItemType`. Future task: schema-level project support.
- Updates to already-imported items. The importer is bootstrap, not sync. Use `PATCH /api/v1/work/items/:id` for edits afterward.
- Markdown corpus deletion. Done as part of the prod-cutover PR (2026-05-04).
