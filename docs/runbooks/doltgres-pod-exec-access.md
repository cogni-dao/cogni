---
id: doltgres-pod-exec-access-runbook
type: runbook
title: "Doltgres Access via Pod-Exec (when VM keys are stale)"
status: active
trust: draft
summary: "Read/write any node's Doltgres knowledge plane through the node's operator-node-app pod when SSH VM keys are stale or Doltgres has no k8s pod to exec. kubeconfig → kubectl exec app pod → node with `postgres` imported by absolute path. Used for the 2026-06-04 candidate-a → prod knowledge recovery."
read_when: "You need to query or repair a node's Doltgres (knowledge / work_items) but SSH to the VM fails (reprovisioned host key / stale key), or you're moving Doltgres rows between environments."
owner: derekg1729
created: 2026-06-04
verified: 2026-06-04
tags: [doltgres, recovery, kubernetes, knowledge, ops]
---

# Doltgres Access via Pod-Exec

> When the VM SSH key is stale (post-reprovision) and Doltgres has no k8s pod to `exec`, the node's **app pod** is the way in — it already holds `DOLTGRES_URL` and can reach Doltgres.

## Why this exists

Doltgres runs as a **Compose container on the VM** (`cogni-runtime-doltgres-1`), not a k8s pod — so `kubectl exec` can't target it directly, and its `:5435` is dropped on the public NIC (only in-cluster pods reach it). After a VM reprovision the `.local/<env>-vm-key` goes stale (host key changes, publickey denied), so SSH is out too.

The escape hatch: the node's **`operator-node-app` pod** is a real k8s pod, holds `DOLTGRES_URL`, and reaches Doltgres on the cluster network. Exec it and run `node`.

## Prerequisites

- A working kubeconfig for the env: `.local/<env>-kubeconfig.yaml` (prod: `.local/prod-art/production-kubeconfig.yaml`). These survive reprovision better than VM keys; if also stale, decrypt fresh from the latest provision/flight run init-artifact.
- The app pod name: `kubectl get pods -A | grep operator-node-app`.

## The one non-obvious gotcha: importing `postgres`

`node` is in the pod; `psql` is **not**. Import the `postgres` driver by **absolute path** — bare specifier and `createRequire` both fail because the package `main` points at a nonexistent `cjs/src/index.js`; only the `import` conditional export resolves:

```js
// ✅ works from any script location
const postgres = (await import("/app/node_modules/postgres/src/index.js")).default;
// ❌ ERR_MODULE_NOT_FOUND (bare, from /tmp) / Cannot find cjs/src/index.js (createRequire)
```

Always construct the client with `{ max: 1, fetch_types: false }` and issue every query via `sql.unsafe(...)` — **Doltgres 0.56 breaks the postgres.js extended/parameterized protocol** (see [databases.md](../spec/databases.md) / [knowledge-data-plane.md](../spec/knowledge-data-plane.md)).

## Read (diagnostics — safe)

```bash
export KUBECONFIG=.local/<env>-kubeconfig.yaml
NS=cogni-<env>; PN=$(kubectl get pods -n $NS -o name | grep operator-node-app | head -1 | cut -d/ -f2)
kubectl exec -n $NS $PN -- node --input-type=module -e '
  const postgres=(await import("/app/node_modules/postgres/src/index.js")).default;
  const sql=postgres(process.env.DOLTGRES_URL,{max:1,fetch_types:false});
  for (const t of ["domains","knowledge","citations","sources"])
    console.log(t, (await sql.unsafe(`SELECT count(*)::int n FROM ${t}`))[0].n);
  await sql.end();'
```

## Move rows between environments (e.g. recover prod from candidate-a)

1. **Extract** on the source pod → JSON (`SELECT *` per table, `JSON.stringify` the rows) → capture stdout locally.
2. **Transfer** the JSON into the target pod with `kubectl cp <file> <ns>/<pod>:/tmp/data.json`.
3. **Load** on the target pod: a `node` script (`kubectl cp` it in, run as a file) that reads the JSON and INSERTs with **escaped literals** — single-quote-double for strings, `'...'::jsonb` for `jsonb` columns (e.g. `tags`), `NULL` for null, ISO strings for timestamps — in **FK order** (`domains` → `knowledge` → `sources` → `citations`). Finish with `SELECT dolt_commit('-Am', '<message>')`. Guard on existing ids for idempotency.
4. **Verify** as an external agent via the bearer API (post-#1461): `curl -H "Authorization: Bearer $KEY" https://<env>.cognidao.org/api/v1/knowledge` → confirm the rows materialize with no session.

## Safety

- Reads are safe diagnostics. **Writes go direct to `main`** (bypassing contribution-branch governance) — use only for **operator-level recovery/ops**, never as a routine write path (agents use the contribution API per `EXTERNAL_WRITES_TO_BRANCH`).
- Additive INSERTs into empty tables are low-risk; never `dolt_reset_*` / `DROP` (the `reset --hard` mirror seed is what truncated 688 work_items — see [knowledge-data-plane.md](../spec/knowledge-data-plane.md)).

## Worked example

2026-06-04 knowledge recovery: candidate-a held the corpus (5 domains + 14 entries); prod was empty. Extracted via the candidate-a operator pod, `kubectl cp` to the prod operator pod, INSERT + `dolt_commit`, verified via prod bearer `GET /api/v1/knowledge` → 14 entries. VM SSH was dead the whole time; pod-exec was the only path.

## Related

- [databases.md](../spec/databases.md) — Postgres-vs-Doltgres split, `sql.unsafe` / `escapeValue` rationale
- [knowledge-data-plane.md](../spec/knowledge-data-plane.md) — Doltgres knowledge plane, per-node DBs
- [dolthub-remote-bootstrap.md](./dolthub-remote-bootstrap.md) — the mirror/push side
