---
id: bug.5293.handoff
type: handoff
work_item_id: bug.5293
status: active
created: 2026-10-01
updated: 2026-10-02
branch: derekg1729/bug5293-handoff-v2
last_commit: HEAD
---

# Handoff: Poly is UP. The Postgres crash class is not solved.

## State in one paragraph

Poly production is live on Akash **Finland** serving the merged fix, and the whole fleet is
green. What is NOT done is the bug this item is actually named for: production Postgres still
dies with `exited with exit code 2` roughly once an hour, and each crash costs poly a brief
`/readyz` 503. Your job is that crash class — not poly, not placement.

## Proven live (do not re-litigate)

```
poly /version   2679ce0534ce1963e8ce36c81558c7e386d4ec0c   (poly main HEAD, #102)
poly /readyz    200 {"status":"healthy"}
XR              gen=20 phase=Ready serving=true res=1790822853178(active)
Console         dseq 1790822853178 state=active, svc app available=1,
                uris=[cfvnrn4gppe0j441ibuudbaosc.ingress.akash.rhite.co.uk, poly.cognidao.org]
egress-check    {"blocked":false,"egress_ip":"157.180.108.139","egress_country":"FI"}
fleet           8/8 readyz=200 (poly, poly-test, beacon, toks4, toks5, levelup,
                node-template, operator)
substrate       Postgres healthy · Redis PONG · Doltgres accepting · Temporal SERVING
ledger          compute_cost_intervals: active=11 closed=44 allocated=0
```

## The two root causes that actually ended the outage

Both were found in the last hour of a five-hour incident. Everything before was a wrong lane.

| #   | cause                                                                                                                                                                                                                                                                                                                                                                                   | fix                                                                                                                                                                                                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **The control plane disowned a live lease.** poly held a live, paid, serving RHITE Finland lease the whole time (receipt `active` with provider + rate) while its XR read `phase=Failed resource=<empty> BootDeadlineClosed`. Gens 21/22/23 were spent losing auctions for compute we already owned.                                                                                    | PR #2557 — `lease_generation.production: 23 -> 20`, deliberately BACKWARD. The create key is generation-only and gen-20 was `active`, not settled, so rendering 20 binds the live handle and takes the observe→UPDATE path. Knowledge: `akash-adopt-live-lease`. |
| 2   | **The provider's NAT rotated out of the firewall.** `/readyz` 503 after a ~15s connect timeout because `compute_egress_cidrs` carried `157.180.59.24/32` while the lease egressed `157.180.108.139`. The fail-closed substrate-port DROP cut the workload off its own Postgres (bug.5326). This — not the Postgres crash-loop — is also why gen-20 originally missed its boot deadline. | PR #2558 added `157.180.108.139/32` + `POST /deploy/infra-reconcile`. `/readyz` went 200 within a minute.                                                                                                                                                        |

## YOUR JOB: the exit-2 crash class

**Status: 14 crashes in ~10h (~1.4/h). Gate is <=9/24h. FAILING. Mechanism unattributed.**

Leading candidate is **bug.5117** (`needs_implement`, escalated with the evidence). The PID-locality
test is the strongest signal anyone has produced — every crashing backend's PID sits inside the
`app_readonly` auth-failure stream, 6 for 6:

```
RO 74553  RO 74583  RO 74606   -> CRASH 74777
RO 103411 RO 103445 RO 103667  -> CRASH 103665
RO 118915 RO 119141 RO 119142  -> CRASH 119158
RO 129889 RO 129898 RO 129924  -> CRASH 129978
RO 133661 RO 133686 RO 133709  -> CRASH 133724
```

Hard constraints, all measured — any theory must satisfy all of them:

- The `exit code 2` line is the **first** postmaster event. There is **no** `was terminated by
signal` anywhere in 24h, so there is no signalled first victim and no cascade origin.
- **All 8** victims since 23:30Z have **zero** rows in a 2s `pg_stat_activity` sampler (363k+
  samples) — every victim lived **<2s**. It is a brand-new connection dying on arrival, never a
  long-running query.
- Rate mismatch: ~179 `app_readonly` FATALs/h vs ~1.4 crashes/h. Roughly 1 in 120 short-lived
  connections exits 2 instead of logging a clean FATAL. Smells like a connection setup/teardown
  race under churn.

