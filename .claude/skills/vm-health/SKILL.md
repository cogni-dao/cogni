---
name: vm-health
description: One-command health snapshot of every shared Cogni VM (production, preview, candidate-a) with a GREEN/YELLOW/RED verdict, named memory hogs and the next action. Use FIRST whenever someone asks "is prod healthy", "why is the fleet flapping", "is the VM overloaded / swapping / out of disk", "what is eating memory", "should we resize the VM", "did the fix work", before/after any infra change, or before answering a human about outages. Read-only Grafana queries; never SSH to answer these questions.
---

# vm-health — snapshot, grade, act

```bash
node scripts/vm-health-snapshot.mjs              # all envs (human summary, verdict first)
node scripts/vm-health-snapshot.mjs production   # one env
node scripts/vm-health-snapshot.mjs --json       # for agents / diffs
```

Credentials: `GRAFANA_URL` + `GRAFANA_SERVICE_ACCOUNT_TOKEN` from the env or `./.env.cogni`. Exit code: `0` all green · `1` some yellow · `2` some red · `3` no credentials.

## How to read it

The first line per env is the verdict plus the single next action. **Report that line to the human, and nothing more unless asked.**

| signal                | yellow / red | meaning                                                                                                         | first move                                           |
| --------------------- | ------------ | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `swapInPagesPerSec`   | ≥10 / ≥100   | kernel paging memory back from disk                                                                             | memory pressure: look at `top:`                      |
| `dbMajorFaultsPerSec` | ≥5 / ≥50     | Doltgres/Temporal/Postgres reading their memory from swap → 30s work-item stalls, `temporal unreachable` readyz | same; DBs are the victim, not the cause              |
| `ioWaitPct`           | ≥5 / ≥20     | CPUs blocked on disk (usually a consequence of swap)                                                            | fix memory first                                     |
| `memAvailablePct`     | ≤25 / ≤10    | little headroom left                                                                                            | budget or cut top consumers; else resize             |
| `diskUsedPct`         | ≥80 / ≥90    | root disk filling                                                                                               | db_backups volume, images, journals                  |
| `probeFailures30m`    | ≥1 / ≥6      | public `/readyz` probes failed in 30m                                                                           | with no host pressure → app/lease problem, read Loki |
| `unattributedPct`     | ≥30          | memory without a named owner                                                                                    | Alloy collector gap (kubelet scrape / class relabel) |
| telemetry >5 min old  | RED          | no data                                                                                                         | missing is **not** healthy; fix Alloy first          |

`top:` is per-service RSS+swap (`compose/<svc>`, `k8s/<ns>/<owner>`, `systemd/<unit>`). Normal on a node VM: `systemd/k3s` ≈1.1–1.5GiB, which is the k3s control plane and normal per the K3s profiling docs. Argo plus Crossplane is ≈0.4GiB, and scheduler-worker ≈0.5–0.7GiB.

## Rules

- **Before→after.** Run it before and after any infra change. Paste both verdict lines as the proof.
- **Never SSH to production to diagnose.** If this tool can't answer, the gap is instrumentation: file it against the Alloy config.
- **Pressure plus DB faults on a 6GB VM is a capacity problem, not a code bug.** The 2026-10 fix was a 16GB move. Read hub [`prod-vm-swap-thrash`](https://cognidao.org/knowledge/prod-vm-swap-thrash) and the runbook [`substrate-vm-migration`](https://cognidao.org/knowledge/substrate-vm-migration).
- **Changing a threshold:** edit `THRESHOLDS` in `scripts/vm-health-snapshot.mjs`, update this table, and keep `tests/unit/scripts/vm-health-snapshot.test.ts` green.

Visual twin for humans: the public Fleet Status dashboard, "VM resources" row (`infra/grafana/dashboards/operator/fleet-status.json`).
