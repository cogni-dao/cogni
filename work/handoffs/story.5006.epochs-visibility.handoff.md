---
id: story-5006-epochs-visibility-handoff
type: handoff
title: "story.5006 handoff — what shipped, what is left, and the trap that cost a day"
status: active
trust: draft
summary: "levelup earns on production and the wizard defect is fixed at source. Remaining: a node's epochs are unreadable except via Loki, and three unverified fixes to that endpoint failed. Start from the proof, not the code."
read_when: Picking up story.5006, task.5018/5019, or anything touching node epochs, attribution routing, or the operator epochs gateway.
owner: derekg1729
created: 2026-09-01
verified: 2026-09-01
tags: [handoff, attribution, epochs, story-5006, levelup]
---

# story.5006 handoff

## Shipped and proven

| what                                      | proof                                                                                                      |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Wizard defect fixed at source** (#2079) | promotion now carries `activity_env = max(nextEnvs)`. Future spawns earn receipts with **no manual step**. |
| **levelup earns on production** (#2078)   | Loki `01:49:12` — `Created new epoch`, `status: open`, full clean collect pass.                            |
| bug.5008 gateway revived (#2004)          | merged after 18 days blocked on a one-line SPDX header.                                                    |
| README is node identity (nt#107)          | `README.md` → Tier-3, so nodes stop shipping the template's README.                                        |

## The defect that actually matters

**A node's epochs are unreadable except through Loki.**

- `/api/v1/public/attribution/epochs` — finalized-only **by design**, not a bug.
- `/api/v1/nodes/{id}/attribution/epochs` — the gateway proxies to
  `http://<slug>-node-app:3000/api/internal/attribution/epochs`, **which does not exist in
  node-template**. Every foreign node errors.

This cost a full day: levelup looked epoch-less while it had an open epoch the whole time,
and the investigation twice concluded the wrong thing from those endpoints.

### The fix, scoped (bug.5083)

Port the internal epochs receiver into node-template. Survey already done:

1. **Mirror**: `app/src/app/api/internal/attribution/receipts/route.ts` is the write twin —
   `verifySchedulerBearer`, `wrapRouteHandlerWithLogging`, container store,
   `NODE_WRITES_OWN_LEDGER`. The read twin is simpler: no idempotency.
2. **Contract missing node-side**: node-template has
   `attribution.receipts.internal.v1.contract.ts` but not the epochs one — it exists only in
   the cogni monorepo. `packages/**` is Tier-2, so check the authoring direction first.
3. **No node-side `listEpochs`** exists under `app/src/features/attribution`. Operator's
   `features/attribution/read/epoch-views.ts` `listEpochsForNode` is the reference shape.

**Before:** operator asks beacon for epochs → 404, no receiver.
**After:** returns beacon's actual epochs.
**Proof:** flight node-template → `node-template-test`, curl the internal route with the
scheduler bearer, then through the operator gateway.

## Read this before touching that endpoint — I failed it three times

Three fixes shipped to this one route in one night, none verified first, all wrong:

1. Revived #2004 and promoted on CI-green → **the node-side receiver did not exist**.
2. #2085 mapped the error to a typed 502 → **`instanceof` silently false**, still 500.
3. #2086 fixed that structurally → **could not be proven** (403: no `node.flight` on any
   foreign node with the candidate-a key). Closed rather than shipped on faith.

Two durable traps came out of it:

- **`instanceof` on a custom Error is unreliable across Next.js chunk boundaries.** Proven in
  prod by the minified `{"type":"i"}` in the log. 12+ other sites — one proven failing, one
  proven working (`/identity/attest`), **`/readyz` unaudited and it decides pod readiness**.
  Full list in **bug.5084**. Use a `kind` discriminant, never `instanceof`.
- **Validate on candidate-a before promoting, even for a "revived, already-reviewed" PR.**
  Both failure #1 and #2 would have surfaced in one flight.

## Remaining work, in order

1. **task.5018 second half** — levelup is claimable and has a live prod epoch. It needs **one
   real merged PR on `cogni-dao/levelup`** to produce its first receipt. Needs a human or
   another contributor; do not manufacture a throwaway PR for it.
2. **bug.5083** — the receiver (above). Makes epochs answerable without Loki.
3. **bug.5084** — the `instanceof` audit, `/readyz` first.
4. **bug.5065** — poly is scaled to 0 and the box is unfixed. Poly's
   `poly_trader_current_positions` scans swap-thrashed the VM into `NodeNotReady ×83` over
   10 days. **Do not restore poly before fixing the query cost.** Note poly still holds a
   live `ledger_ingest` schedule while scaled to zero — "scaled to 0" and "descheduled" are
   not the same state.
5. **PR triage.** Three times in one night a fix already existed or landed in parallel
   (bug.5008 rotted 18 days on a lint rule; bug.5081 was fixed while I diagnosed it; and I
   misremembered hitting a third). ~24 open PRs. Search before deriving.
