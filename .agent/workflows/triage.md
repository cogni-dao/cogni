---
description: Route a work item to the right project
---

**Canonical body: [`.claude/commands/triage.md`](../../.claude/commands/triage.md). Follow it.**

This file previously carried its own copy of the lifecycle, which taught the
file-based work-item system (`work/_templates/item.md`, `work/items/_index.md`,
hand-allocated ids). That system was removed — the `work/items/*.md` corpus was
imported into Doltgres and deleted, and `/triage` explicitly forbids creating those
files. Agents following the old body produced items the API never saw.

The contract in one line: route items through the HTTP API, against **the hub of the
node you are working on** — each node owns its own work-item store, so the hub
you call _is_ the node assignment.

```bash
# operator: https://cognidao.org · poly: https://poly.cognidao.org · …
: "${BASE:?set BASE to this repository's node origin; never default work-item writes to operator}"
curl $BASE/.well-known/agent.json | jq '.actions'   # method + JSON Schema per write
```

Never add `.md` files under `work/items/`. The API is the source of truth.
