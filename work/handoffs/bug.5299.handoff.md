---
id: "bug.5299.handoff"
type: handoff
work_item_id: "bug.5299"
status: active
created: 2026-10-14
updated: 2026-10-14
branch: "flock-leader/db-env-failure-domain"
last_commit: "a1e992e675"
---

# Handoff: non-production lanes must stop using production's database

## Mission

Pickup: you own getting four non-production lane databases off the production Postgres
instance. Every Akash node's `candidate-a` and `preview` database currently lives on the
production server because `lane-is-not-control` assigns "Postgres host" to the control env
and `FLEET_CONTROL_ENV` defaults to `production`. Measured over 7 days, 31 of ~78 peak
backends on the production instance are non-production lanes (~40%); `poly` alone is 27 of
them. This already cost one fleet-wide outage: on 2026-09-24 the shared postmaster emitted
three `57P02 crash_shutdown` windows and one abnormal backend death removed operator
readiness, OpenFGA and LiteLLM persistence, and every node database at once.

**The plumbing is landed and switched off. Zero databases have moved.** Read the
`## I OVER-BUILT THIS` section of the work item first — the previous owner (me) designed a
general fleet-wide automation for what is a four-lane problem, three of whose lanes belong
to `task.5246`'s already-planned cutover. The plan has been shrunk; do not re-expand it.

## Goal

- No database on the production Postgres serves a non-production lane.
- `LANE_DB_RESIDENCY_PINNED` in `scripts/ci/lib/lane-db-residency.sh` is **empty**. That is
  the acceptance proof — each line deleted is one lane moved.
- E2E validation, per lane: `max by(datname)(pg_stat_database_numbackends{env="production"})`
  shows **zero** backends for that lane's database over 24h, and **non-zero** for it on its
  own env's instance.
- Candidate-a flight proof for any code change here: `assert-substrate (operator)` success,
  the verbatim `[OK] lane database residency: operator/candidate-a is reconciled by its own
env (candidate-a)` line in the run log, `verify-candidate (candidate-a, operator)` success,
  and `curl https://test.cognidao.org/version` returning a `buildSha` **exactly** equal to
  your head SHA. A deployed SHA that is not your head is not proof.

## Start By Reading

- `GET https://cognidao.org/api/v1/work/items/bug.5299` — the `summary` is a deliberate
  START HERE map; the `outcome` is ~156k chars of design history. Read the summary, then only
  the outcome sections the summary points you at.
- `work/reviews/bug-5299-db-residency.review.md` (this branch) — the first independent review.
- Hub: `noisy-neighbor-database-architecture` (the two-tier tier policy — governs tier, not
  residency), `lane-is-not-control` (the custody rule that causes this),
  `lane-db-two-derivations` (one lane-aware derivation, both sides, plus an equality gate),
  `control-plane-self-starvation` (the 2026-09-24 crash domain).
- `scripts/ci/lib/lane-db-residency.sh` — `lane_db_vm_env` (the one cell),
  `lane_db_host`, `lane_db_dsn_host`, `lane_db_assert_agreement`, `LANE_DB_RESIDENCY_PINNED`.
- `scripts/setup/lib/reconcile-secrets.sh` — `_compose_node_value` and `_doltgres_db_suffix`.
- `scripts/ci/run-node-substrate.sh:201-218` and `scripts/ci/reconcile-node-substrate.sh:230,
:631-635, :645-647` — where B2a and B2b live.
- `docs/spec/node-ci-cd-contract.md` § "Lane vs control env" — the contract cell under revision.

## Current State

Merged to `main`, all **inert** (every lane still resolves to the host it always used):