**Test:** fix bug.5117 (declarative ESO sync of the credential — **never** `ALTER ROLE`, bug.5002
role-drift; it is GRAFANA's user). The FATAL rate should go to ~0; then re-measure exit-2 against
the 14/10h baseline. Fixing it also restores `scripts/grafana-postgres-query.sh`, the box-free SQL
instrument this incident lacked throughout.

### Theories already dead — do NOT revive without new evidence

| theory                             | killed by                                                                                    |
| ---------------------------------- | -------------------------------------------------------------------------------------------- |
| Host / container OOM               | `journalctl -k` clean across all crashes; postgres at 7.78% of host mem; cgroup `oom_kill 0` |
| `/dev/shm` 64MiB                   | raised to 1GiB and verified; 14 crashes followed                                             |
| Query parallelism                  | crashes continued at `max_parallel_workers_per_gather=0`                                     |
| An INVALID index                   | all 5 indexes `indisvalid=t`; 0 invalid in the DB                                            |
| My own 8s role `statement_timeout` | removed 05:55Z (W8); a crash still landed 06:01                                              |
| Hourly `k3s-kine-compact`          | only 2 of 4 compacts had a nearby crash; 2 crashes had none; compact finishes in ~17ms       |

## Live instruments left running for you

- **2s forensics sampler** on the prod VM: `/root/pgforensics.sh` -> `/root/pgsample.log`
  (captures pid, `backend_type`, usename, state, query). It will attribute the next crash **if**
  the victim ever lives >2s. Kill with `pkill -f pgforensics.sh`.
- **Per-DSEQ money truth**: inside the actuator pod,
  `K=$(cat /run/secrets/akash-tx/AKASH_ACTUATOR_CONSOLE_API_KEY)` then
  `GET https://console-api.akash.network/v1/deployments/<dseq>`.
  **Never trust `--audit`** — it printed `active deployments: 0` while 11 were live and billing.
- **poly egress oracle**: `GET /api/internal/ops/poly/egress-check` with poly's
  `INTERNAL_OPS_TOKEN` (from `poly-compute-env-secrets`) as a **Bearer** header. Only proof of
  egress IP + Polymarket geoblock.

## Uncommitted production state you inherit

Full ledger: `.context/bug5293-production-writes.md` (W1–W8).

| still live     | what                                                              | rollback                                      |
| -------------- | ----------------------------------------------------------------- | --------------------------------------------- |
| **W7 partial** | `service_poly CONNECTION LIMIT 20`                                | `ALTER ROLE service_poly CONNECTION LIMIT -1` |
| W4             | `/dev/shm 1GiB` — durable, keep                                   | —                                             |
| reverted       | W2 parallelism, W5 candidate-a cap, W8 the 8s `statement_timeout` | —                                             |

`service_poly`'s `statement_timeout` is intentionally **off**: the retention prune needs 29.1s
(72.7s before autovacuum) and can never complete under 8s. poly self-bounds at 30s via
`SET LOCAL`, which is the right layer. `app_<node>` is the **migrator** role (`DATABASE_URL`);
`service_<node>` is the BYPASSRLS background identity — do not swap a tight bound onto `app_*` or
you cancel migrations mid-deploy.

## Open follow-ups

| item                                            | why it matters                                                                                                                                                                                                                                                   |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **bug.5117**                                    | the crash-class candidate above; also restores the SQL instrument                                                                                                                                                                                                |
| **bug.5347**                                    | `DRY_RUN=1` is ignored on `recover-orphaned-akash-lease.sh`'s most common path — the guard is an `elif` on `verify_closed`, so `close_lease` runs unguarded. I made 3 unintended prod writes this way (benign: Console is read first). Fix inside `close_lease`. |
| **task.5075**                                   | second in-set provider. Real, but it was **not** this outage — carries the six-probe evidence.                                                                                                                                                                   |
| **bug.5346**                                    | DUPLICATE of **story.5053**; close it.                                                                                                                                                                                                                           |
| no TS writer for `compute_egress_cidrs` (#2175) | provider NATs are hand-tracked; cause #2 recurs on every rotation. Durable fix: measure egress from inside the lease at boot and allowlist automatically.                                                                                                        |
| prod `runtime.logPush: false`                   | production poly lease logs never reach Loki, so poly's prune cadence is unverifiable on prod.                                                                                                                                                                    |
| `--audit` under-reports                         | prints 0 active while 11 are live — this is why nobody saw cause #1.                                                                                                                                                                                             |

## Mistakes I made — recorded so you skip them

1. **Shipped a BG placement widening** that redid a deliberately-reverted decision (#2528). Closed
   unmerged. Read `akash-node-expert` BEFORE touching placement; it says four days were already
   lost tuning country sets.
2. **Released candidate-a's live lease** by clearing `external-create-pending` and nudging a
   Crossplane Request **without checking its verb** — it was a DELETE. Recovered via #2556.
   Check the verb.
3. **Chased jurisdiction / provider pool / auctions for four hours** when poly already had a
   Finland lease. Read the receipt first.
4. **Reported two causal theories that the next measurement killed.** Widen the window before
   claiming a trend; two data points looked periodic and were not.

## Start here

1. `curl https://poly.cognidao.org/readyz` — confirm still 200.
2. Re-measure the crash rate; if it has not changed, go straight at **bug.5117**.
3. Read `.context/bug5293-production-writes.md` before touching the database.
