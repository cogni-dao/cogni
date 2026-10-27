---
name: dolthub-local-clone
description: Clone a Cogni knowledge repo from DoltHub and read it locally, WITHOUT the operator/node being live. Use to recover, audit, diff, or verify a node's knowledge hub straight from its DoltHub mirror (`cogni-dao/<slug>`) — operator down, confirming a `dolt_push` landed, bootstrapping a fork, offline archaeology. Triggers: "clone our dolthub", "read the knowledge repo locally", "recover the hub", "verify the push", "dolt clone fails with table has unknown fields", "doltgres clone".
---

# dolthub-local-clone

Read any Cogni knowledge hub straight from its DoltHub mirror, with no running node.

Our hubs are **Doltgres** (Postgres-wire Dolt). The plain `dolt` CLI cannot read them — clone with the `doltgresql` engine instead.

## Recipe (copy-paste, proven)

Prereqs: Docker. Public repos read without creds; private/push needs `~/.dolt/creds/<keyid>.jwk` + `user.creds` in `~/.dolt/config_global.json`.

```bash
REPO=cogni-dao/operator      # <owner>/<slug> — the derived mirror (no "knowledge-" prefix)
VER=0.57.3                    # MUST match the fleet's doltgres (infra/compose/runtime/docker-compose.yml)

# 1. Throwaway Doltgres engine. Set BOTH USER and PASSWORD (password-only fails auth).
docker run -d --name hub-read -p 5433:5432 \
  -e DOLTGRES_USER=doltgres -e DOLTGRES_PASSWORD=readpw \
  -v "$HOME/.dolt:/root/.dolt:ro" \
  dolthub/doltgresql:$VER
sleep 12

Q(){ docker run --rm --link hub-read -e PGPASSWORD=readpw postgres:16 \
       psql -w "postgresql://doltgres@hub-read:5432/$1?sslmode=disable" -tAc "$2"; }

# 2. Clone — SELECT, not CALL. Creates a db named after the repo (e.g. "operator").
Q doltgres "SELECT DOLT_CLONE('$REPO');"

# 3. Read. Tables: knowledge, domains, citations, work_items, sources,
#    knowledge_contributions, knowledge_contribution_commits.
Q operator "SELECT id, title FROM knowledge ORDER BY updated_at DESC LIMIT 20;"
Q operator "SELECT substring(content::text from 1 for 4000) FROM knowledge WHERE id='operator-agent-orientation';"
Q operator "SELECT LEFT(commit_hash,10), message FROM dolt_log ORDER BY date DESC LIMIT 10;"

docker rm -f hub-read      # 4. clean up
```

## Three gotchas that will bite you

1. **Pin the engine to the fleet version.** `dolthub/doltgresql:0.57.3` reads today's data; **v1.0.0 canNOT read 0.57.3-format data** (`could not find root value: main` — the on-disk format diverged; NOT corruption). Match the fleet.
2. **Read large text with `substring(content::text from 1 for N)`.** On 0.57.3, `LEFT(content,…)` panics and a bare `SELECT content` returns `context canceled` on big text columns. The `::text` cast + `substring` avoids it. Presence checks (`WHERE content LIKE '%…%'`) always work.
3. **Set `DOLTGRES_USER` AND `DOLTGRES_PASSWORD`.** Password alone → `password authentication failed`.

## Health triage in one call (no clone)

```bash
curl -s "https://www.dolthub.com/api/v1alpha1/cogni-dao/operator/main" | jq -r .query_execution_message
```

| Response                                      | Meaning                                          |
| --------------------------------------------- | ------------------------------------------------ |
| `doltgres data is not supported`              | ✅ **Healthy** — clone it with the recipe        |
| `table has unknown fields` (from **web-SQL**) | 🔴 **Corrupted** — a chunk is missing/unwalkable |
| `branch not found` / `no such repository`     | Empty / nonexistent — nothing pushed yet         |

> Same string, opposite meaning: `table has unknown fields` from the **`dolt` CLI** = healthy-but-wrong-tool; from **web-SQL** = corrupted.

## Reseed a stale local **dev** doltgres from the hub

When local dev proof is blocked because your `knowledge_<node>` DB is on an old
schema (e.g. `entry_type` missing) and `pnpm db:migrate:<node>:doltgres` errors,
do **not** fight the migration. The local dev doltgres engine is the **same
`0.57.3`** as the fleet (`infra/compose/runtime/docker-compose.dev.yml`), so you
can clone the current hub schema **plus real rows** straight into your running
dev volume. Proven 2026-10-27 for `operator` (empty 10-col `knowledge` → full
17-col schema + 300 rows).

```bash
# Against the RUNNING dev doltgres (port 5435, DOLTGRES_PASSWORD from .env.local).
Q(){ PGPASSWORD=doltgres psql -h localhost -p 5435 -U postgres -d "$1" -tAc "$2"; }

# 1. Drop the stale DB (dev only; back up first if it holds local-only work).
Q postgres "DROP DATABASE knowledge_operator;"

# 2. Clone the hub INTO the name the app's DSN expects (DOLT_CLONE takes a target name).
Q postgres "SELECT DOLT_CLONE('cogni-dao/operator', 'knowledge_operator');"

# 3. Re-apply the reader/writer grants from provision.sh (roles already exist).
Q knowledge_operator "GRANT USAGE ON SCHEMA public TO knowledge_reader"
Q knowledge_operator "GRANT USAGE ON SCHEMA public TO knowledge_writer"
Q knowledge_operator "GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO knowledge_writer"

# 4. Verify. DOLTGRES_URL_OPERATOR already points at knowledge_operator — no .env change.
Q knowledge_operator "SELECT count(*) FROM knowledge;"
```

Gotcha: as `knowledge_writer`, `count()` is denied on a freshly cloned DB until
`GRANT EXECUTE ON ALL FUNCTIONS` — step 3 above (plain `SELECT`s work without it).
This is **reseed only**: `dolt_push` back to the hub stays out of scope.

## Notes

- **Naming.** The mirror is `<owner>/<slug>` (`DOLTHUB_OWNER` + slug, no `knowledge-` prefix). Prod owner `cogni-dao`; non-prod uses a non-prod org. So operator → `cogni-dao/operator`, poly → `cogni-dao/poly`.
- **Node-independent by design** — reads DoltHub directly; the app need not run. That is the recoverable copy.
- **Read/recover only.** Credentialed push-back is out of scope.
