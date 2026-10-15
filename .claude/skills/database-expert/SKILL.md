---
name: database-expert
description: Cogni database architecture and operations router. Use for PostgreSQL environment residency, database-per-node boundaries, secret custody versus data placement, shared/dedicated cells, noisy neighbors, role/pool budgets, DATABASE_URL or DOLTGRES_URL, migrations, backups, restore proof, database health, and database knowledge drift.
---

# database-expert

Route to the owning contract and current evidence; do not maintain a second architecture manual here. Reliability, uptime, and observability are the operating priorities.

## Recall before acting

1. Identify the owning node, workload environment, requested action, and exact source/deployed revisions. A control cluster or secret custodian is not a database placement decision.
2. Read the applicable executable contract below. Recall the corresponding hub entry through the current node's authenticated `/api/v1/knowledge/{id}`; discover related entries through `/api/v1/knowledge/index?q=<situation>`.
3. Inspect merged knowledge **and** relevant open contribution diffs before refining guidance. Pending designs are proposals, not deployed facts. If hub prose disagrees with current code/specs, disclose the conflict and refine the stale source through [contribute-knowledge-to-cogni](../contribute-knowledge-to-cogni/SKILL.md); never silently adopt the stale instruction.
4. Read current catalog/repo-spec placement and live evidence for operational claims. Fleet counts, provider rosters, thresholds, pinned engine limitations, and incident status do not belong in this router.

## Canonical routing

