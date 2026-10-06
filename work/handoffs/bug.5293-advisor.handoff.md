---
id: bug.5293-advisor.handoff
type: handoff
work_item_id: bug.5293
status: active
created: 2026-10-01
updated: 2026-10-01
branch: derekg1729/bug5293-handoff
last_commit: 36d4fee8a7
---

# Handoff: bug.5293 ADVISOR session (NOT the incident owner)

> This is the **advisor** handoff. It does NOT replace the incident owner's live
> briefing at `work/handoffs/bug.5293.handoff.md`, which is maintained by session
> `da-nang-v2-3f` in this same worktree. Do not clobber that file.

## Mission

Pickup: you are a **read-only advisor to Derek**, not the prod-write owner of bug.5293.
Your job is to give Derek honest, correctly-formatted status across the sessions working
this incident — not to touch prod. The prior advisor (this session) was dismissed for
repeated communication failures: reporting poly "down" when its front door was serving,
and drifting off the one accepted status format. Fix that first.

## Goal

- Derek always gets the truth about poly/Postgres in the **orientation scorecard format
  only** (`## 🎯 goal` + `done =` + `followed:` + 3-col table + `conf`/`ask`). No other
  shape. See `~/.claude/skills/tldr/` and the operator session-start orientation.
- "Serving" is judged by what a user sees, not one endpoint: report `/`, `/version`,
  and `/readyz` together. Never collapse them into a single "up/down" word.
- E2E incident signal (owned by `da-nang-v2-3f`, not you): `poly.cognidao.org/version`
  = `9033a162...` + `/readyz` = 200 + a FI/NL/PT lease won + Postgres exit-2 ≤9/24h.

## Start By Reading

- `work/handoffs/bug.5293.handoff.md` — the OWNER's live incident briefing (source of truth).
- `.context/bug5293-production-writes.md` — live prod-write ledger (W1–W7) + rollbacks.
- `~/.claude/skills/tldr/SKILL.md` — the ONLY accepted Derek comms format.
- `.claude/skills/akash-node-expert/SKILL.md` — why the auction, not the DB, blocks the
  deploy; `required_country=N` is NOT proof of the binding gate (first-match-wins).

## Current State

Verified live by the advisor at ~23:30Z 2026-10-01:

- **poly `/` = 200** (front door serves the STALE build `eed16dc0...`).
- **poly `/version` = `eed16dc0...`** — NOT the fix SHA `9033a162...`.
- **poly `/readyz` = 000** (health probe dead/timeout).
- → Correct phrasing: **"serving, but stale and health-degraded,"** not "down."
- Accepted fix SHA is `9033a162...` on main; XR is gen-21 `phase=Failed / BootDeadlineClosed`.
- gen-22 does NOT exist. PR #2551 (would widen to BG) was CLOSED unmerged — BG is a
  documented dead-end; main is clean at gen-21/[FI,NL,PT].
- gen-21 auction: 6 bids, 0 from FI/NL/PT, refused 4× not_allowlisted + 2× required_country
  (CH, RO). CH is inert for a publicHost node. Roster is NOT sufficient to conclude
  supply-vs-screening.
- **Market probe: Derek AUTHORIZED it; relayed to `da-nang-v2-3f` to run** (read-only,
  `AKASH_PROBE_CONSOLE_API_KEY`, dev wallet, DELETE after). Result still pending.
- Postgres: 1 exit-2 in a 45m window (not 0); mechanism still unexplained; W7 caps live but
  undeclared; `san-jose-98` landing them declaratively in provision.sh.

Session topology (all on this machine):

| session         | lane                                                                               | prod-write? |
| --------------- | ---------------------------------------------------------------------------------- | ----------- |
| `da-nang-v2-3f` | incident OWNER — Postgres reliability + poly lease/promote                         | yes         |
| `san-jose-98`   | make emergency caps declarative (provision.sh), drift gate, metrics, restore drill | no          |
| `zurich-v1-77`  | story.5056 node→node billing wallets (unrelated)                                   | no          |
| `lagos-31`      | poly-side prune-DELETE root cause (poly PRs)                                       | read-only   |

## Design / Implementation Target

1. Every Derek-facing reply uses the orientation scorecard format — nothing else.
2. Advisor stays read-only: no prod writes, no merges, no promotes. Route actions to the
   owner via SendMessage; relay Derek's explicit decisions (e.g. "run the probe").
3. Report poly as three endpoints, never one word. "Serving-but-stale" ≠ "down" ≠ "healthy."
4. Do not overwrite the owner's `bug.5293.handoff.md`; this worktree is shared.
5. Do not re-litigate the Akash design in a status reply; the lease-per-deploy /
   re-auction-is-a-lottery finding is real but belongs in a follow-up work item, not a scorecard.

## Next Actions / Risks

- [ ] Get the probe result from `da-nang-v2-3f`; report supply-vs-screening to Derek in format.
- [ ] If screening: owner fixes the allowlist/screen + re-promotes `9033a162`.
- [ ] If thin supply: this is Derek's country-set call — surface as one binary y/n.
- [ ] Track Postgres 1h exit-2 window; `8s bound` is not yet proven as the fix.
- Risk: trusting `/readyz` alone manufactured a false "down" and cost trust — always triangulate.
- Risk: relaying between owner and `san-jose-98` is redundant; they talk directly now.

## Pointers

| File / Resource                               | Why it matters                            |
| --------------------------------------------- | ----------------------------------------- |
| `work/handoffs/bug.5293.handoff.md`           | Owner's live incident briefing (SSoT)     |
| `.context/bug5293-production-writes.md`       | W1–W7 prod-write ledger + rollbacks       |
| `~/.claude/skills/tldr/SKILL.md`              | The only accepted Derek comms format      |
| `.claude/skills/akash-node-expert/SKILL.md`   | Auction/lease canon; probe-before-auction |
| `https://poly.cognidao.org/{,version,readyz}` | Live truth — read all three               |
