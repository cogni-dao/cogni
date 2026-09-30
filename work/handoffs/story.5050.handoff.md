---
id: story.5050.handoff
type: handoff
work_item_id: story.5050
status: active
created: 2026-09-30
updated: 2026-09-30
branch: derekg1729/auto-lease-recovery
last_commit: 6e6b424bf6
---

# Handoff: Get poly serving from a Polymarket-permitted region

## Mission

Pickup: you own **poly production serving from a permitted jurisdiction**, and you own it as a
platform problem, not a node problem. poly's copy-trade product has been dead since go-live —
100% of CLOB orders refused `403 "Trading restricted in your region"` — because its Akash lease
sits on a Belgian provider and Belgium is on Polymarket's regulatory close-only list, enforced on
the **API** (bug.5270). Nothing in poly's code is wrong. Only the operator can mint a lease, so
poly cannot fix this themselves.

The region-control capability is **built, live, and proven**. What remains is a **provider-quality
search**: of the two providers ever actually tested, one honours the workload's declared custom
hostname and one does not. Your job is to finish the search — and if it exhausts, to change the
design so the search is unnecessary.

## Goal

- poly production serves from a permitted-country provider and a real CLOB order returns non-403.
- A defective provider costs the platform an automatic retry, **never a human cycle**.
- **E2E validation signal**, in order:
  1. Auction result: read the screening line —
     `scripts/loki-query.sh '{env="production",service="actuator"} |~ "4b06359a"' 60 60`.
     `[refused: not_allowlisted=N, required_country=M]` names which gate rejected each bid.
  2. **Before trusting DNS**, probe the winner directly:
     `curl -H 'Host: poly.cognidao.org' http://<provider-ip>/version` must return the **exact**
     source sha. A 404 is bug.5325 — the provider took the lease and never created the vhost.
  3. From **inside the pod**: poly's `/api/internal/ops/poly/egress-check` → `blocked:false`.
     Country selection narrows the pool; only this measures egress.
  4. `curl -s https://poly.cognidao.org/version` advances off `b51b840c`.
  5. One CLOB order accepted and a row in `poly_copy_trade_fills`.
- Operator changes: flight via `POST /api/v1/vcs/flight`, confirm `test.cognidao.org/version`
  equals the PR head sha, merge via `POST /api/v1/vcs/merge`, promote via
  `POST /api/v1/deploy/promote`.

## Start By Reading

- Hub `node-choose-placement-region` — the node-facing verb, and the **two-gate trap**: a bid must
  pass BOTH `AKASH_ALLOWED_PROVIDERS` (operator) and `required_placement_countries` (node).
  Widening one admits nobody. This has now bitten twice.
- Hub `operator-infra-logs-read` — `service` is the **container** name. Crossplane's decisions are
  `service="package-runtime"`, never `service="crossplane"` (which exists and is silent).
- Hub `akash-egress-jurisdiction-gate` — advertised/ingress country is not proven to equal egress.
- `nodes/operator/app/src/features/compute/node-boot-recovery.ts` —
  `CONSTRAINED_PLACEMENT_IMPLIES_AUTO_SEARCH`.
- `nodes/operator/app/src/features/compute/compute-workload-manifest.ts` →
  `bootPolicyForEnvironment` (one cell derives both gates).
- `nodes/operator/app/src/adapters/server/compute/akash-provider-screen.ts` → `screenBids`.
- `infra/crossplane/xcomputeworkload/composition.yaml` — `:recover:<n>` path (~line 444),
  `PROVE_BEFORE_TRAFFIC` DNS latch (~line 570), `expose.accept` lowering (~line 261).

## Current State

**Live in production and proven**

- Region filter hard-refuses out-of-set bids, fail-closed, with per-reason rejection accounting —
  the only reason any of this was diagnosable.
- The env-manager region verb: `POST /api/v1/nodes/{id}/envs {env, countries:[…]}` authors a
  reviewed catalog PR, moves `lease_generation`, returns `displacedLeases`. Idempotent (a
  no-op used to mint a paid lease — fixed).
- 11 permitted providers allowlisted; poly declares its own egress CIDRs.

**In the merge queue right now**

- **#2516** — poly countries `[BG, FI, NL, PT, RO]`, gen-15. **RO is the point**: Froggy RO bid in
  every one of eight auctions and we rejected it ourselves as `not_allowlisted`.
- **#2515** — auto-recovery. XRD `onGiveUp` widened `[Hold]` → `[Hold, Replace]`; the prerequisite
  (task.5153 actuator-owned strikes) had shipped long before and **nobody opened the gate**. Plus
  `boot_recovery.<env>` deriving BOTH `onDeadline` and `onGiveUp`, and **derived as `auto` for any
  row with a placement requirement** — so poly needs no third change. Auto-queues when CI attaches
  (`/tmp/q2515.log`).

