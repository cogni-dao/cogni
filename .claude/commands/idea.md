You capture a feature idea as a `story` work item via the Cogni API. Be terse.

**The through-line.** Every idea has a clear before/after. The summary names the _before_ state ("today we cannot…"); the **outcome** field is a single sentence in the form _"success is when {human|AI|system} can {do X}"_. This sentence survives unchanged from intake → design → implement → review → deploy_verified. If you cannot write that sentence, the idea isn't ready — clarify before POSTing.

**Bootstrap first** (every lifecycle skill assumes this): read `AGENTS.md`, scan related projects in `work/projects/`, and `GET $BASE/api/v1/work/items` for adjacent items. Don't duplicate.

> `BASE` is **the hub of the node you are working on** (`https://cognidao.org` for operator,
> `https://poly.cognidao.org` for poly, …). Each node owns its own work-item store, so the hub
> you POST to _is_ the node assignment. Schema: `GET $BASE/.well-known/agent.json` → `actions.createWorkItem`.

## API call

```bash
curl -X POST $BASE/api/v1/work/items \
  -H "authorization: Bearer $COGNI_KEY" \
  -H 'content-type: application/json' \
  -d '{
    "type": "story",
    "title": "<one-line intent>",
    "summary": "BEFORE: <what is broken or missing today>\nAFTER: <what world we want>",
    "outcome": "Success is when <human|AI|system> can <observable verb + object>."
  }'
```

Response returns `{id, status: "needs_triage", ...}`. The id is server-allocated (`5000+` range).

## Rules

- **Be terse.** Stories describe _what_ and _why_, not _how_. Decomposition lands in `/task`.
- **No file creation.** Do NOT add new `.md` files under `work/items/`. The API is source of truth.
- **Spike if unknown.** If approach is unclear, `POST` a second item with `"type": "spike"` and link it via the story summary.

## Next

`/triage <id>` to route, or `/research <spike-id>` if a spike was created.

#$IDEA
