---
id: guide.vm-secrets-repair
type: guide
title: VM Secrets Repair — DB Credentials into OpenBao
status: draft
trust: draft
summary: "Per-env runbook to move shared DB credentials off VM .env into OpenBao (the SSOT) so node materialize/reconcile can run OpenBao-only, closing the bug.5002 split-brain. Covers candidate-a, preview, production."
read_when: "Repairing an environment whose DB credentials still live in VM runtime/.env, flipping deploy-infra to read OpenBao, or running the falsifying gate for the node-wizard secret lane."
owner: cogni-dev
created: 2026-06-09
verified: 2026-06-09
spec_refs:
  - ../spec/secrets-management.md
  - ../spec/node-baas-architecture.md
related:
  - ../design/node-wizard-secret-setting.md
---

# VM Secrets Repair — DB Credentials into OpenBao

## Why this exists

The node-wizard secret lane (`secret-materialize` → read-only `reconcile-substrate`
→ `assert-substrate`) requires **OpenBao to be the single source of truth for DB
credentials** (`secrets-management.md` Invariant 15). Today the shared Postgres
superuser and app DB passwords still live **only in VM `/opt/cogni-template-runtime/.env`**
(`reconcile-secrets.sh::COMPOSE_ONLY_KEYS`), and `deploy-infra.sh` _derives_
`DOLTGRES_*` / `APP_DB_READONLY_PASSWORD` in-script (`deploy-infra.sh:836-860`).
A value that lives only on the VM, or is recomputed in a deploy script and never
written to OpenBao, is a **parallel store** — the same drift class that caused the
candidate-a 2026-06-04 cluster outage (bug.5002).

This repair makes each environment OpenBao-authoritative for DB creds. It is the
**env-genesis half** of the node-wizard secret work; the node half (per-node
`secret-materialize`, read-only reconcile) lands in PR #1582 and assumes this
repair is done.

> Scope split (node-baas-architecture.md): **each node owns its own DB + secrets**.
> The only env-level shared DB value is the **Postgres superuser**
> (`POSTGRES_ROOT_PASSWORD`), which provisioners use to create each node's DB +
> roles. This repair owns that shared superuser; per-node creds are not in scope
> here.

## Target end state (all envs)

1. `cogni/<env>/_shared` holds the env-level shared DB substrate in OpenBao:
   - `POSTGRES_ROOT_PASSWORD` (the Postgres superuser).
2. `DOLTGRES_PASSWORD`, `DOLTGRES_READER_PASSWORD`, `DOLTGRES_WRITER_PASSWORD`,
   `APP_DB_READONLY_PASSWORD` are **materialized into OpenBao** (derived once from
   `POSTGRES_ROOT_PASSWORD` using the existing `derive_secret` algorithm), not
   recomputed on every deploy.
3. `deploy-infra.sh` / `db-provision` / `doltgres-provision` **read** every DB
   password from OpenBao via the `<env>-db-reader` token and create each role
   **set-once**. They derive nothing and read nothing from `.env`.
4. DB passwords are **removed from GitHub Environment secrets** (a parallel store).
5. Falsifying gate passes (below).

## The one non-negotiable safety rule

**Never regenerate an existing DB password.** The live Postgres/Doltgres data dirs
already authenticate against the _current_ values in VM `.env`. Writing a _fresh_
random `POSTGRES_ROOT_PASSWORD` (or app password) into OpenBao and then creating /
reading roles from it diverges from the live DB → `28P01 password authentication
failed` → `/readyz` "infrastructure unreachable" → 502.

For an existing env you **import the current value** from VM `.env` into OpenBao
**once**, preserving it. You never `ALTER … PASSWORD` to a new value, and you never
let `db-provision` "self-heal" a role password from a rendered `.env` (the bug.5002
anti-fix).

## Per-env procedure

Order: **candidate-a first** (throwaway; reprovision is allowed), then **preview**,
then **production** (live; maintenance-aware).

### Step 0 — Inventory current truth (read-only, never echo values)

On the env VM:

```bash
# what the live runtime actually uses (key NAMES + presence only)
ssh root@$VM_HOST "grep -oE '^(POSTGRES_ROOT_PASSWORD|APP_DB_PASSWORD|APP_DB_SERVICE_PASSWORD|APP_DB_READONLY_PASSWORD|DOLTGRES_PASSWORD)=' /opt/cogni-template-runtime/.env | sort -u"

# what OpenBao already holds at the env-shared path (names only)
ssh root@$VM_HOST "kubectl exec -n openbao openbao-0 -- env BAO_ADDR=http://127.0.0.1:8200 \
  bao kv get -format=json cogni/<env>/_shared 2>/dev/null | jq -r '.data.data | keys[]'"
```

If `POSTGRES_ROOT_PASSWORD` is already in `cogni/<env>/_shared` and equals the live
DB, this env is partly repaired — skip the import for that key.

### Step 1 — Import the existing superuser into OpenBao (preserve, never regenerate)

Mint the writer token and `patch` (not `put`-overwrite) the **current** value:

