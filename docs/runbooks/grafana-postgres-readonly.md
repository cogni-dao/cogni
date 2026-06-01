---
id: grafana-postgres-readonly
type: runbook
title: Grafana Postgres Read-Only Access
status: active
summary: Provision and use a read-only Postgres role through Grafana Cloud for agent debugging and support.
---

# Grafana Postgres Read-Only Access

## Purpose

Give on-call humans and agents a fast read path for per-node Postgres state without SSH or `kubectl exec`.

Do not expose Postgres to the public internet for this. Grafana Cloud should reach Postgres through a private network path such as Grafana Cloud Private Data Source Connect (PDC), or the datasource should run inside the same private runtime network.

The control boundary is Postgres, not Grafana: `db-provision` creates `app_readonly` with `SELECT` on per-node DB tables and no write grants. The role has `BYPASSRLS` for v0 support/debugging across tenants; vNext should replace this with actor-scoped access.

## Operating Model

This mirrors the log-access model in `.claude/commands/logs.md`:

- agents use the Grafana stack service-account token for reads
- Grafana brokers access to the data source
- the backing system enforces least privilege (`app_readonly` for Postgres)
- no agent needs SSH, `kubectl exec`, or public inbound Postgres

The PDC signing token is not an agent read credential. It is a deploy-time tunnel credential used by the PDC agent to get an SSH certificate from Grafana Cloud. Agents should normally only need `GRAFANA_URL` + `GRAFANA_SERVICE_ACCOUNT_TOKEN` to query an already-provisioned datasource.

## Bootstrap: PDC for a New Environment