- `47c340162e` (#2731) — the residency gate, the four-lane pin ledger, and a shell test
  registered in `run-shell-tests.sh`. Proven live on candidate-a at exact head SHA.
- `68daac4ee0` (#2733) — the resolver trio. 13/13 catalog pairs byte-identical.
- `f334447e5e` (#2737) — the composed DSN host wired to the resolver. 39 DSN values
  byte-identical across four baselines; live `created=0 unchanged=33` on candidate-a.

Also done: six orphan databases dropped over SSH with `pg_dump` rollback artifacts retained
at `/backups/orphan-prune/` on each VM; proven unrecreatable (no catalog row, and
`node_database_csv` is laneless so it cannot emit a suffixed name). Prometheus series 48 → 42.

Not done: **no lane has moved.** `cogni_poly_candidate_a` (4 live backends),
`cogni_red_candidate_a` (1), `cogni_poly_preview` (0), `cogni_toks5_preview` (0) are all
still on the production instance.

This branch (`flock-leader/db-env-failure-domain`) holds only the contract annotation and the
review record; PR #2724 is open and unmerged. PR #2738 was closed — a .md-only PR is an
anti-pattern here, the content belongs in the hub.

Open hub contribution (unmerged, needs a human): `contrib-flock-leader-conductor-9adc844a`,
entry `db-residency-follows-lane`, extending `noisy-neighbor-database-architecture`. It is
stale relative to the work item — amend it before merging it.

**Blocked and NOT yours to guess at:** `bug.5417` and `bug.5420` are shipped and merged but
stuck at `needs_triage`. `PATCH /work/items/{id}` returns `403 authz_denied` with both
`$COGNI_NODE_API_KEY` and `$COGNI_API_KEY_PROD`, while `bug.5299` patches fine with the same
key. The API exposes no `owner`/`createdBy` to explain the difference, so my earlier
"author-scoped, key rotated" explanation is a guess the evidence contradicts. Treat it as an
unexplained authz asymmetry worth its own item, not as a thing you lack permission for.

## Design / Implementation Target

1. **Cede poly's three lanes to `task.5246`.** It already dump-restores poly into dedicated
   per-env state cells with its own cutover, rollback and DSN-rotation primitive. Making
   those cells env-resident is one argument to a move already happening. That is 27 of the 31
   misresident backends with zero new mechanism. Do **not** run a second cutover against the
   production instance in the same window.
2. **Fix B2a before any unpin. It is the fatal one.**
   `run-node-substrate.sh:201-218` passes the control env's `VM_HOST`, never re-resolved
   (`:173`). After an unpin, `node_db` collapses at `:230` and db-provision runs at `:631-635`
   **on production's VM**, `ALTER`ing production's live `app_poly`/`service_poly` (21 peak
   backends) to candidate-a's password. It fires on the next **production promote**, not on
   the unpin's own flight — so it will look unrelated when it happens.
3. **Fix B2b before any unpin.** `reconcile-node-substrate.sh:645-647` feeds the **Postgres**
   name to `doltgres-provision`, which runs `dolt_commit('-Am')` at `provision.sh:88`. Post-unpin
   that stage-all-commits production's live `knowledge_poly`. Doltgres residency is explicitly
   out of scope — its superuser is immutable per `databases.md §5.2` — so this is a guard, not
   a migration.
4. **Move the two lanes you own by hand, not by automation.** `red/candidate-a` (1 backend) and
   `toks5/preview` (0) are non-production and rebuildable: create the database empty on the
   lane's own instance, re-run migrations, delete that lane's line from
   `LANE_DB_RESIDENCY_PINNED`, verify, then drop the source. No dump/restore, no credential
   carrier, no drift detector, no egress rule — an empty recreate on the lane's own instance
   needs none of them.
5. **Boundaries that must hold.** Reconciliation and payment authority stay with the control
   env; only the database server follows the lane. Down-trust only — a lane must never read the
   production vault (`run-node-substrate.sh:85-92` rejects it). Never `ALTER ... PASSWORD` on a
   role something is connected to. Keep `lane_db_suffix` and `_doltgres_db_suffix`: rollback
   needs the name, and sharing one suffix between the two planes would point a lane at the
   control env's live `knowledge_<node>`.
6. **Must not regress.** `COGNI_NODE_DBS` / `node_database_csv` stay untouched — narrowing them
   shrinks the Doltgres roster (`doltgres-init/provision.sh:70`) and prunes live Grafana
   datasources. `docs/spec/databases.md` and `docs/spec/multi-node-tenancy.md` belong to
   `task.5246` under `SPECS_FOLLOW_THE_DECISION`.

## Next Actions / Risks

- [ ] Hand poly's three lanes to `task.5246`; confirm its cutover takes env-residency as an input.
- [ ] Land B2a and B2b inert, with tests, flighted and proven on candidate-a.
- [ ] Move `toks5/preview` first — zero backends, smallest possible blast radius.
- [ ] Then `red/candidate-a`. Delete one pin line per lane; an empty ledger closes this item.
- [ ] Amend the hub contribution to the post-B1 design, then ask a human to merge it. Never
      merge your own contribution.

Gotchas that cost real time:

- **Wait for `build (<node>)` to pass before dispatching any flight**, including scripts-only
  ones. A flight dispatched early silently pins a _fallback_ image (`Promoted apps: none`) and
  `verify-buildsha` then compares against a stale `.promote-state/source-sha-by-app.json`. In
  the logs this is indistinguishable from a real verify failure. This cost one red flight.
- Working fleet SSH keys are **not** in `~/.ssh` — all nine there are rejected on all three
  hosts (pre-August-reprovision). They are the provision custody artifacts in the **main
  clone** at `.local/provision-creds/<env>/<env>-vm-key`. Hosts: `cogni.vm.cognidao.org`,
  `cogni-candidate-a.vm.cognidao.org`, `cogni-preview.vm.cognidao.org`.
- `.env.deployments` in this worktree holds **dead-stale IPs**. Querying them manufactures a
  false "VM is down" finding.
- `$GRAFANA_URL` carries a trailing slash; the datasource proxy 404s on the resulting
  `//api/...`. Strip it.
- `docker compose exec -T` swallows the **caller's** stdin, so a loop driving `psql` over SSH
  exits silently after one iteration. Redirect `</dev/null` on every call.
- Three designs, three independent reviews, three would-be production incidents prevented
  before any code: an `ALTER` on a live `app_poly` role, a cross-fleet firewall widening from a
  defaulted `FORK_DOMAIN_ROOT`, and a gate that failed open in its own hazard case. **Do not
  skip the design-then-independent-review step on B2a or B2b.**
- The counter-lesson, which matters just as much: each of those design passes also _grew_ the
  plan (3 gates → 7). Review before touching production credentials; do not review your way
  into a fleet-wide automation for a two-lane job.
