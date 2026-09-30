---
id: story.5050.handoff
type: handoff
work_item_id: story.5050
status: active
created: 2026-09-30
updated: 2026-09-30
branch: derekg1729/region-verb-idempotency
last_commit: 5f42226d4b
---

# Handoff: Get poly serving from a Polymarket-permitted region

## Mission

Pickup: you own getting **poly's production workload out of Belgium and serving from a permitted
jurisdiction**, and keeping the self-serve region control safe for every other node. poly's entire
copy-trade product has been dead since go-live — 100% of its CLOB orders are refused
`403 "Trading restricted in your region"` — because its Akash lease sits on a Belgian provider and
Belgium is on Polymarket's regulatory close-only list, enforced on the **API**, not just the
frontend (bug.5270). Nothing in poly's code is wrong. Only the operator can mint an Akash lease, so
poly cannot fix this themselves; they have been blocked on us. The platform capability now exists
and is live in production. What remains is finishing one cutover and closing the money it displaced.

## Goal

- poly production serves from a provider in a Polymarket-permitted country, and a real CLOB order
  returns non-403.
- Any node can choose its own jurisdiction through a repeatable verb — never a hand-edited catalog.
- **E2E validation signal**, in order:
  1. `curl -s https://poly.cognidao.org/version` advances off `b51b840c` to the promoted sha.
  2. From **inside the pod**: `curl -s https://polymarket.com/api/geoblock` → `{"blocked":false,…}`.
     This is the only thing that *measures* egress; country selection merely narrows the pool.
  3. One poly CLOB order accepted (no 403) and a row in `poly_copy_trade_fills` — the bug.5270
     outcome.
- Deploy proof for operator changes: flight through `POST /api/v1/vcs/flight`, confirm
  `https://test.cognidao.org/version` `.buildSha` equals the PR head sha, then merge via
  `POST /api/v1/vcs/merge` and promote with `POST /api/v1/deploy/promote`.

## Start By Reading

- Hub `node-choose-placement-region` — node-facing guide for the region verb (merged, main).
- Hub `operator-infra-logs-read` — how to read operator-internal infra in Loki. **`service` is the
  CONTAINER name**: Crossplane's decisions are `service="package-runtime"`, not `"crossplane"`.
- Hub `akash-egress-jurisdiction-gate` — why advertised/ingress country ≠ egress identity.
- `nodes/operator/app/src/app/api/v1/nodes/[id]/envs/route.ts` — the three mutually-exclusive verbs
  (`present` | `placement` | `countries`).
- `nodes/operator/app/src/shared/node-app-scaffold/gens/env-membership-plan.ts` → `buildRegionPlan`.
- `nodes/operator/app/src/adapters/server/compute/akash-provider-screen.ts` → `screenBids`
  (`REQUIRED_FAILS_CLOSED`, per-reason rejection counts).
- `nodes/operator/app/src/adapters/server/compute/safe-version-probe.ts` → `safeHostRoutedVersionProbe`.
- `infra/crossplane/xcomputeworkload/composition.yaml` lines ~261 (`expose.accept`) and ~570
  (`PROVE_BEFORE_TRAFFIC` DNS latch).

## Current State

**Shipped and live on production (`1df0086bbf`)**

- #2488 placement capability: `required_placement_countries.<env>` hard-filters bids, fail-closed,
  with per-reason rejection accounting.
- #2495 permitted provider pool (PT/BG/CH/FI/NL) + their egress CIDRs.
- #2494 the region verb: `POST /api/v1/nodes/{id}/envs {env, countries:[…]}` — authors a reviewed
  catalog PR, moves `lease_generation` (placement binds only on a fresh mint), returns
  `displacedLeases`.

**Proven in production**

- The filter works: poly gen-6 minted under `[BG,CH,FI,NL,PT]` and Belgium was excluded.
- An earlier one-country attempt produced
  `[refused: not_allowlisted=5, required_country=1]` — the filter behaving correctly while nothing
  could win. A single-country set is a single point of failure; **always pass a set**.

**Blocked on**

