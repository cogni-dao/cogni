---
id: story.5085.handoff
type: handoff
work_item_id: "story.5085"
status: active
created: 2026-10-15
updated: 2026-10-15
branch: derekg1729/bug-5459-serve-alert
last_commit: 66ec888c71
---

# Handoff: story.5085 CEO advisor / architect (reliability + compute efficiency)

## Mission

Pickup: you are the CEO's independent architect and advisor for substrate reliability. You do not implement. You (1) verify every claim against live ground truth, (2) own the **database design pivot** the CEO demanded, and (3) steer the 3–4 working agents with tiny copy/paste messages. The previous advisor lost the CEO's trust through flailing: three sandbox-design reversals, one wrong Akash recommendation, a wrong "Poly logs missing" claim, prompts with no specifics or work items, and proposing per-node databases after the CEO had ruled for efficiency. Do not repeat those.

## Goal

- **Design pivot (CEO ruling 2026-10-15): no database locking, ever.** The current design's "contain" step revokes the noisiest node's DB logins. It misfired at 14:01Z and locked the candidate operator during a routine deploy. The CEO also rejected "one database per node" because it wastes compute. The target is the **shared tier, made safe without locks**: reliable _and_ compute-efficient, with dedicated cells only for proven outliers (Poly today).
- E2E signal: a Poly-shaped load on candidate's shared Postgres slows only the loader, every neighbor holds SLO, no role is locked, and all 13 catalog slots pass two-region `/readyz?deep=1` at their exact `/version.buildSha`.
- Story Goal / Done-when text in [story.5085](https://cognidao.org/work/items/story.5085) still says "contained … audited re-admission". The CEO must approve the reworded Done-when for the pivot before you persist it.

## Start By Reading

- [noisy-neighbor-database-architecture](https://cognidao.org/knowledge/noisy-neighbor-database-architecture): current north-star design; its contain/readmit section is what is being reversed.
- [shared-substrate-tenancy-standard](https://cognidao.org/knowledge/shared-substrate-tenancy-standard): the 8-verb standard. **Bound** (native per-tenant limits) is the step to lean on; **Contain** is the one to rethink.
- [database-expert skill](https://github.com/cogni-dao/cogni/blob/main/.agents/skills/database-expert/SKILL.md) and [fleet-reliability-control-loop](https://cognidao.org/knowledge/fleet-reliability-control-loop).
- Code: [readmit route (human-session only)](https://github.com/cogni-dao/cogni/blob/996d1a7793/nodes/operator/app/src/app/api/v1/nodes/%5Bid%5D/observability/health/route.ts#L229-L245) · [PR #2729 controller](https://github.com/cogni-dao/cogni/pull/2729) · [provision.sh role budgets](https://github.com/cogni-dao/cogni/blob/996d1a7793/infra/compose/runtime/postgres-init/provision.sh) · [catalog DB tiers](https://github.com/cogni-dao/cogni/blob/996d1a7793/infra/catalog/_schema.json).
- Prior review records in this branch: `work/reviews/story-5085-*.md`, `work/reviews/red-sandbox-design.review.md`.

## Current State

- **Live (verified 20:19Z):** production operator, Poly (own Akash Postgres cell since ~10Z), and Red all pass deep readyz. Production Postgres has no non-production DBs ([bug.5299](https://cognidao.org/work/items/bug.5299) done).
- **Poly knowledge 500 fixed live** ([bug.5477](https://cognidao.org/work/items/bug.5477)): Docker maps 5432 and 5435 to the same container port, so the Postgres fence also blocked Doltgres. [PR #2775](https://github.com/cogni-dao/cogni/pull/2775) also fixes candidate/preview reconciles overwriting production's firewall allowlist (a cross-env bug). It was in flight at 20:16Z.
- **Candidate operator is locked** since 14:01Z (deep readyz `INTERNAL_ERROR`). The CEO ruled "agents may unlock" candidate/preview; the change to the readmit route is not built yet.
- The controller (#2729) is merged to main but **not in the production build** (`cognidao.org/version` = 756291b4). It must not reach production while locking exists.
- Candidate VM: 6 GB at max tier, ~23–25% memory free, running one scheduler-worker ([#2772](https://github.com/cogni-dao/cogni/pull/2772)). The 25% recovery floor is self-imposed.
- **Alerts route to a null receiver** (memory alerts firing on all three VMs; production disk 14% free and fell from 25% in 24h through incident leftovers). Tracked in [story.5091](https://cognidao.org/work/items/story.5091), with the design in hub inbox `contrib-flock-leader-conductor-5d6596b2` (alerts → agent work items, **never email**).
- Agents the CEO runs: **substrate-dev** (story.5085), **poly-ops** (bug.5477 / #2775), **fleet-safety** (story.5091 + disk cleanup), **red-agent** (sandbox).
- Awaiting CEO merge: hub inboxes `contrib-flock-leader-conductor-68dc1969` (sovereign `external` tier, [task.5259](https://cognidao.org/work/items/task.5259)) and `…-5d6596b2` (agent loop).

## Design / Implementation Target

1. **No locks.** Remove NOLOGIN containment and the human readmit from the design and code path. A noisy tenant must degrade only itself through native platform bounds, never through a kill switch.
2. **Efficiency is a hard constraint.** Keep a shared Postgres tier for small nodes. Dedicated cells are only for measured outliers (graduation), never the default.
3. Recall-first: research how mature multi-tenant Postgres platforms bound tenants without killing them, then compare against what `provision.sh` already sets (connection caps, timeouts, temp limits). Record the comparison in the hub (refine the existing entry; don't add one).
4. One design, two hub entries (agent text + human `html` visual), then one CEO decision. Persist Goal/Done-when in story.5085 only after approval.
5. Must not regress: Poly's dedicated cell, production firewall allowlist (#2775), the bug.5299 residency CI guard, or the exact-SHA fleet proof.

## Next Actions / Risks

- [ ] Re-verify all of Current State (`/version`, deep readyz, story.5085 ledger tail, #2775 state) before saying anything.
- [ ] Draft the no-lock shared-tier design; get the CEO's one yes/no on it and the reworded Done-when.
- [ ] Steer substrate-dev: build "agents may unlock" for candidate/preview, unlock, remove auto-lock, run the candidate load test under bounds.
- [ ] Track #2775 → merge; fleet-safety → disk cleanup + story.5091.
- **CEO comms:** reads only the Bottom line (≤20 words, plain words, no jargon like "fence"). Give copy/paste messages only for the real agents listed above, each with a work-item link. AI-run org is the north star, so never route anything to human email.
- **Worktree hazard:** sibling agents switch branches in the shared `harrisburg` worktree; three of my commits landed on `agent/task5247-scheduler-main` (re-applied here). Use your own worktree.
- Gotchas: Grafana is `https://derekg1729.grafana.net`. Akash app logs are `{source="lease", node="<uuid>"}` (Poly = `4b06359a-…`), not `node="poly"`. The readmit route accepts only a browser session, not bearer keys.
