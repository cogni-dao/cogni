---
id: guide.vm-secrets-repair
type: guide
title: VM Secrets Repair — DB Credentials to OpenBao Sole-Source
status: draft
trust: draft
summary: "Per-env runbook to make OpenBao the sole source for a node's pod-facing DB credentials, closing the bug.5002 split-brain. Per-node model (no shared DB bank); env superuser stays bootstrap-only. Gated behind the per-node-role db-provision change."
read_when: "Repairing an existing env whose pod-facing DB credentials still live in VM .env / GitHub Environment secrets; running the falsifying gate for the node-wizard DB-cred lane."
owner: cogni-dev
created: 2026-06-09
spec_refs:
  - ../spec/secrets-management.md
  - ../spec/secrets-classification.md
related:
  - ../design/node-wizard-secret-setting.md
  - ./secrets-rotate.md
---

# VM Secrets Repair — DB Credentials to OpenBao Sole-Source

## Why this exists

A pod-facing DB role password currently exists in **two stores**: OpenBao
(`cogni/<env>/<node>`, synced to the pod by ESO) **and** a GitHub Environment
secret rendered into VM `/opt/cogni-template-runtime/.env` (used by
`db-provision` to create the role). Equal only by construction; rotate either
independently and they diverge → `28P01` → `/readyz` 502 (the candidate-a
2026-06-04 outage, bug.5002). This runbook makes OpenBao the **sole source** per
[`secrets-management.md` Invariant 15](../spec/secrets-management.md#core-invariants).

This is the **env-genesis half**. The node half — `secret-materialize` →
read-only `reconcile-substrate` → `assert-substrate` — is
[`node-wizard-secret-setting.md`](../design/node-wizard-secret-setting.md) / #1582.

## Model (see the contract; not restated here)

The custody model is canonical in
[`secrets-management.md`](../spec/secrets-management.md) (Invariant 15 +
DB-credential provisioning) and
[`secrets-classification.md`](../spec/secrets-classification.md). The two facts
that govern this runbook:

- **DB creds are per-node, not `_shared`.** They are deliberately absent from the
  `_shared` classification, and `_shared` itself is a transitional bank being
  purged toward owner-scoped paths. **Do not create a `cogni/<env>/_shared` DB
  path** — pod-facing DB material lives at `cogni/<env>/<node>`.
- **The env superuser is not pod-facing.** `POSTGRES_ROOT_PASSWORD` and the
  Doltgres superuser password stay **Compose/bootstrap-only**; no pod consumes
  them, so they are out of scope for this OpenBao migration (`_system` at most, if
  ever removed from GH env — never `_shared`).
- **Doltgres stays derive-from-master (B), not per-node (A) — for now.** The
  north star is per-node Doltgres roles (A), but Doltgres 0.56 RBAC is vestigial:
  `GRANT` reports success yet the role cannot even `SELECT current_user`, so
  `deploy-infra.sh` ships `knowledge_<node>` access as the `postgres` superuser
  (task.0311 / dolthub/doltgresql). So `DOLTGRES_PASSWORD` stays the **env-level
  Doltgres superuser** (bootstrap-level like `POSTGRES_ROOT_PASSWORD` — not a
  per-node secret, not `_shared`); the pod's per-node `DOLTGRES_URL` (its own
  `knowledge_<node>` DB) is composed from it. Migrate to A when Doltgres `GRANT`
  works. **Not blocking** the Postgres per-node-role purge below.

> An earlier draft of this runbook imported the superuser + four derived passwords
> into `cogni/<env>/_shared`. That was wrong: it adopted the deferred shared-bank
> and propped up the shared `app_user` we are removing. Removed.

## The crux — per-node roles

`provision.sh` today creates **three env-shared roles** —
`app_user` / `app_service` / `app_readonly` (`postgres-init/provision.sh:143,159,173`)
— and grants them onto every `cogni_<node>` database (the database is the only
per-node boundary; the roles are shared). Making OpenBao the sole source
**without** a shared OpenBao DB path therefore **requires per-node roles**
(`app_<node>` / `service_<node>`, each with its own `source: agent` password the
node generates). That per-node-role `db-provision` change — deferred by #1582 — is
**this lane's central work** (Step 2 below), not an external dependency. The
alternative (a shared OpenBao DB path) is explicitly rejected.

## Implementation — additive cutover (each step independently safe)

The change spans three files that ship together and the falsifying gate spans
all of them (Invariant 16), so it lands as one PR. But the **per-step ordering is
additive**: the new per-node role is created and granted *alongside* the shared
`app_user` before anything cuts over, so no step has a broken intermediate state.

Order: **candidate-a** (reprovision-friendly, gate first) → **preview** →
**production** (maintenance-aware, no real users — purge fast).

1. **Generate per-node app creds** — move `APP_DB_PASSWORD` /
   `APP_DB_SERVICE_PASSWORD` out of `reconcile-secrets.sh::COMPOSE_ONLY_KEYS` into
   the per-node `source: agent` set so `secret-materialize` generates them into
   `cogni/<env>/<node>` (preserve-existing). `APP_DB_USER` becomes the **derived**
   `app_<node>` (node name, not a secret). *Additive: writes new OpenBao keys; the
   shared `app_user` DSN is still live.*
