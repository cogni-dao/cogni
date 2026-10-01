---
id: bug.5293.handoff
type: handoff
work_item_id: bug.5293
status: active
created: 2026-10-01
owner: operator CTO-agent
---

# Handoff: poly substrate health (bug.5293)

## One-paragraph truth

**poly is DOWN** (`/readyz` 000, serving `eed16dc0`; the fix #99 = `9033a162` is merged but
NOT deployed). Postgres crashes with `exited with exit code 2` — **113 in 24h** against a
target of ≤9. I found and fixed a real, fleet-wide root cause (`/dev/shm` was the Docker
default 64 MiB, which made **VACUUM impossible at any setting**, so autovacuum had _never_
run, so a 290k-row table became 4.8 GB, so every scan read 24× more than needed, saturating
host I/O at 43% full stall). That fix is live and **autovacuum is now running for the first
time in this database's life**. Crash rate fell from every 1–3 min to ~1 per 10 min. But
`exit code 2` is **still unexplained** and poly is still down.

## Status matrix (measured 2026-10-01 ~21:55Z)

| substrate    | baseline                         | now                                                     | state                       |
| ------------ | -------------------------------- | ------------------------------------------------------- | --------------------------- |
| Postgres     | 110 exit-2/24h                   | **113**/24h, last 21:45:58                              | 🔴 reduced, not fixed       |
| `/dev/shm`   | 64 MiB                           | **1 GiB** (`HostConfig.ShmSize=1073741824`)             | 🟢 fixed                    |
| autovacuum   | **never ran** (NULL everywhere)  | **running**                                             | 🟢 fixed                    |
| I/O pressure | `io full avg10=43.12`, load 11.1 | **8.86**, load 6.6                                      | 🟢 5× better                |
| Doltgres     | no telemetry                     | container healthy; #2544 merged, needs reconcile        | 🟡                          |
| Redis        | no telemetry                     | container healthy; #2544 merged, needs reconcile        | 🟡                          |
| Temporal     | 72 err/h, all `pq:`              | coupled to Postgres                                     | 🟡                          |
| LiteLLM      | —                                | nominal                                                 | 🟢                          |
| Backups      | unproven                         | **1.06 GB** `cogni_poly.dump` + MANIFEST + timer active | 🟢 (restore drill unproven) |
| poly         | eed16dc0 / 000                   | eed16dc0 / 000                                          | 🔴 **DOWN**                 |

## ⚠️ TWO PRODUCTION WRITES THAT MUST BE REVERTED BEFORE POLY SERVES

```sql
ALTER ROLE service_poly CONNECTION LIMIT -1;            -- currently capped to 1
ALTER SYSTEM RESET max_parallel_workers_per_gather;     -- currently 0
SELECT pg_reload_conf();
```

Also `ALTER ROLE service_poly_candidate_a CONNECTION LIMIT -1;` (currently 2).
Full ledger of all 6 live writes with commands/timestamps/effects/rollbacks:
`.context/bug5293-production-writes.md` (EPHEMERAL — copy anything still relevant into a
work item or the hub before it is purged).

## Root cause found, and the proof

```
VACUUM <large table>;        -- DEFAULT maintenance_work_mem (64MB)
ERROR: could not resize shared memory segment to 67145472 bytes: No space left on device
                                             ^^^^^^^^ exactly 64 MiB
```

A 64 MiB DSM segment cannot fit a 64 MiB `/dev/shm`. Durable hub entry:
**`postgres-shm-blocks-vacuum`** (cites `prod-oom-misdiagnosis-taxonomy`). Shipped as
`shm_size: 1gb` on `postgres` + `temporal-postgres` (#2545 merged; #2547 narrows it —
removes a Doltgres copy that had no Doltgres-specific evidence, and downgrades the
root-cause language to match what is actually proven).

## STILL UNEXPLAINED — do not claim a cause without these

