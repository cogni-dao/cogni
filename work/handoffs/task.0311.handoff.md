---
id: task.0311.handoff
type: handoff
work_item_id: task.0311
status: active
created: 2026-04-19
updated: 2026-04-19
branch: feat/poly-knowledge-seeds-slim
worktree: /Users/derek/dev/cogni-template-slim-seeds
last_commit: f59208754
pr: 894
---

# Handoff: task.0311 — Poly Doltgres on candidate-a, k8s-Job aligned, pre-merge validation needed

## The one thing you need to know

**This PR is code-complete and self-consistent, but the pre-merge candidate-a validation was never actually run.** CI was green and pushing at hand-off time; the human dispatched `candidate-flight-infra.yml` in Step 1 of the runbook but we did not complete Steps 2–5 or run V1/V2 together. Pick up from Step 2 of the **Pre-merge candidate-a runbook** in `work/items/task.0311.poly-knowledge-syntropy-seed.md`. Every command is verbatim and copy-pasteable. You need `.local/canary-vm-key` + the `poly-test.cognidao.org` agent API.

## What shipped on this branch (PR #894)

6 commits on `feat/poly-knowledge-seeds-slim`, all pushed to `origin`. PR #894 mergeable, CI running on the latest push.

```
2bb51a6a  feat(poly-knowledge): slim protocol-fact seeds + doltgres upsert fix
4941d672  feat(doltgres): candidate-a wiring — drizzle-kit native migrator, clean-slate nodes
19e32a42  fix(doltgres): review fixes — soft image default, honest POLY_MIGRATOR_IMAGE gap
634dacaa  docs(skill): extend database-expert with Doltgres section
516c2474  docs(skill): add pg-vs-dolt split + dolt syntropy rule
f59208754  refactor(doltgres): migration is k8s PreSync Job, align 1:1 with postgres   ← final design
```

Intermediate commits (4941 + 19e3) set up a compose-based migrator that the final commit (f592) tore out in favor of a k8s PreSync Job. The net branch diff vs main is the clean k8s-Job design — squash-merge is fine.

## Net changes vs main (read before touching anything)

### Adapter + schema

- `packages/knowledge-store/src/adapters/doltgres/index.ts` — `upsertKnowledge()` now try-INSERT / catch-duplicate / fallback-UPDATE. Doltgres rejects `ON CONFLICT ... EXCLUDED`. **Don't revert.**
- `nodes/poly/packages/doltgres-schema/` — NEW workspace package (`@cogni/poly-doltgres-schema`). Mirrors `@cogni/poly-db-schema` shape. Re-exports `knowledge` from `@cogni/node-template-knowledge`. Owns Doltgres-side drizzle definitions. Has its own `AGENTS.md` with the syntropy rule.
- `nodes/poly/drizzle.doltgres.config.ts` — per-node drizzle-kit config. Schema glob is ONLY the Doltgres package (dialect separation).
- `nodes/poly/app/src/adapters/server/db/doltgres-migrations/0000_init_knowledge.sql` — checked in; byte-identical output from `pnpm db:generate:poly:doltgres`.
- `nodes/poly/packages/knowledge/src/seeds/poly.ts` — `POLY_KNOWLEDGE_SEEDS = []` (clean-slate nodes policy). The seed machinery in `scripts/db/seed-doltgres.mts` is dev-only now.
- Stripped dead `KNOWLEDGE_TABLE_DDL` / `KNOWLEDGE_INDEXES_DDL` constants from `@cogni/node-template-knowledge` + `@cogni/poly-knowledge`.

### k8s (the core refactor)

