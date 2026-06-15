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
- **The Postgres env superuser is not pod-facing.** `POSTGRES_ROOT_PASSWORD` stays
  **Compose/bootstrap-only**; no pod consumes it, so it is out of scope for this
  OpenBao migration (`_system` at most, if ever removed from GH env — never `_shared`).
  **The Doltgres superuser is the exception** (next bullet): the pod reaches its
  `knowledge_<node>` DB _as_ that superuser, so `DOLTGRES_PASSWORD` **is** pod-facing
  and **is** OpenBao-owned — materialized per-node, not bootstrap-only.
- **Doltgres stays derive-from-master (B), not per-node-role (A) — RBAC verdict
  CONFIRMED.** Doltgres `0.56.3` RBAC is table-DML-only, so a per-node
  `knowledge_<node>` role can't run the migrator or app and the pod connects as the
  `postgres` superuser. The empirical proof + upstream citations are the SSOT in
  [databases.md §5.2](../spec/databases.md) — not restated here. The **secrets
  consequence** (this runbook's domain): `DOLTGRES_PASSWORD` is OpenBao-sole-source
  like Postgres (not bootstrap-only) — the env superuser password, derived from
  `POSTGRES_ROOT_PASSWORD` (salt `doltgres-root`), materialized **per-node** to
  `cogni/<env>/<node>`, with `DOLTGRES_URL` composed from it by `secret-materialize`
  (the sole OpenBao writer; reconcile read-only). Only the credential _value-shape_
  differs from Postgres (env superuser, not per-node `source: agent`); migrate to A —
  a per-node `knowledge_<node>` role — with **zero pipeline change** the day Doltgres
  adds function/schema/role privileges. **Not blocking** the Postgres per-node-role
  purge below.

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
`app_<node>` _owns_ its DB, and a table owner bypasses RLS **without** FORCE — so
FORCE is exactly what keeps the owning per-node role tenant-isolated. It lives in
the schema migrations (role-agnostic), so the rename doesn't touch it; keep it on
all user tables.

### Locked conventions (materialize mirrors these — #1585)

- **Role names** — computed from the node (underscored, like `cogni_<node>`); only
  the _password_ is the OpenBao secret: `app_<node>` (owner, RLS-subject),
  `service_<node>` (`BYPASSRLS`), `app_readonly` (shared, env-level).
- **Invocation** — per-node roles need per-node passwords, but `provision.sh` today
  provisions all nodes in one pass with one shared password (`COGNI_NODE_DBS` loop,
  `docker-compose.yml:265`). The cutover invokes `provision.sh` **per-node**: the
  caller (reconcile, `<env>-db-reader`) reads `cogni/<env>/<node>/APP_DB_PASSWORD`
  and provisions that one node. Shared objects (litellm/openfga DBs, `app_readonly`)
  still provision once.

Order: **candidate-a** (gate first) → **preview** → **production**. Each env cuts
over in place via a substrate-running flight (no real users — cut over fast).

1. **Generate per-node app creds** — move `APP_DB_PASSWORD` /
   `APP_DB_SERVICE_PASSWORD` out of `reconcile-secrets.sh::COMPOSE_ONLY_KEYS` into
   the per-node `source: agent` set so `secret-materialize` generates them into
   `cogni/<env>/<node>` (preserve-existing). `APP_DB_USER` becomes the **derived**
   `app_<node>` (node name, not a secret). _Additive: writes new OpenBao keys; the
   shared `app_user` DSN is still live._
2. **Create + reconcile per-node roles** — `provision.sh` creates `app_<node>` /
   `service_<node>` if absent, then **reconciles the password to the OpenBao value
   every run** (idempotent `ALTER ROLE … PASSWORD <openbao value>`) — **not**
   set-once. The bug.5002 lesson is _single source = OpenBao_, not _never `ALTER`_:
   `ALTER`ing to the value ESO syncs to the pod cannot diverge, and it's what makes
   rotation work (set-once would `28P01` on the next rotation). Source must be the
   OpenBao read, **never** a rendered `.env` (that is the bug.5002 anti-fix). It
   applies the same per-DB GRANT/RLS/ownership `app_user` had, and on an existing
   `app_user`-owned DB it **idempotently reassigns ownership** to `app_<node>`
   (`migrate_owned`) so every env cuts over by the **same flight** — zero manual
   steps. The reassign is guarded (no-op on fresh nodes and once cut over).
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
5. **Retire the legacy roles** — per-DB ownership cutover already happens
   automatically: `provision.sh::migrate_owned` reassigns each `app_user`-owned DB to
   `app_<node>` on every flight, idempotently, in **all** envs (no per-env manual
   step). What remains is the **cluster-level** finish, done **once after every node
   in every env has cut over** (the per-DB `DROP OWNED` has already cleared each
   node's grants): `DROP ROLE app_user` / `app_service`. Then delete the
   `APP_DB_*_PASSWORD` GitHub Environment secrets (Invariant 5). The hand-rolled
   provisioner bash itself is retired by the declarative endgame (CloudNativePG /
   Terraform `postgresql` provider, task.5016).

6. **Falsifying gate** (below).

### Seam with the materialize redesign (coordinate before parallel work)

The DSN-write half lives in `secret-materialize` — and #1579 is moving materialize
off the per-key SSH loop to an in-cluster read-once-diff-write **Job**. DSN seeding
must land in that Job form, **never** the old per-key SSH loop (the anti-pattern
being removed). The two halves agree on this contract:

| Owner                                                        | Does                                                                                                                                                        | Where                |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| materialize (Job — #1579 hosts the form, I specify the keys) | generate per-node `APP_DB_PASSWORD` / `APP_DB_SERVICE_PASSWORD` (`source: agent`); compose + write `DATABASE_URL` / `DATABASE_SERVICE_URL` / `DOLTGRES_URL` | `cogni/<env>/<node>` |
| `provision.sh` (me)                                          | `CREATE ROLE app_<node>` / `service_<node>` from those passwords (alongside `app_user` until cutover); per-DB grants/RLS                                    | Postgres             |
| reconcile (me)                                               | `<env>-db-reader` reads the per-node passwords, passes them to db-provision; applies the ESO leaf; **zero OpenBao writes, no `<env>-writer`**               | —                    |

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

| Env           | Posture                                                                                                                                                               |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `candidate-a` | Throwaway. A substrate-running flight cuts over in place (`migrate_owned`); reprovision also fine. Gate it. No live users to protect.                                 |
| `preview`     | Semi-live. Same-flight in-place cutover via a substrate-running promote (per node), then the gate. No manual migration step.                                          |
| `production`  | Live. Same-flight in-place cutover via a substrate-running promote in a maintenance-aware window; retire the shared role only after every node in every env is green. |

## Endgame — declarative role/DB management (roadmap, not this PR)

Hand-rolled superuser bash doing `CREATE`/`ALTER`/`GRANT` with by-hand idempotency
is the bug.5002 / bug.5031 class — every guard is a place drift hides. This PR is
the **last** hand-rolled increment; do not grow `provision.sh` further. The
convergent endgame is **declarative**: a Postgres operator
([CloudNativePG](https://cloudnative-pg.io/), CNCF) or the
[Terraform `postgresql` provider](https://registry.terraform.io/providers/cyrilgdn/postgresql/latest/docs)
reconciling desired role/DB/grant state, with ESO/Vault for credentials (already
aligned). This is to role/DB management what Atlas is to schema in
[`databases.md`](../spec/databases.md) — name it there as the SSOT roadmap item.

## Related

- [`secrets-management.md`](../spec/secrets-management.md) — Invariant 15 + DB-credential provisioning (the contract)
- [`secrets-classification.md`](../spec/secrets-classification.md) — why DB creds are per-node, not `_shared`
- [`node-wizard-secret-setting.md`](../design/node-wizard-secret-setting.md) — the node materialize/reconcile lane
- [`secrets-rotate.md`](./secrets-rotate.md) — steady-state rotation (rewrite its static-DB-rotation section once provisioners read OpenBao)