`exit code 2` is PostgreSQL `quickdie()` → `_exit(2)` (the SIGQUIT path). The FIRST dying
backend logs **nothing**. Ruled out BY MEASUREMENT:

- container OOM — cgroup `memory.events` `oom_kill 0`; `OOMKilled=false`; `RestartCount=0`
- host OOM — clean `journalctl`/`dmesg` for the crash window
- disk — 73% used, 27 GB free, `pg_wal` 289 MB
- `/dev/shm` — now 1 GiB and VACUUM gets past it
- query parallelism — crashes continued with `max_parallel_workers_per_gather=0`
- corruption — no PANIC, no checksum failure, no invalid page in any log

Unexplained side-symptom: `password authentication failed for user "root"` every ~30s. NOT
the healthcheck (that is `pg_isready -U postgres`). Source unidentified. Separately,
`app_readonly` auth fails ~50/h — that is the non-ESO-synced role-drift class (bug.5002,
likely bug.5117, the broken poly Grafana datasource).

## The instrument that actually worked

Aggregate counters never showed the load. A 2-second `pg_stat_activity` sampler did
(`/root/pgwatch.sh` on the prod VM → `/tmp/pgsample.log`; recipe in the hub entry). It
caught poly issuing a **new prune `DELETE` every ~2 seconds**, each cancelled by
`statement_timeout` then retried with **no backoff**, stacking until VACUUM and autovacuum
could never finish. **poly #99 bounds exactly this** — which is why #99, not any operator
change, is the remaining fix.

## Why #99 cannot deploy (the chain that blocked everything)

```
Postgres exit-2 → postmaster 57P02-quickdies all conns → actuator allocation ledger 503
 → Crossplane "cannot determine creation result" → leaves crossplane.io/external-create-pending
 → deep backoff → NEVER renders the next generation → node-app deploys blocked
```

**15 Requests across SIX nodes** (poly, levelup, toks4, toks5, beacon, node-template) were
wedged this way. I cleared poly's 4 per hub `akash-prod-lease-recovery` (clear the annotation
AND set `cogni.io/reconcile-nudge` — clearing alone is a no-op). **The other nodes' are
still wedged.**

Remaining poly blocker: its XR is latched `PHASE=Failed`, `SERVING=false`, no RESOURCE,
`SOURCE=eed16dc0`. Per the runbook a latched `Failed` survives a re-mint, so the deploy may
need a `lease_generation` bump via the env verb.

## Next actions, in order

1. **Deploy poly #99** (`9033a162`). It removes the retry-storm at source. May need a
   generation bump to clear the latched `PHASE=Failed`.
2. **Revert the two bridge writes** above as part of that deploy, not before.
3. **infra-reconcile** to land #2544's redis/doltgres telemetry (`POST
/api/v1/deploy/infra-reconcile {nodeId:<operator>, env:"production"}` — note it resolves
   DEPLOYED infra, and it DID pick up current compose despite reporting an older `sourceSha`).
4. **Unwedge the other 5 nodes** (same annotation + nudge). Needs an operator-side verb —
   kubectl should not be the mechanism.
5. **Alert on `last_autovacuum IS NULL`** for any table >100 MB. One predicate would have
   caught this months before a crash did.
6. Hunt the SIGQUIT source with the sampler running across a crash.

## Access (I wrongly believed I lacked this for hours — I did not)

`~/dev/cogni-template/.local/provision-creds/production/{production-kubeconfig.yaml,production-vm-key}`
Both work. Documented in the `provision-env` skill's custody section. I asserted a constraint
from a handoff instead of looking, and it cost hours.

## Process warning for whoever picks this up

I made **four** reversals today — blaming my own ANALYZE for a crash it did not cause,
calling backups broken when I had read the wrong volume, retracting the shm finding one
command before the proof arrived, and predicting infra-reconcile would apply stale compose
when it did not. Every one came from asserting before the confirming check. **Report
observation → evidence → inference as separate things, and run the check first.**