```bash
ssh root@$VM_HOST 'set -euo pipefail
  jwt=$(kubectl create token openbao-operator -n default)
  TOKEN=$(kubectl exec -n openbao openbao-0 -- env BAO_ADDR=http://127.0.0.1:8200 \
    bao write -field=token auth/kubernetes/login role="<env>-writer" jwt="$jwt")
  ROOT=$(awk -F= "/^POSTGRES_ROOT_PASSWORD=/{print substr(\$0,length(\"POSTGRES_ROOT_PASSWORD=\")+1)}" /opt/cogni-template-runtime/.env | tail -1)
  [ -n "$ROOT" ] || { echo "::error::no POSTGRES_ROOT_PASSWORD in VM .env"; exit 1; }
  printf "%s" "$ROOT" | kubectl exec -i -n openbao openbao-0 -- env BAO_TOKEN="$TOKEN" BAO_ADDR=http://127.0.0.1:8200 \
    bao kv patch cogni/<env>/_shared POSTGRES_ROOT_PASSWORD=-'
```

This must be **captured in a script** (e.g. `scripts/setup/import-env-db-secrets.sh
<env>`), not run as a one-off SSH command — reproducibility is non-negotiable. The
snippet above is the algorithm; commit it.

### Step 2 — Materialize the derived DB passwords into OpenBao

Derive the 4 (`DOLTGRES_PASSWORD`, `DOLTGRES_READER_PASSWORD`,
`DOLTGRES_WRITER_PASSWORD`, `APP_DB_READONLY_PASSWORD`) from the now-OpenBao-owned
`POSTGRES_ROOT_PASSWORD` using the **exact existing algorithm** (`reconcile-secrets.sh:98`
`derive_secret`: `sha256_hex("<salt>:$POSTGRES_ROOT_PASSWORD")[:32]`, salts
`doltgres-root` / `doltgres-reader` / `doltgres-writer` / `postgres-readonly`) and
`patch` them into `cogni/<env>/_shared`. Because the algorithm + root are unchanged,
the derived values equal what the live roles already use — no role churn.

### Step 3 — Flip provisioners to read OpenBao (remove the derivation + .env fallback)

In `deploy-infra.sh` / `db-provision` / `doltgres-provision`:

- read each DB password from `cogni/<env>/_shared` via a `<env>-db-reader` token
  (`secrets-management.md` Invariant 13 / DB roadmap Phase 1 mints this read-only
  JWT on the deploy host);
- delete the `derive_secret` block (`deploy-infra.sh:836-860`) and the
  `${X:-$(remote_env_value …)}` `.env` fallbacks;
- on an OpenBao read failure, **fail loud and skip the role create** — never fall
  back to `.env` (the bug.5002 anti-fix).

### Step 4 — Remove DB passwords from GitHub Environment secrets

Once OpenBao is authoritative, delete `POSTGRES_ROOT_PASSWORD` / `APP_DB_*_PASSWORD`
/ `DOLTGRES_*_PASSWORD` from the `<env>` GitHub Environment so no parallel store can
re-diverge a deploy.

### Step 5 — Falsifying gate (proves split-brain is dead)

```bash
# remove the .env copy so .env can no longer be the source
ssh root@$VM_HOST "sed -i.bak '/^APP_DB_PASSWORD=/d' /opt/cogni-template-runtime/.env"
# run the node lane and a deploy; prove the app comes up green from OpenBao only
```

Pass = the env's apps reach `/readyz` healthy and `/version` serves with
`APP_DB_PASSWORD` absent from `.env`. Capture the proof (Loki shows the
`<env>-db-reader` subject reading `cogni/<env>/*`; no `28P01`).

## Per-env notes

| Env           | Posture                                                                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `candidate-a` | Throwaway. Easiest path is a **reprovision** with the repaired `provision-env-vm.sh` (which seeds the superuser to OpenBao at genesis), then run the gate. No live users to protect. |
| `preview`     | Semi-live. Do the **import** path (Steps 1–5), not a reprovision; preserve the existing superuser.                                                                                   |
| `production`  | Live. Import path only, in a maintenance-aware window. Double-check Step 0 shows OpenBao == live before Step 3 flips the read path. Have the rollback ready.                         |

## Rollback

If a deploy goes red after Step 3, the fix is **align the source, never overwrite
the DB**: confirm `cogni/<env>/_shared:POSTGRES_ROOT_PASSWORD` equals the live DB
(Step 0), re-import if it drifted, and re-run. Do **not** `ALTER` the DB role to a
rendered `.env` value — that is the bug.5002 anti-fix and converts a silent
mismatch into an active outage.

## Capture in git

Every step that mutates a VM must land as a committed script + a provisioner change,
not an SSH one-off (`feedback_vm_edits_need_git_capture`). Deliverables:

- `scripts/setup/import-env-db-secrets.sh <env>` (Steps 1–2, idempotent, patch-only);
- `deploy-infra.sh` / provision diffs (Step 3);
- the gate proof posted to the env-repair PR.