Bootstrapping Grafana Cloud Postgres read access for `candidate-a`, `preview`, or `production` is **two human-touch steps** plus an infra deploy. There is no per-datasource UI click.

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. Mint a PDC signing token                       (Grafana UI)  │
│ 2. Run setup:secrets, dispatch the env's infra deploy  (CLI)    │
│ (CI provisions all node datasources, validates each end-to-end) │
└─────────────────────────────────────────────────────────────────┘
```

### Stable per Grafana org (set once, reused per environment)

These don't change between environments and don't need to be re-copied per env:

- **PDC network** — one per Grafana org by default. For this org: `pdc-derekg1729-default`.
- **`GRAFANA_PDC_HOSTED_GRAFANA_ID`** — stable per Grafana org. Copy from the Docker snippet on the **Configuration Details** tab of the PDC network.
- **`GRAFANA_PDC_CLUSTER`** — stable per Grafana org region (e.g. `prod-ap-southeast-1`). Copy from the same Docker snippet.
- **`GRAFANA_PDC_NETWORK_UUID`** — stable per PDC network. The internal Grafana UUID that `secureSocksProxyUsername` must equal for the datasource to route through PDC. Discover by binding ONE datasource via the UI as a one-time bootstrap, then read `.jsonData.secureSocksProxyUsername` from `/api/datasources/uid/<uid>` and store it as the GitHub env secret. Same value across every env that shares this PDC network.

### Per-environment

- **`GRAFANA_PDC_SIGNING_TOKEN`** — mint a fresh `glc_…` per environment so tokens can be revoked independently.
- The runtime `pdc-agent` container — runs in each env's Compose stack on the `internal` network alongside `postgres`.

### Footguns proven in the field

- The token JWT payload's `.n` field is the **token name**, not the network identifier. Do not feed it to anything as a network id.
- `GRAFANA_PDC_HOSTED_GRAFANA_ID` cannot be derived from the token payload — it does not appear there. Always copy from the Docker snippet.
- The datasource `type` must be `grafana-postgresql-datasource`. Legacy `postgres` does not route correctly through PDC on Grafana Cloud.
- `secureSocksProxyUsername` must be the network **UUID** (e.g. `5ff531a0-…`), not the network name. Setting it to the network name silently fails with `socks connect ... -> postgres:5432: unknown error network unreachable` even though the agent and signer are healthy.

### Step 1 — Mint a signing token

UI:

1. Open **Connections → Private data source connections**: <https://derekg1729.grafana.net/connections/private-data-source-connections>
2. Open the org PDC network (`pdc-derekg1729-default`).
3. **Configuration Details** tab → **Use a PDC signing token** → **Create a new token**.
4. Token name: `<env>-postgres-YYYYMMDD` (descriptive only; routing does not use this name).
5. Expiration: `No expiry` is acceptable for v0; rotate on a calendar otherwise.
6. **Create token**, then immediately copy three things from the generated Docker snippet — Grafana shows the token value once:
   - `glc_…` value (after `-token`) — store as `GRAFANA_PDC_SIGNING_TOKEN`
   - integer (after `-gcloud-hosted-grafana-id`) — store as `GRAFANA_PDC_HOSTED_GRAFANA_ID`
   - region string (after `-cluster`) — store as `GRAFANA_PDC_CLUSTER`

### Step 2 — Drop secrets into the env and deploy

```bash
pnpm setup:secrets --env <env> --only GRAFANA_PDC --all
```

This writes both the GitHub `<env>` environment secrets and the local `.env.<env>` file. Do not store the signing token in `.env.cogni`; that file is for agent-read credentials only.

Preflight the token (catches a bad token in 2 seconds rather than 5 minutes of CI):

```bash
COGNI_ENV_FILE=.env.<env> bash scripts/grafana-pdc-token-preflight.sh
```

Expected: `signer preflight passed: HTTP 200`. HTTP 401 means the signing token + hosted-grafana-id pair is wrong; redo Step 1.

Then run the env's infra deploy. CI:

- runs the same preflight as a workflow gate,
- starts the `pdc-agent` Compose service alongside the existing infra,
- prints the agent's first ~40 log lines into the workflow output (look for `Authenticated to private-datasource-connect…` and `This is Grafana Private Datasource Connect!`),
- runs `scripts/ci/provision-grafana-postgres-datasources.sh` which creates one datasource per `COGNI_NODE_DBS` entry, binds each to the PDC network via API (`secureSocksProxyUsername=$GRAFANA_PDC_NETWORK_UUID`, `pdcInjected: true`), then validates each with `select current_user`.

After this step, all three signals must be green:

| Signal                        | Where                                                  | Expected                                                                             |
| ----------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Tunnel up                     | workflow output                                        | `Authenticated to private-datasource-connect…`                                       |
| Datasource exists + PDC-bound | `GET /api/datasources/uid/cogni-<env>-<node>-postgres` | HTTP 200, `jsonData.pdcInjected: true`                                               |
| Datasource validates          | provision script log                                   | `validated cogni-<env>-<node>-postgres: PDC routing reachable, app_readonly auth OK` |

If validation fails, the workflow exits non-zero — there is no longer a "warn-and-continue" carve-out, because PDC-binding-via-API is now the canonical path. Common causes:

- `GRAFANA_PDC_NETWORK_UUID` not set or stale — refresh from any working datasource's `.jsonData.secureSocksProxyUsername`.
- `pdc-agent` container down or token revoked — see workflow log dump or Loki `{service="pdc-agent"}`.
- Postgres `app_readonly` password drift — `db-provision` runs idempotently every deploy, so this resolves on the next clean run.

### Verify end-to-end (agent-side, no SSH)

```bash
# .env.cogni provides GRAFANA_URL + GRAFANA_SERVICE_ACCOUNT_TOKEN (agent-side).
# Deploy pipelines also expose the token via .env.<env> (canary/preview/production); either works.
set -a
. /path/to/.env.cogni
set +a

scripts/grafana-postgres-query.sh \
  'select current_user, current_database()' \
  cogni-<env>-poly-postgres | jq -r '.results.A | "current_user=\(.frames[0].data.values[0][0])  database=\(.frames[0].data.values[1][0])"'
```

Expected: `current_user=app_readonly  database=cogni_poly`.

Verify write denial:

```bash
# Hit /api/ds/query with a write SQL — Postgres role-level read-only catches it
curl -sS -X POST "${GRAFANA_URL%/}/api/ds/query" \
  -H "Authorization: Bearer ${GRAFANA_SERVICE_ACCOUNT_TOKEN}" \
  -H 'content-type: application/json' \
  --data '{"queries":[{"refId":"A","datasource":{"uid":"cogni-<env>-operator-postgres","type":"grafana-postgresql-datasource"},"rawSql":"create table grafana_write_probe(id int)","format":"table"}],"from":"now-5m","to":"now"}'
