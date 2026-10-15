---
id: database-url-alignment-spec
type: spec
title: Database URL Alignment — DSN Single Source of Truth
status: active
spec_state: active
trust: reviewed
summary: Explicit app/service DSNs and an isolated rollout migration DSN agree with the lane-owned database; provisioning credentials stay outside applications.
read_when: Working with database connection strings, provisioning, migration secrets, or container env configuration.
owner: derekg1729
created: 2026-02-06
verified: 2026-10-15
tags: [infra, deployment]
---

# Database URL Alignment — DSN Single Source of Truth

## Goal

Keep node runtime, rollout and administrative credentials separate while every PostgreSQL DSN agrees with the workload's declared database placement.

## Non-Goals

- Introducing another provisioner, credential writer, rotation path or deployment workflow.
- Treating PostgreSQL residency as proof of Doltgres, Redis or Temporal isolation.

## Design

### Credential contract

Applications receive explicit connection strings, never provisioning credential components. PostgreSQL runtime and migration identities are distinct. Secret custody does not choose database residency.

| Credential | Role | Consumer |
| --- | --- | --- |
| `DATABASE_URL` | `app_<normalized_slug>`, RLS enforced | application request paths |
| `DATABASE_SERVICE_URL` | `service_<normalized_slug>`, BYPASSRLS | authorized system/worker paths |
| `DATABASE_MIGRATION_URL` | `migration_<normalized_slug>`, isolated rollout identity | PostgreSQL migration only |
| Provisioning root/component inputs | administrative identity | authorized provisioning, never an app credential |

Historical local-development `app_user` and `app_service` examples are not fallbacks for deployed node roles. See [database role and placement contracts](databases.md#database-placement-and-budgets).

## Invariants

1. **EXPLICIT_DSN_ONLY:** Runtime clients receive their declared DSN variables. They do not reconstruct a URL from `APP_DB_*` / `POSTGRES_ROOT_*`, silently substitute another credential, or default a missing database host.
2. **ROLE_ISOLATION:** App and service usernames differ, neither is an administrative superuser, and the PostgreSQL migration credential is isolated from ordinary runtime containers. Local provisioning inputs and root DSNs never cross that application boundary.
3. **MIGRATION_INPUT_IS_NOT_RUNTIME_AUTHORITY:** The existing migrator reads an environment variable named `DATABASE_URL`, but rollout supplies its value from the separate `DATABASE_MIGRATION_URL` secret. The variable name does not authorize using the runtime app credential.
4. **RESIDENCY_AND_IDENTITY_AGREE:** Stored app, service and migration DSNs must resolve to the same expected lane-owned host/database through `lane_db_assert_agreement`. Shared-tier placement uses `lane_db_vm_env` / `lane_db_host`. A reviewed dedicated-cell binding follows its own lifecycle and cannot be replaced by a shared-tier fallback.
5. **CUSTODY_IS_NOT_PLACEMENT:** The production operator may custody an authorized nonproduction lane's secrets without hosting that lane's database. Projection stays lane/node scoped and down-trust. Missing or mismatched identity fails closed rather than selecting the custodian's instance.
6. **NO_SECRET_VALUES_IN_EVIDENCE:** Diagnostics and CI may report credential names, host/database agreement and authentication outcomes, never password-bearing DSNs or privileged secret contents.
7. **PROVISIONING_PRESERVES_CONTAINMENT:** Credential reconciliation and ordinary deployment preserve existing `NOLOGIN`. Readmission is a separate audited capability, not a password-rotation side effect.

## Rollout mapping

| Surface | PostgreSQL migrator input |
| --- | --- |
| Kubernetes `migrate` init container | `DATABASE_URL` from `migration-secrets.DATABASE_MIGRATION_URL` |
| Akash/Crossplane declared `migrate` step | `databaseUrlSecretKey: DATABASE_MIGRATION_URL`, mapped to the migrator's `DATABASE_URL` |
| Ordinary application container | app/service DSNs; no isolated migration credential |
| Authorized provisioner | existing environment-scoped administrative inputs; no root credential exported to the workload |

Migrations execute from the same immutable runtime artifact as the app, using the node's declared command/layout. Doltgres is a separate engine and declared phase using `DOLTGRES_URL`; the PostgreSQL per-role contract does not claim equivalent Doltgres permissions or environment isolation.

## Ownership

- The sole materializer composes and reconciles node-scoped credentials through the existing OpenBao/ESO path.
- Provisioning creates/updates the target database and roles through that same lane-aware identity derivation.
- Runtime pools consume only their declared credentials. They do not create or repair administrative roles.
- Rotation of an admitted dedicated target follows the version-owned cutover/CAS contract; no independent fallback writer may rebind it.

Component inputs used by local Compose or authorized infrastructure provisioning remain outside application containers. This contract does not claim a speculative root-DSN-only provisioner is implemented.

## Verification

- Read actual secret **references**, not values: the app/service projection and migration projection are distinct.
- Assert equality of resolved host/database for all three stored PostgreSQL credentials, plus the exact expected role names.
- Exercise missing migration identity and foreign-host negative cases; they must fail closed.
- Prove migrations by terminal execution receipt, tracking journal and expected schema, then exercise database-backed behavior at the deployed SHA.
- Prove runtime residency with native database/session evidence. Green CI, a successful materialization log or log silence alone is insufficient.

## Executable sources

| Source | Owns |
| --- | --- |
| `scripts/ci/lib/lane-db-residency.sh` | lane-owned shared PostgreSQL derivation and DSN agreement |
| `scripts/ci/secret-materialize.sh` | node-scoped app/service and isolated migration credential materialization |
| `scripts/ci/assert-target-substrate.sh` | fail-closed lane/credential substrate assertions |
| `nodes/operator/app/src/features/compute/compute-workload-secret-manifests.ts` | separate runtime and migration ExternalSecret projections |
| `nodes/operator/app/src/features/compute/akash-tx/akash-tx-migration-step.ts` | declared migration secret-key selection and execution |
| `infra/k8s/base/node-app/deployment.yaml` | isolated migration credential mapped to the init container input |

## Related

- [Databases](databases.md) — role budgets, migrations, backups and cell lifecycle
- [Node CI/CD contract](node-ci-cd-contract.md#lane-vs-control-env) — workload lane versus control authority
- [Database RLS](database-rls.md) — runtime dual-client authorization semantics
- [Secrets management](secrets-management.md) — custody, projection and rotation
