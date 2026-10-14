# Copy/paste to the story.5085 developer — strategy update, plan impact

---

The CEO just set the hosting-economics north star; review two inbox contributions before your next push:

1. **NEW — [node-hosting-economics](https://cognidao.org/knowledge/inbox/contrib-flock-leader-conductor-d59ddc7e)** (strategy): operator sponsorship is a bounded free tier; dead inactive nodes get purged; heavy consumers are fully supported but **pay** `provider cost rate × (1 + operator margin)` in USDC. The graduation boundary is the billing boundary. **Poly is the first paying tenant** — its dedicated cells are metered paid capacity funded from Poly's treasury, not sponsored hardware.
2. **Still open — [v1 containment refinement](https://cognidao.org/knowledge/inbox/contrib-flock-leader-conductor-6b555902)** awaiting the CEO merge click.

**Does this change your plan? Direction: no — it reinforces it.** The state-cell work you're shipping is simultaneously the metering-and-billing substrate. Three concrete adjustments, none of which blocks the 2-hour window:

- **(a) Cost metadata, not billing.** Record the per-cell provider cost rate (VM + volume price) on the cell record or catalog row at provision time, so the invoice later is a multiplication. Do NOT build billing now — file one follow-up task referencing `node-hosting-economics` and `GET /compute/balances`.
- **(b) Size Poly's cells to the declared budget profile — smallest viable.** This is paid capacity, not a free upgrade; a generous free island for the node that took the fleet down is exactly what the CEO is vetoing. Put the monthly cost figure in the cutover scorecard so the CEO sees the invoice-shaped number before Poly is enabled.
- **(c) Containment/status work (task.5247) is unchanged.**

Expert notes for the sprint window (~2 hours, CEO's clock):

- Deliver in this order: CEO "A" confirmation → flight + solo-validate PR #2730 at its exact current head (claims at superseded heads don't count) → operator merge → provision the Poly **candidate** cell + pgbench replay. Prod cutover only if time genuinely remains; an honest "candidate proven, prod cutover next session" beats a rushed prod data move.
- Poly restoration to **shared** tier is not an acceptable shortcut — graduation is sticky and the CEO has now attached money to that boundary.

---

## Addendum — node-genericity audit (CEO core invariant)

The CEO's invariant — no bespoke callouts to any particular node in platform code — is now also codified in the strategy entry as `NODE_IDENTITY_IS_DATA_NOT_CODE`. I grepped both PR diffs for node-specific references in runtime code. Verdict: **runtime code is clean** (all `Poly*` hits in adapters/ports are the PolyForm license header). Three genericity fixes required before merge:

1. **Rename `poly-dedicated-v1` in `infra/database-budget-profiles.yaml`** to a node-neutral name (e.g. `dedicated-small-v1`); `infra/catalog/poly.yaml` references it. Profiles are shared vocabulary — a node name inside one bakes identity into reusable config.
2. **Parameterize the replay tooling**: `scripts/ops/poly-dedicated-cell-replay.sql` + `replay-poly-dedicated-cell.sh` → `replay-dedicated-cell.sh <node-slug>`. Every future graduated tenant runs this same proof; it must not be node-named.
3. Cosmetic: the doc comment in `database-containment.port.ts` ("distinguishes Poly's dedicated cell") → genericize to "a node's dedicated cell".

Node identity may appear ONLY in `infra/catalog/<node>.yaml` rows and billing/evidence records. Anything else is a review-blocking defect from now on.

## Addendum 2 — priority + billing honesty (CEO)

**Core priority: ALL nodes back online, including Poly, ASAP. Economics never blocks restoration by a minute.** The strategy's v0 is meter-and-accrue only: record the cell's provider cost rate at provision and accrue usage from enable. Per-node billing settlement is in-progress elsewhere (`node-payer-account-keystone`: billing_accounts can carry non-human spend; per-node account + cost-as-debit are NOT built) — do not build or wait on any of it. Restore first; the meter starts at enable; the invoice follows the rail.
