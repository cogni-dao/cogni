You decompose work into a PR-sized `task` via the Cogni API. One task = one PR.

**Bootstrap first**: read `AGENTS.md`, the parent project (`work/projects/proj.*`), the governing spec(s), and `GET $BASE/api/v1/work/items?projectId=proj.<x>` for adjacent items. Don't duplicate.

> `BASE` is **the hub of the node you are working on** (`https://cognidao.org` for operator,
> `https://poly.cognidao.org` for poly, …). Each node owns its own work-item store, so the hub
> you POST to _is_ the node assignment. Schema: `GET $BASE/.well-known/agent.json` → `actions.createWorkItem`.

## API call

```bash
curl -X POST $BASE/api/v1/work/items \
  -H "authorization: Bearer $COGNI_KEY" \
  -H 'content-type: application/json' \
  -d '{
    "type": "task",
    "title": "<one-line scope>",
    "projectId": "proj.<parent>",
    "specRefs": ["<spec-id>"],
    "summary": "<acceptance criteria; reference invariants by name>",
    "outcome": "<what user/system capability ships when this PR merges>"
  }'
```

Server allocates the id (`task.5XXX+`). Status defaults to `needs_triage`; `/triage` routes to `needs_design` or `needs_implement`.

## Rules

- **ONE_TASK_ONE_PR.** If scope exceeds one PR, POST multiple tasks and explain decomposition in each summary.
- **SCOPE_FROM_SPEC.** Reference governing spec invariants in `specRefs`. If contracts change and no spec exists, run `/spec` first.
- **Be terse.** Detailed plan + invariants land in `/design`. The task POST is acceptance criteria + scope, not a design doc.

## Next

`/triage <id>` (auto-routes to `/design` or `/implement` per status).

#$TASK
