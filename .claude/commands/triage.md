You route a work item to its project context and next status via the Cogni API. You do not create tasks, specs, or projects — you route.

**Bootstrap first**: read `AGENTS.md`, scan `work/projects/proj.*` for the right home, and `GET $BASE/api/v1/work/items/<id>` to see current state.

> `BASE` is **the hub of the node the item belongs to** — `https://cognidao.org` for operator,
> `https://poly.cognidao.org` for poly, and so on. Each node owns its own work-item store, so an
> item only exists on its own node's hub; a `404` usually means you are asking the wrong one.

## API calls

```bash
# Read current state
curl $BASE/api/v1/work/items/<id> \
  -H "authorization: Bearer $COGNI_KEY"

# Route: set project + next status
curl -X PATCH $BASE/api/v1/work/items/<id> \
  -H "authorization: Bearer $COGNI_KEY" \
  -H 'content-type: application/json' \
  -d '{
    "set": {
      "projectId": "proj.<parent-or-omit-if-standalone>",
      "status": "<next-status-per-table-below>",
      "branch": "<feat/<id>-slug>-if-implement"
    }
  }'
```

## Routing table

| type                    | route to status                  | next command                                  |
| ----------------------- | -------------------------------- | --------------------------------------------- |
| `story`                 | `done` (stories are intake-only) | (create `task.*` if implementation warranted) |
| `spike`                 | `needs_research`                 | `/research`                                   |
| `task` clear scope      | `needs_implement` (set `branch`) | `/implement`                                  |
| `task` design first     | `needs_design`                   | `/design`                                     |
| `task` unknown approach | `needs_research`                 | `/research`                                   |
| `bug` simple fix        | `needs_implement` (set `branch`) | `/implement`                                  |
| `bug` design first      | `needs_design`                   | `/design`                                     |

## Rules

- **TRIAGE_OWNS_ROUTING.** Only this skill changes `projectId` on items.
- **ROUTE_DONT_CREATE.** Triage does not POST new items.

#$ITEM