**The open question that decides the strategy**

Eight auctions produced the same shape: `not_allowlisted=4–5, required_country=1–2`. The four
permitted providers we allowlisted first (PT/BG/FI/NL) **have never bid**, despite being online
with spare capacity. The only permitted provider that bids is DSTM CH — which wins on price (6.0
vs 9–18) and then **404s on `expose.accept`** (bug.5325). n=2 on host-route support: ZenCloud BE
works, DSTM CH does not.

**Money: clean.** Chain-audited every poly production dseq: 9 of 10 `closed`, only gen-5 (the
Belgian incumbent) `active`. The ledger shows 10 `allocated` — `receipt state is not liveness`
(bug.5324 is understated; trust the chain).

**Open bugs**: bug.5325 (provider ignores `expose.accept`, holds and bills), bug.5322 (generation
bump vs. incumbent), bug.5323 (refused mint invisible to CI and unreadable by the node), bug.5324
(ledger read failure looks like `leases: []`), bug.5319 (candidate-a GitHub App reconcile loop).

## Design / Implementation Target

1. poly production serves from a permitted-country provider; a CLOB order returns non-403.
2. A provider that wins a bid and fails to serve is **closed, struck, and replaced automatically**,
   bounded at 3 attempts per generation. Exhaustion parks for a human — never an unbounded paid
   retry loop.
3. `HOLD_IS_DEFAULT` for every row without a placement requirement. Admitting `Replace` must change
   no existing lane.
4. `onDeadline` and `onGiveUp` are never separately settable. `Replace` + `Hold` holds a dead lease
   while advertising self-healing; `Close` without `Replace` discards it silently.
5. `CATALOG_IS_SSOT` — placement changes only through the verb's reviewed commit. Never hand-edit
   `infra/catalog/*.yaml`. Boot posture is **derived**, not a second knob a node can forget.
6. `ONE_WALLET_ONE_ACTIVE_WRITER` must not regress. Minting happens only in the `akash-tx-actuator`
   via Crossplane; no CI job may call a mint verb. Verified — `node-substrate` only provisions
   substrate (DB, secrets, edge), it does not mint.
7. Country selection is a pool narrower, never proof of egress.

## Next Actions / Risks

- [ ] Confirm #2516 and #2515 both reach **MERGED** (the queue drops PRs silently), then promote
      operator, then promote poly. One auction now searches 3 providers instead of 1.
- [ ] Read the screening line. If a provider wins, **probe `Host:` before trusting DNS** (step 2
      above) — that check is the difference between a cutover and another overnight stall.
- [ ] **If the auction exhausts all three, STOP re-minting and spike this instead:** CNAME
      `poly.cognidao.org` at the lease's **provider-assigned** ingress hostname rather than
      requiring the provider to serve our custom host. The bare-ingress probe already succeeds
      against it. That deletes bug.5325 entirely, widens the usable pool from ~10 to all 16
      permitted-and-healthy providers, and removes the host-routed boot check's whole failure mode.
      **This is the only move that changes the odds instead of re-rolling them.**
- [ ] Froggy RO has a 3/3 failure record in `akash-provider-quality-mandate`. If those strikes are
      in `compute_provider_outcomes` it is permanently blacklisted and will be refused — invisible,
      because `not_allowlisted` is counted before `blacklisted` in the rejection order. Auto-recovery
      walking to the next provider is the mitigation.
- [ ] Only ~6 independent failure domains exist, not 11: three providers are one operator
      (`digital frontier` PT/BG/FI) and three are Ukrainian. Do not call single-provider risk closed.

**Gotchas that cost hours**

- **Actuator-first rollout is mandatory.** A Composition speaking a protocol the deployed actuator
  does not know is rejected at the zod `strictObject` boundary **before any log line**, and
  Crossplane retries silently every 60s. Looked like a stuck CREATE for 20 minutes.
- **An attempt logged without an outcome is worse than silence.** provider-http logs
  `http request sent` and never the response; that hid a rejected paid CREATE behind a retry loop.
  Read the effect (ledger row, chain state), not the attempt.
- **Price is the final tiebreak** and the only reliability input above it is a *boolean*
  "has ≥1 prior success" — which is why a broken provider at 6.0 beat a working one at 9.34 seven
  times. A bid well below the others is a signal, not a bargain.
- **Run `biome check` repo-wide**, not on `src/` + `tests/` — `scripts/` bit me in CI.
- `gh pr checks --watch` can exit 0 before all workflows attach. Always re-read after it returns.
- The single candidate-a flight slot is contended (bug.5289); flights get evicted, re-dispatch.