2. **Create per-node roles alongside** — `provision.sh` creates `app_<node>` /
   `service_<node>` from the OpenBao values (`<env>-db-reader`) and applies the
   same per-DB GRANT/RLS/ownership it gives `app_user`, **without dropping
   `app_user`**. *Additive: both roles can log in; the pod hasn't switched yet.*
3. **Compose + cut over the DSN** — un-defer the three DSN keys in
   `secret-materialize` (`DSN_DEFER_KEYS`) so it composes `DATABASE_URL` /
   `DATABASE_SERVICE_URL` from the node's own `app_<node>` creds; strip the
   `<env>-writer` mint + VM-`.env` reads + DSN seed from
   `reconcile-node-substrate.sh` → **reconcile is now read-only** (kills the
   Invariant 16 transitional exception — the finish line). ESO syncs the new DSN;
   pod reconnects as `app_<node>`.
4. **Provisioners read OpenBao only** — delete the `deploy-infra.sh:838-860`
   `derive_secret` block + `${X:-$(remote_env_value …)}` `.env` fallbacks;
   fail-loud-skip on read miss, never `.env` (the bug.5002 anti-fix).
5. **Retire the legacy** — once every node is green under its own role, drop the
   shared `app_user`/`app_service` grants and delete the `APP_DB_*_PASSWORD` GitHub
   Environment secrets (Invariant 5). No destructive change before green.
6. **Falsifying gate** (below).

### Seam with the materialize redesign (coordinate before parallel work)

The DSN-write half lives in `secret-materialize` — and #1579 is moving materialize
off the per-key SSH loop to an in-cluster read-once-diff-write **Job**. DSN seeding
must land in that Job form, **never** the old per-key SSH loop (the anti-pattern
being removed). The two halves agree on this contract:

| Owner | Does | Where |
| --- | --- | --- |
| materialize (Job — #1579 hosts the form, I specify the keys) | generate per-node `APP_DB_PASSWORD` / `APP_DB_SERVICE_PASSWORD` (`source: agent`); compose + write `DATABASE_URL` / `DATABASE_SERVICE_URL` / `DOLTGRES_URL` | `cogni/<env>/<node>` |
| `provision.sh` (me) | `CREATE ROLE app_<node>` / `service_<node>` from those passwords (alongside `app_user` until cutover); per-DB grants/RLS | Postgres |
| reconcile (me) | `<env>-db-reader` reads the per-node passwords, passes them to db-provision; applies the ESO leaf; **zero OpenBao writes, no `<env>-writer`** | — |

Shared conventions: role names `app_<node>` / `service_<node>` (node underscored,
matching `cogni_<node>`) — materialize's DSN username and `provision.sh`'s role name
must agree. `app_readonly` stays **shared** (Grafana datasource, env-level).
`DOLTGRES_URL` is composed by materialize from the env superuser (`DOLTGRES_PASSWORD`,
decision B above). I do **not** seed DSNs anywhere; materialize owns DSN custody.

## Safety rules

- **Never `ALTER … PASSWORD` a live role to a rendered `.env` value** to "self-heal
  drift" — that is the bug.5002 anti-fix; it makes the deploy a second writer and
  converts silent drift into an active 502. Fix the **source** (point the
  provisioner at OpenBao), never overwrite the DB from `.env`.
- Per-node roles are **created new**; migrate DB access via `GRANT`, prove the pod
  is green under the new role, **then** retire the shared role + GH-env copy. No
  destructive ownership change before green.
- Every VM-mutating step lands as a committed script + provisioner diff, never an
  SSH one-off (`feedback_vm_edits_need_git_capture`).

## Falsifying gate (proves split-brain is dead)

```bash
# remove the .env copy so .env can no longer be the source
ssh root@$VM_HOST "sed -i.bak '/^APP_DB_PASSWORD=/d' /opt/cogni-template-runtime/.env"
# run the node lane + a deploy; prove the app comes up green from OpenBao only
```

Pass = apps reach `/readyz` healthy and `/version` serves with `APP_DB_PASSWORD`
absent from `.env`; Loki shows the `<env>-db-reader` subject reading
`cogni/<env>/*`, zero `28P01`. Capture the proof on the PR.

## Per-env notes

| Env           | Posture                                                                                                                            |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `candidate-a` | Throwaway. Easiest path is a **reprovision** with the per-node-role `provision.sh`, then run the gate. No live users to protect.   |
| `preview`     | Semi-live. In-place migration (Steps 1–5), per node, then the gate.                                                                |
| `production`  | Live. In-place migration in a maintenance-aware window; have rollback ready (retire the shared role only after every node green). |

## Related

- [`secrets-management.md`](../spec/secrets-management.md) — Invariant 15 + DB-credential provisioning (the contract)
- [`secrets-classification.md`](../spec/secrets-classification.md) — why DB creds are per-node, not `_shared`
- [`node-wizard-secret-setting.md`](../design/node-wizard-secret-setting.md) — the node materialize/reconcile lane
- [`secrets-rotate.md`](./secrets-rotate.md) — steady-state rotation (rewrite its static-DB-rotation section once provisioners read OpenBao)