- `infra/k8s/base/poly-doltgres/` — NEW base dir: `kustomization.yaml` + `doltgres-migration-job.yaml`. Poly-specific (operator/resy don't get it). PreSync Job, mirrors `infra/k8s/base/node-app/migration-job.yaml` exactly in shape. Image name = `cogni-template-migrate` (same as the Postgres Job — poly's migrator Dockerfile carries both migration paths).
- `infra/k8s/base/node-app/external-services.yaml` — added `doltgres-external` Service + EndpointSlice (10.0.0.1 placeholder).
- `infra/k8s/overlays/candidate-a/{operator,poly,resy}/kustomization.yaml` — `doltgres-external-1` EndpointSlice patches → `84.32.109.160`.
- `infra/k8s/overlays/candidate-a/poly/kustomization.yaml` — also: `resources:` includes `../../../base/poly-doltgres`, patches `migrate-poly-doltgres` Job's secretKeyRef to `poly-node-app-secrets`.
- `infra/k8s/overlays/preview/{operator,poly,resy}/kustomization.yaml` — matching patches (IP `84.32.109.222`). Preview is in scope; production is explicitly NOT.

### Compose + deploy

- `infra/compose/runtime/docker-compose.yml` (prod) + `.dev.yml` (dev) — adds `doltgres` server + `doltgres-provision` bootstrap service. **No migrate/commit services** (that's k8s-side now).
- `infra/compose/runtime/doltgres-init/provision.sh` — simplified: `CREATE DATABASE knowledge_<node>` + roles only. No schema DDL (drizzle owns it).
- `scripts/ci/deploy-infra.sh` — derives `DOLTGRES_{PASSWORD,READER,WRITER}` from `POSTGRES_ROOT_PASSWORD` via SHA-256+salt; writes them to `.env`; brings up doltgres + runs doltgres-provision when compose has doltgres; writes `DOLTGRES_URL_POLY` to poly's k8s secret (generic `DOLTGRES_URL` for operator/resy pointing at their own `knowledge_<node>` DB). **No POLY_MIGRATOR_IMAGE env var anywhere.**

### Build

- `nodes/poly/app/Dockerfile` — migrator stage extended with Doltgres inputs (`drizzle.doltgres.config.ts`, `packages/doltgres-schema/`, `doltgres-migrations/`, and `nodes/node-template/packages/knowledge` for the re-export resolve).
- `package.json` — new scripts: `db:generate:poly:doltgres`, `db:migrate:poly:doltgres`, `db:migrate:poly:doltgres:container`. The last one chains drizzle-kit migrate + a Node post-hook (`stamp-commit.mjs`) that stamps a trailing `SELECT dolt_commit('-Am', 'migration: drizzle-kit batch')` — captures DDL into `dolt_log` per [dolt#4843](https://github.com/dolthub/dolt/issues/4843).
- `nodes/poly/packages/doltgres-schema/stamp-commit.mjs` — the post-hook. Uses `postgres` (already in node_modules via `@cogni/knowledge-store`). Tolerates only "nothing to commit" on idempotent re-runs.
- `biome/base.json` — `nodes/*/drizzle.doltgres.config.ts` in `noProcessEnv` + `noDefaultExport` overrides.
- `tsconfig.json` — new package reference (count = 31).

### Docs

- `work/items/task.0311.poly-knowledge-syntropy-seed.md` — fully rewritten. Key sections: "Postgres vs Doltgres split" invariants, migrator flow, clean-slate rationale, **"Pre-merge candidate-a runbook"** (the exact steps the next agent should execute), validation V1/V2 pass criteria, rollback.
- `.claude/skills/database-expert/SKILL.md` — extended with a Doltgres section: per-node layout, migrator pattern, two verified Doltgres caveats (extended protocol + ON CONFLICT), Postgres-vs-Doltgres split ("first question for any new table"), Doltgres syntropy rule (prevent exponential-entropy via per-domain tables), 6 new anti-patterns.
- `nodes/poly/packages/doltgres-schema/AGENTS.md` — local syntropy rule: "before adding a new table here, answer all three questions."

## What's validated locally

- Test 1: `CREATE SCHEMA drizzle` + `drizzle.__drizzle_migrations` tracking table — **PASS on Doltgres 0.56.0**
- Test 2: `drizzle-kit migrate --config=nodes/poly/drizzle.doltgres.config.ts` against a fresh `knowledge_poly_test3` — **PASS**, creates `public.knowledge` with all 10 columns + 3 indexes, idempotent on re-run
- Test 3: Trailing `SELECT dolt_commit(...)` captures DDL into `dolt_log` — **PASS**
- `pnpm packages:build` — all 31 packages (incl. `@cogni/poly-doltgres-schema`)
- `pnpm check:docs` — 621 files OK
- `pnpm check:fast` (pre-push) — PASS
- `kubectl kustomize` renders all 6 overlays (candidate-a + preview × 3 nodes) — poly gets 2 Jobs (Postgres + Doltgres), operator/resy get 1 (Postgres only). All have `{node}-doltgres-external` EndpointSlices.
- `docker compose --profile bootstrap config --services` — lists 2 doltgres services (server + provision, no migrator in compose).

## RBAC verdict — why the knowledge plane runs as the superuser (2026-06-09, pinned `0.56.3`)

The follow-up here (and `deploy-infra.sh`'s "0.56 RBAC non-functional" comment) was independently re-proven against the **currently pinned `dolthub/doltgresql:0.56.3`** image. A fresh non-superuser `knowledge_<node>` role: `CREATE ROLE … LOGIN` + `GRANT` all succeed, but `SELECT current_user` / `count()` → `permission denied for routine … (errno 1105 / sqlstate HY000)` and **no** `GRANT EXECUTE` (to the role or `PUBLIC`, retried) lifts it; `ALTER DEFAULT PRIVILEGES … is not yet supported`; a role is denied `INSERT`/`SELECT` on a table it just created until a superuser re-`GRANT`s; `pg_roles` is empty. Root cause is documented: Doltgres implements **only the five table-level DML privileges, only for tables** ([DoltHub "Doltgres Now Supports Users", 2024-11-07](https://www.dolthub.com/blog/2024-11-07-doltgres-supports-users/); [Dolt Access Management](https://docs.dolthub.com/sql-reference/server/access-management)) — no function `EXECUTE`, schema/`CREATE`, default-privileges, or role membership. **Not a Cogni defect, no bug filed.** Canon: [databases.md §5.2](../../docs/spec/databases.md).

**Explicit trigger:** when Doltgres implements function/schema/role privileges, swap `DOLTGRES_PASSWORD` to a per-node `source: agent` value and compose `DOLTGRES_URL` with a `knowledge_<node>` role — **no secrets-pipeline change** (the pipeline is already OpenBao-sole-source per secrets-management Invariant 15; only the credential value-shape differs).

## What's NOT validated (the next agent's job)

**Pre-merge candidate-a end-to-end.** Steps 2–5 + V1 + V2 of the runbook in task.0311 have not run. Human dispatched flight-infra (Step 1). Everything else is pending.

## How to pick this up — short version

1. Open `work/items/task.0311.poly-knowledge-syntropy-seed.md` → jump to **"Pre-merge candidate-a runbook"**
2. Confirm Step 1 (flight-infra) completed (should be visible in `gh run list --workflow=candidate-flight-infra.yml`)
3. Execute Steps 2–5 verbatim. Every command has `.local/canary-vm-key` SSH as the entry point.
4. Run V1 (infra proof). If any step fails, see the "If any fail, fix in branch" verdict in the runbook — cost of branch-fix is MUCH lower than post-merge fix because a failing PreSync Job on `deploy/candidate-a` can stall Argo reconciliation for other apps.
5. Run V2 (agent API proof): `/api/v1/agent/register` → `/api/v1/chat/completions` with `graph_name: brain` → first turn asks brain to write, second turn asks brain to recall. The agent-api-validation guide at `docs/guides/agent-api-validation.md` has the shape.
6. If V1 + V2 both pass: squash-merge PR #894 → post-merge candidate-a/preview flights are hands-off via Argo (the whole point of the k8s-Job refactor).

## Known gotchas / surprises

- **VM namespace drift**: both `cogni-canary` (13d old, legacy) and `cogni-candidate-a` (9d old) exist on the VM. Target is `cogni-candidate-a` (matches the overlay). Don't accidentally patch the canary secret.
- **Dolt `DROP SCHEMA CASCADE` is not supported** (per the 0.56.0 error). If cleanup needs to drop the `drizzle` schema, drop tables first, then DROP SCHEMA.
- **The poly migrator image carries both migration paths.** Kustomize overlays already have a `cogni-template-migrate` entry pinning a digest; my new Doltgres Job reuses that same entry. The image built from `nodes/poly/app/Dockerfile AS migrator` on THIS branch has both migration sources; main's migrator image does NOT have the Doltgres sources, so if candidate-a's overlay on `deploy/candidate-a` currently points at a main-era migrator digest, the Doltgres Job will fail with "config file not found." Fix: candidate-flight.yml would promote this branch's migrator digest before Argo runs the Job — but pre-merge, we bypass that and apply the branch's overlay directly (Step 4 uses branch-pinned digests from `nodes/poly/app/Dockerfile` via the kustomize `images:` block). **Verify the kustomize-rendered Job spec shows a digest built from this branch**, not main-era.
- **Agent API registration shortcoming**: per `docs/guides/agent-api-validation.md`, `graph_name` is REQUIRED in completions for newly-registered machine actors (no virtual key yet). Always pass `graph_name: brain` in V2.

## Files to know by heart

| Path                                                          | Why                                                      |
| ------------------------------------------------------------- | -------------------------------------------------------- |
| `work/items/task.0311.poly-knowledge-syntropy-seed.md`        | The runbook + design history                             |
| `infra/k8s/base/poly-doltgres/doltgres-migration-job.yaml`    | The PreSync Job definition                               |
| `nodes/poly/packages/doltgres-schema/stamp-commit.mjs`        | The trailing dolt_commit hook                            |
| `scripts/ci/deploy-infra.sh` (L647-668 + L779-796 + L912-921) | Secret derivation + compose bootstrap + k8s secret patch |
| `.claude/skills/database-expert/SKILL.md`                     | Postgres-vs-Doltgres split + Doltgres syntropy rule      |
| `nodes/poly/packages/doltgres-schema/AGENTS.md`               | Local enforcement of syntropy at point-of-change         |

## Follow-ups explicitly filed (NOT in this PR)

1. Brain-authored knowledge loop — `core__knowledge_write` + promotion gate at 10–30% confidence
2. DoltHub delivery (spike.0318 → task.0319)
3. Align `DOLTGRES_URL` → `DOLTGRES_URL_{OPERATOR,RESY}` for per-node env consistency
4. Backups (follow Postgres WAL-G path when `proj.database-ops` lands)
5. `@cogni/{operator,resy}-doltgres-schema` packages when those nodes adopt Doltgres
6. Production overlay — deliberately deferred (prod VM provisioning + backups + rollback rehearsal gate)

## Rollback

If anything breaks between Steps 2–5, see the "Rollback" section at the end of the task.0311 runbook. Single-paragraph summary: `kubectl delete job`, patch the secret to remove `DOLTGRES_URL_POLY`, rollout-restart poly, `docker compose stop doltgres`. Postgres + app untouched; knowledge tools go dark (Zod treats the URL as optional).

## Related

- PR #894: https://github.com/Cogni-DAO/cogni/pull/894
- Task: `work/items/task.0311.poly-knowledge-syntropy-seed.md`
- Skill: `.claude/skills/database-expert/SKILL.md`
- Agent API guide: `docs/guides/agent-api-validation.md`
- Multi-node tenancy: `docs/spec/multi-node-tenancy.md` (`DB_PER_NODE` invariant)
- Per-node Postgres precedent (task.0324, #916): `work/items/task.0324.per-node-db-schema-independence.md`