```

Expected error: `cannot execute CREATE TABLE in a read-only transaction (SQLSTATE 25006)`.

### Recovery: `key signing request failed: invalid credentials`

Stale or wrong-paired signing token. Mint a fresh one (Step 1), preflight, re-run the deploy.

## Provision

Deploy or re-run infra bootstrap so `infra/compose/runtime/postgres-init/provision.sh` runs:

```bash
docker compose --project-name cogni-runtime --profile bootstrap up db-provision
```

The role defaults are:

```bash
APP_DB_READONLY_USER=app_readonly
APP_DB_READONLY_PASSWORD=<derived from POSTGRES_ROOT_PASSWORD>
```

`scripts/ci/deploy-infra.sh` writes those into the runtime `.env`. To override rotation, set both values in the deployment environment.

`deploy-infra.sh` also starts the Grafana PDC agent when these environment secrets are present:

```bash
GRAFANA_PDC_SIGNING_TOKEN=<token from PDC Configuration Details>
```

`GRAFANA_PDC_CLUSTER` and `GRAFANA_PDC_HOSTED_GRAFANA_ID` come from Grafana's generated PDC agent Docker command (Configuration Details tab). They are stable per Grafana org and do not need to be re-copied per environment. `GRAFANA_PDC_NETWORK_ID` is intentionally not used by the runtime path — `secureSocksProxyUsername` in the datasource config does not establish PDC routing on Grafana Cloud; the UI dropdown does (Stage 3). The legacy `GRAFANA_PDC_NETWORK_ID` env var remains read in places only as historical baggage.

## Grafana Datasource

The candidate-a / preview / production workflows run `scripts/ci/provision-grafana-postgres-datasources.sh` after infra deploy. The script derives the readonly password from `POSTGRES_ROOT_PASSWORD`, creates one datasource per `COGNI_NODE_DBS` entry, and validates each datasource with `select current_user`.

For Grafana Cloud, the datasource host must be `postgres:5432` through PDC. The CI provisioning script refuses to create public Postgres datasources unless `GRAFANA_POSTGRES_ALLOW_NON_INTERNAL_HOST=1` is deliberately set.

Use a Grafana stack service-account token for `GRAFANA_SERVICE_ACCOUNT_TOKEN`, usually prefixed `glsa_`. Grafana Cloud access-policy tokens prefixed `glc_` are for the Cloud API and telemetry services, not the Grafana instance HTTP API that creates datasources.

```bash
export GRAFANA_URL=https://<org>.grafana.net
export GRAFANA_SERVICE_ACCOUNT_TOKEN=glsa_...
export GRAFANA_PDC_NETWORK_ID=<pdc-network-id>
DEPLOY_ENVIRONMENT=candidate-a \
POSTGRES_ROOT_PASSWORD=<root-secret> \
COGNI_NODE_DBS=cogni_operator,cogni_poly,cogni_resy \
scripts/ci/provision-grafana-postgres-datasources.sh
```

For local experiments only, `scripts/grafana-postgres-datasource.sh` can still create a single datasource when explicitly supplied `GRAFANA_POSTGRES_PASSWORD`.

Datasource UID convention:

```text
cogni-<env>-<node>-postgres
```

Examples: `cogni-candidate-a-poly-postgres`, `cogni-preview-operator-postgres`.

## Query

Use a Grafana service account token with datasource query permission:

```bash
scripts/grafana-postgres-query.sh \
  'select count(*) from poly_copy_trade_fills' \
  cogni-candidate-a-poly-postgres | jq .
```

The helper refuses obvious non-read SQL locally. Postgres permissions are still the authoritative write-denial control.

This is the intended agent-facing prototype command, analogous to `scripts/loki-query.sh`:

```bash
scripts/grafana-postgres-query.sh \
  'select id, status, created_at from work_items order by created_at desc limit 20' \
  cogni-candidate-a-operator-postgres | jq .
```

## Validation

Both humans and AI agents validate this end-to-end through Grafana Cloud only — no SSH, no `kubectl exec`, no public Postgres. Two independent signals must be green:

### 1. PDC tunnel is connected (Loki signal)

Alloy on the runtime VM ships the `pdc-agent` container's stdout/stderr to Grafana Cloud Loki under `service="pdc-agent"`. Read it like any other service:

```bash
COGNI_ENV_FILE=/path/to/.env.cogni \
  scripts/loki-query.sh \
    '{env="candidate-a",service="pdc-agent"}' \
    30 100 \
  | jq -r '.data.result[].values[][1]'
```

Healthy looks like:

```text
level=info msg="connecting to Grafana"
level=info msg="connected" ...
```

Failure looks like:

```text
key signing request failed: invalid credentials
ssh: handshake failed
```

If Loki returns no streams for `service="pdc-agent"`, Alloy is dropping the container. Confirm `infra/compose/runtime/configs/alloy-config.metrics.alloy` keeps `pdc-agent` in its `discovery.relabel "docker_logs"` keep regex.

### 2. Datasource end-to-end query (Postgres signal)

```bash
scripts/grafana-postgres-query.sh \
  'select current_user, count(*)::int as fills from poly_copy_trade_fills' \
  cogni-candidate-a-poly-postgres | jq .