| Question                                                    | Read first                                                                                                                                   |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Product and ownership north star                            | [Node BaaS substrate model](https://cognidao.org/knowledge/node-baas-substrate-model)                                                        |
| Postgres residency, roles, budgets, cell lifecycle, backups | [Database contract](../../../docs/spec/databases.md#database-placement-and-budgets)                                                          |
| Lane identity versus reconciliation/payment/secret custody  | [Lane vs control env](../../../docs/spec/node-ci-cd-contract.md#lane-vs-control-env); hub `lane-is-not-control`, `lane-db-two-derivations`   |
| Database-per-node and shared/dedicated tenancy              | [Multi-node tenancy](../../../docs/spec/multi-node-tenancy.md); hub `noisy-neighbor-database-architecture` (check current reviewed revision) |
| Explicit DSNs and RLS                                       | [URL alignment](../../../docs/spec/database-url-alignment.md), [RLS](../../../docs/spec/database-rls.md)                                     |
| Schema ownership, generation, journals, migration delivery  | [schema-update](../schema-update/SKILL.md), then the owning node repo's schema/migration contracts                                           |
| Doltgres knowledge, work items, provenance                  | [Knowledge data plane](../../../docs/spec/knowledge-data-plane.md); hub `knowledge-contribution-flow`                                        |
| Secrets, rotation, projection, CAS                          | [cicd-secrets-expert](../cicd-secrets-expert/SKILL.md)                                                                                       |
| Substrate implementation boundary and CI/CD                 | [Platform boundary](../../../docs/spec/cicd-platform-boundary.md), [devops-expert](../devops-expert/SKILL.md)                                |
| Node-scoped data access                                     | Hub `node-data-support-plane`; [substrate access](../../../docs/spec/substrate-access-grant.md)                                              |
| Placement/session evidence versus logs                      | Hub `operator-topology-direct-reads`, `node-service-logs-read`, `operator-infra-logs-read`                                                   |
| Crash attribution, shared pressure, diagnostic auth         | Hub `prod-oom-misdiagnosis-taxonomy`, `control-plane-self-starvation`, `postgres-crash-observability`, `grafana-postgres-auth-drift`         |

Do not replace the skill with a pointer to an unmerged entry or merge your own knowledge contribution. Unmigrated specs retain their contracts; the hub owns rationale and evolving guidance.

## Placement and authority guardrails

- **Postgres follows the workload environment.** Candidate-a uses candidate-a Postgres, preview uses preview Postgres, production uses production Postgres. Shared-tier derivation is `lane_db_vm_env` / `lane_db_host` in `scripts/ci/lib/lane-db-residency.sh`; `lane_db_assert_agreement` checks app/service/migration DSNs. Missing or mismatched identity fails closed.
- **Shared means within one environment.** One logical database per node is the schema/security/migration boundary, not CPU, memory, I/O, host, or storage isolation. A suffixed database on production is not a nonproduction failure domain; quotas never waive that residency rule.
- **Custody is independent.** The production operator may custody a nonproduction lane's secrets and project only the authorized lane credentials down-trust. That does not move the database to production, grant nonproduction access to production secrets, or authorize a new cross-host secret-copy mechanism.
- **Tier is a separate axis.** Meter, bound, observe, admit, and graduate shared tenants under the current reviewed policy. A dedicated cell's state lifetime and recovery authority are separate from stateless app lease replacement. Follow its reviewed placement/cutover/retention contract; do not invent a parallel provider plane.
- **Other services need separate proof.** PostgreSQL residency does not establish Doltgres, Redis, Temporal, LiteLLM, or control-plane isolation. Read each declared dependency and report unresolved failure domains explicitly.
- **Roles are node-scoped.** Deployed runtime identities are exact `app_<normalized_slug>` and `service_<normalized_slug>`, database `cogni_<normalized_slug>`; rollout uses separate `migration_<normalized_slug>`. Local historical `app_user` / `app_service` examples are not deployed-role fallbacks.
- **Bounds are not interchangeable.** On PostgreSQL 15, `CONNECTION LIMIT` is a hard role cap and properly provisioned `temp_file_limit` is a privileged per-backend cap. `statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout`, and `work_mem` are overridable fresh-session defaults, not hard tenant ceilings. Pool budgets include the separate service/read pools, job leader, and replica count.
- **Preserve containment.** Routine provisioning, password reconciliation, budgets, and deployment do not restore `LOGIN`. Readmission is a separate audited, human-gated capability; its credential and containment credential are not interchangeable.
- **Desired is not implemented.** Read catalog/schema support before promising external/BYO DSNs, configuration-only provider swaps, or any pending tenancy design. Do not overwrite a reviewed dedicated-cell binding with the shared-tier default.

## Placement proof is not a log search

1. Bind the observation to environment, server endpoint/native cluster identity, database, exact runtime roles, and current build. Use node-scoped operator surfaces; `pg_stat_activity` is server-wide, so filter before attributing.
2. Read actual `pg_stat_database.numbackends` and app/service `pg_stat_activity` on the lane-owned instance. Exclude exporters, support readers, migrations, and your diagnostic connection from application proof. An idle pool can be zero: exercise one legitimate database-backed request and reread, rather than manufacturing a probe session.
3. For a residency repair, prove the exact retired databases and all applicable nonproduction backend/session identities are absent on production. Absence of matching logs is not proof of zero backends.
4. Correlate native migration/controller events, scoped runtime logs, request IDs and public `/version.buildSha` at the same revision. CI asserts intent; a green workflow or generic readiness log alone does not prove feature behavior.
5. Discover log labels and verify stream attachment/window before interpreting silence. A shared-control component's cluster label can differ from the workload lane. A missing log stream is unknown, not healthy.
6. Grafana `app_readonly` `28P01` is diagnostic credential failure, not application authentication failure. Do not silently switch databases, rotate fleet credentials, or assume the operator datasource still works. Report the diagnostic gap and follow only an explicitly authorized scoped recovery/break-glass path.

## Schema, migration, and recovery routing

- Operational/system-of-record data belongs in Postgres; versioned agent knowledge, work items, and evidence belong in Doltgres. Domain specificity usually belongs in generic knowledge rows, not a table per topic. Load schema-update before any schema/migration edit.
- A node owns its repo's schema and immutable migration history. Shared package changes follow the current package/adoption contract; do not blindly copy journals across independent repositories or regenerate deployed history.
- Runtime and migration paths require explicit DSNs. Prove the declared migration step, immutable app/runtime digest, terminal execution receipt, tracking journal, and expected schema. A declared step is not an applied migration.
- Doltgres uses its own declared migration command and verifier from the same runtime artifact. Prove the committed Dolt history where required. PostgreSQL-wire compatibility does not imply PostgreSQL permissions, SQL semantics, parameter settings, or restore-tool compatibility; check the deployed engine/version and current adapter rather than freezing old limitations here.
- A dump success message, checksum, or same-host volume is not disaster recovery. Prove database coverage, a readable complete archive, off-host retention, native-major-compatible tooling, and a restore drill at representative size with measured RPO/RTO.
- Follow the current audited cutover contract. Preserve the original source fence, never dual-write, and never reopen a stale source after target writes merely by reversing a DSN. Rollback requires proven current data and version-owned credential changes.

## Safe operating posture

Prefer causal evidence and bounded node-local changes: query/write shape and indexes, exact role/pool budgets, then reviewed structural graduation. Global engine tuning and larger shared VMs do not establish tenant isolation.

No routine production SSH, environment-wide developer credentials, ad-hoc database writes, implicit migrations, or new shell/YAML control planes. Governed emergency authority is an explicit, target-pinned exception—not a reusable product workflow. Keep live rollout status and incident receipts in work items, and reusable refinements in the reviewed knowledge inbox.
