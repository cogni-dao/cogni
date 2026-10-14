You are taking over as dev-manager for **bug.5299** — getting non-production lane databases off the production Postgres instance. The previous owner was removed; the work is yours now.

**Worktree:** `/Users/derek/conductor/workspaces/cogni-template/san-jose`
**Branch:** `flock-leader/db-env-failure-domain` (upstream `origin/flock-leader/db-env-failure-domain`, head `f6273e3a05`)
**Primary briefing:** `work/handoffs/bug.5299.handoff.md`

Read, in this order, before touching anything:

1. `GET https://cognidao.org/api/v1/work/items/bug.5299` — the `summary` field is a deliberate START HERE map. The `outcome` field is ~156k chars of design history; read only the sections the summary points you at. Do not read it end to end.
2. `work/handoffs/bug.5299.handoff.md` — mission, goal, E2E proof, boundaries, gotchas.
3. `work/reviews/bug-5299-db-residency.review.md` — the first independent design review.
4. Hub entries: `noisy-neighbor-database-architecture`, `lane-is-not-control`, `lane-db-two-derivations`, `control-plane-self-starvation`.

**State in one paragraph.** Production Postgres serves four non-production lane databases (`cogni_poly_candidate_a` 4 live backends, `cogni_red_candidate_a` 1, `cogni_poly_preview` 0, `cogni_toks5_preview` 0) because custody follows the control env and `FLEET_CONTROL_ENV` defaults to production. Three PRs are merged and **inert** — the gate (`47c340162e`), the resolver (`68daac4ee0`), and the DSN host wiring (`f334447e5e`) — so the machinery to move a lane exists and is switched off. Six genuinely unused databases were dropped, with `pg_dump` rollback artifacts at `/backups/orphan-prune/` on each VM. **Zero lanes have moved.** The previous owner over-built this: a fleet-wide automation was designed for what is a four-lane problem, three of whose lanes belong to `task.5246`'s already-planned cutover. The plan has been shrunk — do not re-expand it.

**Your first concrete action:** confirm with `task.5246` that its poly dedicated-cell cutover can take env-residency as an input. That removes 27 of the 31 misresident backends with no new mechanism from you, and leaves you only `red/candidate-a` and `toks5/preview` — two throwaway lanes you can recreate empty on their own instance rather than migrate. From there you are in charge; the Goal and Done-when in the work item are the success criterion.

**Two things that will bite you, and one that will cost you production.**

- `run-node-substrate.sh:201-218` passes the control env's `VM_HOST` and never re-resolves it. The moment you delete a line from `LANE_DB_RESIDENCY_PINNED`, db-provision runs on **production's** VM and `ALTER`s production's live `app_poly`/`service_poly` (21 peak backends) to candidate-a's password. It fires on the next **production promote**, not on your flight, so it will look unrelated. Fix this before any unpin.
- `reconcile-node-substrate.sh:645-647` feeds the Postgres database name to `doltgres-provision`, which runs `dolt_commit('-Am')`. Post-unpin that stage-all-commits production's live `knowledge_poly`. Fix this before any unpin too. Doltgres residency is out of scope — its superuser is immutable.
- Wait for `build (<node>)` to pass before dispatching any flight, including scripts-only ones. A flight dispatched early silently pins a fallback image and `verify-buildsha` then fails against a stale pin — in the logs it is indistinguishable from a real verify failure.

**Access:** the working fleet SSH keys are **not** in `~/.ssh` (all nine there are rejected). They are the provision custody artifacts in the **main clone** at `.local/provision-creds/<env>/<env>-vm-key`. `.env.deployments` in this worktree holds dead-stale IPs — querying them manufactures a false "VM is down" finding. `$GRAFANA_URL` has a trailing slash that 404s the datasource proxy. `docker compose exec -T` eats the caller's stdin, so redirect `</dev/null` in any loop driving `psql`.

**Two loose ends that are not yours to guess at.** `bug.5417` and `bug.5420` are shipped and merged but stuck at `needs_triage`; `PATCH /work/items/{id}` returns `403 authz_denied` on both available keys while `bug.5299` patches fine with the same key, and the API exposes no `owner`/`createdBy` to explain it. That asymmetry deserves its own item. And the hub contribution `contrib-flock-leader-conductor-9adc844a` (entry `db-residency-follows-lane`) is open, stale relative to the work item, and needs amending before a human merges it — never merge your own contribution.