- **bug.5325 (P0)** — poly gen-6 landed on DSTM Zürich, which took the lease and **never created a
  vhost for `poly.cognidao.org`**. Measured: `Host: poly.cognidao.org` → **404 nginx** on
  `84.234.20.39`, while the incumbent BE provider returns 200. The host-routed boot probe therefore
  returns `serving:false` forever, the DNS latch never flips, and the edge stays on Belgium. The gate
  is **correct** — `safe-version-probe.ts` resolves the lease's own address and overrides only
  Host/SNI, so it is DNS-independent. The provider is defective.
- **Mitigation already applied**: poly re-minted on `[PT,BG,FI,NL]` (CH dropped) →
  **PR #2500**, `lease_generation: 7`. Awaiting merge + promote.
- **PR #2497** — region-verb idempotency fix, in the merge queue. Until it lands, a repeat call with
  unchanged countries still bumps the generation and **mints a paid lease**.

**Open bugs filed**: bug.5322 (generation bump vs. incumbent lease), bug.5323 (refused mint invisible
to CI and unreadable by the node), bug.5324 (DB recovery makes `leases: []` mean "couldn't tell"),
bug.5325 (provider ignores `expose.accept`), bug.5319 (candidate-a GitHub App reconcile loop).

**Money owed** — poly production has three displaced receipts still `allocated`:
gen-4 `398af0c0`, gen-5 `3543bf63`, gen-6 `43cda287` (the dead Swiss one). They bill until closed.

## Design / Implementation Target

1. poly production serves from a permitted-country provider and its CLOB stops returning 403.
2. The region verb stays **idempotent**: an unchanged request must return `no_changes` and must not
   move `lease_generation`. A no-op that bumps mints a paid lease.
3. `REQUIRED_FAILS_CLOSED` must hold — an unknown or unreadable provider country refuses the bid.
   This deliberately inverts the neighbouring `FAIL_OPEN_ON_MISSING_METADATA` preference rule.
4. `CATALOG_IS_SSOT` — placement is only ever changed by a reviewed catalog commit the verb authors.
   Never hand-edit `infra/catalog/*.yaml` to move a region.
5. A provider that wins a bid but does not honour `expose.accept` must be struck and its lease closed
   with a named terminal cause, not left blocking the cutover while billing (bug.5325).
6. Must not regress: `ONE_WALLET_ONE_ACTIVE_WRITER`. Lease minting happens **only** in the
   `akash-tx-actuator` via Crossplane. No CI job or script may call a mint verb — verified, and the
   boundary currently holds.
7. Never describe country selection as proof of egress. It narrows the pool; only the workload's own
   outbound probe proves reachability.

## Next Actions / Risks

- [ ] Merge **#2500** and promote poly; watch for a permitted provider winning (PT digital frontier
      is the strongest candidate: 62 active leases, 610 vCPU free).
- [ ] Confirm the new lease actually serves the custom host **before** trusting the cutover:
      `curl -H 'Host: poly.cognidao.org' http://<provider-ip>/version`. If 404, it is bug.5325 again
      — strike that provider and re-mint.
- [ ] Merge **#2497** before telling any node to call the verb repeatedly.
- [ ] Close the three displaced poly leases. Verify per-DSEQ **on chain**, not from the ledger:
      `api.akashnet.net/akash/deployment/v1beta4/deployments/info?id.owner=akash10auj…&id.dseq=<dseq>`.
- [ ] Consider removing DSTM CH from `AKASH_ALLOWED_PROVIDERS` until re-proven.

**Gotchas that cost hours**

- `receipt state ≠ liveness` — a receipt can read `allocated` for a deployment the chain calls
  `closed`. Trust the chain for money.
- An **actuator-first rollout is mandatory**: a Composition that speaks a protocol the deployed
  actuator does not understand is rejected at the zod `strictObject` boundary **before any log line**,
  and Crossplane retries silently every 60s. This looked like a stuck CREATE for ~20 minutes.
- `"request sent"` with no paired outcome line is the worst observability shape — it hid exactly that
  rejection. Read the effect (ledger row, chain state), not the attempt.
- The single candidate-a flight slot is contended (bug.5289); flights get evicted and need re-dispatch.
- `gh pr checks --watch` can exit 0 before all workflows attach. Always re-read after it returns.