```

Expected:

- `current_user = app_readonly`
- `fills` is an integer

Then verify write denial:

```sql
create table grafana_write_probe(id int);
```

Expected: the write probe fails with permission/read-only errors.

### Required local credentials for agent validation

Both helpers source from the first present file in `$COGNI_ENV_FILE`, then `./.env.canary`, then `./.env.local`:

- `GRAFANA_URL` (e.g. `https://<org>.grafana.net`)
- `GRAFANA_SERVICE_ACCOUNT_TOKEN` (`glsa_…`)

The same `glsa_…` token is used by CI to provision datasources and by agents to read them, so it needs all four datasource permissions: `datasources:read`, `datasources:query`, `datasources:create`, `datasources:write`. The simplest way to satisfy this is to attach the token to a service account with role **Editor** (or **Admin**); a `Viewer`-role SA will 403 on PUT during provisioning.

The PDC signing token (`glc_…`) is not used at agent-read time. It only authenticates the runtime `pdc-agent` container at deploy time.

## Layer 3: Steady-state alerting

`scripts/grafana-apply-alert-rules.sh` applies a Grafana-managed alert rule per `(env, node)` UID. Each rule runs `select 1` every 1 min against the corresponding `cogni-{env}-{node}-postgres` datasource; sustained failure for 10 min routes to the `derek-email` contact point via the default notification policy.

Source files:

- `infra/grafana/alerts/rules/postgres-datasource-health.template.json` — single rule template, rendered per `(env, node)` by the apply script
- `infra/grafana/alerts/contact-points/derek-email.json` — recipient address comes from `$GRAFANA_ALERTS_EMAIL` at apply time (not committed)
- `infra/grafana/alerts/notification-policies/root.json` — default route → `derek-email`

Triggered by `.github/workflows/grafana-alerts.yml` on `push` to `main` under `infra/grafana/alerts/**` plus `workflow_dispatch`.

### Manual end-to-end probe

Bust one candidate-a datasource on the Grafana side without touching Postgres, then watch for the email:

```bash
# 1. Snapshot the current datasource so you can restore it
curl -sS -H "Authorization: Bearer $GRAFANA_SERVICE_ACCOUNT_TOKEN" \
  "${GRAFANA_URL%/}/api/datasources/uid/cogni-candidate-a-poly-postgres" \
  | jq . > /tmp/cogni-candidate-a-poly-postgres.json

# 2. PUT a deliberately-wrong password
jq '.secureJsonData = {password: "definitely-not-the-readonly-password"}' \
  /tmp/cogni-candidate-a-poly-postgres.json > /tmp/cogni-busted.json
curl -fsS -X PUT "${GRAFANA_URL%/}/api/datasources/uid/cogni-candidate-a-poly-postgres" \
  -H "Authorization: Bearer $GRAFANA_SERVICE_ACCOUNT_TOKEN" \
  -H "content-type: application/json" \
  --data @/tmp/cogni-busted.json >/dev/null

# 3. Wait > 10 min, observe the alert email at $GRAFANA_ALERTS_EMAIL.

# 4. Restore by re-running provisioning (idempotent PUT-by-UID).
DEPLOY_ENVIRONMENT=candidate-a \
POSTGRES_ROOT_PASSWORD=<root-secret> \
GRAFANA_PDC_NETWORK_UUID=<uuid> \
bash scripts/ci/provision-grafana-postgres-datasources.sh
```

## SOC 2 Notes

This is a v0 operational support role. Keep the compensating controls explicit:

- dedicated role, separate from app and service roles
- no `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `CREATE`, `ALTER`, or `DROP` grants
- no public inbound Postgres; use PDC/private network connectivity for Grafana Cloud
- Grafana service-account tokens scoped to datasource read/query for normal use
- datasource-write token used only for setup/rotation
- quarterly access review of Grafana service accounts and datasource permissions

## Pivot Criteria

Stay on Grafana PDC while the blocker is a correctable token or tunnel setup issue. Pivot only if Grafana Cloud cannot reliably issue or authenticate PDC signing tokens for this stack/network after direct signer preflight.

The preferred pivot is not SSH and not public Postgres. The fallback prototype should be an authenticated internal DB-read API or small query gateway deployed beside the app/Postgres, using the same `app_readonly` role, statement timeouts, and read-only SQL guard. That would trade Grafana's unified read key for a separate agent DB-read token, so PDC remains the better v0 if we can make it stable.
