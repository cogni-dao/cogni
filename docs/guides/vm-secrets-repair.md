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

## Implementation — per-node-role cutover (now)

The change spans three files that ship together; the falsifying gate spans all of
them (Invariant 16), so it lands as one PR. **We cut over now** — no real users on
any env, so the shared `app_user`/`app_service` do **not** survive the change (no
dual-role "retire later"). Within a single provision run the new role is created
before the legacy one is dropped (ordering safety), but the end state is per-node
roles only.

**RLS is unaffected by the rename.** Policies key on
`current_setting('app.current_user_id')`, never on the role name
([`database-rls.md`](../spec/database-rls.md)), so `app_<node>` is a drop-in with
the same attributes as `app_user` (LOGIN, **no `BYPASSRLS`** → tenant-isolated
under `FORCE ROW LEVEL SECURITY`). `service_<node>` is `BYPASSRLS` (workers);
`app_readonly` stays **shared** (env-level Grafana datasource, `BYPASSRLS`) until
datasources go per-node. Postgres roles are **cluster-global**, so per-node means
distinct names (`app_poly`, `app_operator`), not a per-DB `app_user`.

**`FORCE ROW LEVEL SECURITY` is load-bearing here** and must not be optimized away:
`app_<node>` *owns* its DB, and a table owner bypasses RLS **without** FORCE — so
FORCE is exactly what keeps the owning per-node role tenant-isolated. It lives in
the schema migrations (role-agnostic), so the rename doesn't touch it; keep it on
all user tables.

### Locked conventions (materialize mirrors these — #1585)

- **Role names** — computed from the node (underscored, like `cogni_<node>`); only
  the *password* is the OpenBao secret: `app_<node>` (owner, RLS-subject),
  `service_<node>` (`BYPASSRLS`), `app_readonly` (shared, env-level).
- **Invocation** — per-node roles need per-node passwords, but `provision.sh` today
  provisions all nodes in one pass with one shared password (`COGNI_NODE_DBS` loop,
  `docker-compose.yml:265`). The cutover invokes `provision.sh` **per-node**: the
  caller (reconcile, `<env>-db-reader`) reads `cogni/<env>/<node>/APP_DB_PASSWORD`
  and provisions that one node. Shared objects (litellm/openfga DBs, `app_readonly`)
  still provision once.

Order: **candidate-a** (reprovision-friendly, gate first) → **preview** →
**production** (no real users — cut over fast).

1. **Generate per-node app creds** — move `APP_DB_PASSWORD` /
   `APP_DB_SERVICE_PASSWORD` out of `reconcile-secrets.sh::COMPOSE_ONLY_KEYS` into
   the per-node `source: agent` set so `secret-materialize` generates them into
   `cogni/<env>/<node>` (preserve-existing). `APP_DB_USER` becomes the **derived**
   `app_<node>` (node name, not a secret). *Additive: writes new OpenBao keys; the
   shared `app_user` DSN is still live.*
2. **Create + reconcile per-node roles** — `provision.sh` creates `app_<node>` /
   `service_<node>` if absent, then **reconciles the password to the OpenBao value
   every run** (idempotent `ALTER ROLE … PASSWORD <openbao value>`) — **not**
   set-once. The bug.5002 lesson is *single source = OpenBao*, not *never `ALTER`*:
   `ALTER`ing to the value ESO syncs to the pod cannot diverge, and it's what makes
   rotation work (set-once would `28P01` on the next rotation). Source must be the
   OpenBao read, **never** a rendered `.env` (that is the bug.5002 anti-fix). It
   applies the same per-DB GRANT/RLS/ownership `app_user` had; ownership migration
   for existing DBs happens at cutover (Step 5).
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
5. **Drop the legacy (same change, not deferred)** — `app_user`/`app_service` are
   cluster-global with owned objects + grants in **every** node DB. Before
   `DROP ROLE`, in **each** DB run `REASSIGN OWNED BY app_user TO app_<node>` (that
   DB's matching per-node role) then `DROP OWNED BY app_user` — skip either and the
   drop errors. After every DB is done: `DROP ROLE app_user`/`app_service` and
   delete the `APP_DB_*_PASSWORD` GitHub Environment secrets (Invariant 5). The
   shared role does not linger.
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
