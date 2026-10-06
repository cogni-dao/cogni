You file a bug as a `bug` work item via the Cogni API. Investigate first, file second. Always include code pointers.

**The through-line.** A good bug names the broken behavior (_before_), the desired behavior (_after_), and a single success sentence — _"success is when {human|AI} can {do X without seeing the failure}"_ — that survives all the way to `deploy_verified`. If you can't write that sentence, you don't yet understand the bug.

**Bootstrap first**: read `AGENTS.md`, the suspect code, related tests / logs / stack traces, and `GET $BASE/api/v1/work/items?types=bug` to check for duplicates.

> `BASE` is **the hub of the node you are working on** — `https://cognidao.org` for operator,
> `https://poly.cognidao.org` for poly, and so on. Each node owns its own work-item store, so
> filing against the wrong hub puts the bug in the wrong node's ledger. The write schema is
> discoverable from the node itself: `GET $BASE/.well-known/agent.json` → `actions.createWorkItem`.

## Investigate before filing

1. Read the suspect code (or grep for it).
2. Identify root cause if possible — or narrow to a suspect file:line.
3. Note any spec invariants violated.

No bugs filed on assumptions. If you can't point at code yet, run `/research` instead.

## API call

```bash
curl -X POST $BASE/api/v1/work/items \
  -H "authorization: Bearer $COGNI_KEY" \
  -H 'content-type: application/json' \
  -d '{
    "type": "bug",
    "title": "<one-line symptom>",
    "priority": 1,
    "specRefs": ["<spec-id-if-violated>"],
    "summary": "OBSERVED: <what happens, with file:line>\nEXPECTED: <what should happen>\nREPRO: <steps>\nIMPACT: <who/severity>",
    "outcome": "Success is when <human|AI> can <do the broken thing without seeing the failure>."
  }'
```

`priority: 0` for security or data-loss bugs. Server allocates the id (`bug.5XXX+`). Status defaults to `needs_triage`.

## Rules

- **INCLUDE_CODE_POINTERS.** Every bug names files and lines, not "the login flow."
- **No file creation.** Do NOT add new `.md` files under `work/items/`. The API is source of truth.

## Next

`/triage <id>` to route to `/implement` (simple fix) or `/design` (needs investigation).

#$BUG
