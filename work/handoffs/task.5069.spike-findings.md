---
id: task.5069.spike-findings
type: handoff
title: "DoltHub PAT spike — auth path blocker (2026-05-28)"
related_task: task.5069
related_pr: 1360
related_project: proj.knowledge-syntropy
status: blocked
created: 2026-05-28
owner: derekg1729
---

# DoltHub mirror v0 — spike findings

## TL;DR

PAT-only push to DoltHub does not work. v0 push job is blocked until Derek picks one of three auth paths. PR #1360 (env wiring) lands as-is — it has independent value and the OAuth pair is already tracked by task.5070.

## What I verified (local spike, `dolthub/doltgresql:0.56.0`)

| Probe                                                                                                             | Result                                                    |
| ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `SELECT dolt_add('-A'); SELECT dolt_commit(...)` in Doltgres                                                      | 🟢 works                                                  |
| `SELECT dolt_remote('add', 'origin', 'https://doltremoteapi.dolthub.com/cogni-dao/knowledge-operator')`           | 🟢 SQL accepts                                            |
| `SELECT dolt_push('origin', 'main')` with `DOLT_REMOTE_PASSWORD=$DOLTHUB_API_TOKEN` env on the doltgres container | 🔴 `PermissionDenied`                                     |
| Same push with URL-embedded basic auth `https://cogni-dao:<PAT>@doltremoteapi.dolthub.com/...`                    | 🔴 `PermissionDenied` — AND token leaks into error string |
| DoltHub REST API: `GET /api/v1alpha1/cogni-dao/knowledge-operator/main?q=SELECT+1`                                | 🔴 `no such repository`                                   |
| DoltHub REST API: `POST /api/v1alpha1/repos` (auto-create)                                                        | 🔴 HTTP 404 — endpoint doesn't exist                      |
| DoltHub REST API: `POST /api/v1alpha1/cogni-dao/knowledge-operator/main` (import)                                 | 🔴 `Only GET requests are supported`                      |
| DoltHub REST API: `POST .../write/main/main?q=CREATE TABLE...`                                                    | 🔴 `no such repository`                                   |

## Root cause

DoltHub treats PAT and Dolt-creds as **separate** auth mechanisms:

- **PAT** (`dhat.v1.*`) — REST API only (queries, writes via SQL endpoint, repo metadata)
- **Dolt creds** (`dolt creds new` keypair, registered with DoltHub UI) — Dolt push/pull protocol over GRPC

`doltgres` ships only the server binary, not the `dolt` CLI; there is no in-image way to generate or register Dolt creds. Doltgres exposes `SELECT dolt_creds_*()` SQL procedures but the pubkey still has to be registered with DoltHub via the UI.

Two secondary findings:

1. **`cogni-dao/knowledge-operator` does not exist on DoltHub**. Even after solving auth, the repo must be created manually first (no auto-create on first push; no REST endpoint for repo creation).
2. **URL-embedded auth leaks the token** into `dolt_push` error messages (which would end up in Loki). This option is off the table regardless of whether it would work.

## Three real paths forward

### Path A — Dolt creds + manual UI registration (native, full Dolt history)

1. Add a one-shot bootstrap SQL: `SELECT dolt_creds_new()` → prints a pubkey
2. Manually paste pubkey into `https://www.dolthub.com/settings/credentials`
3. Store the privkey as a new env var (`DOLT_CREDS_PRIVATE_KEY` or similar)
4. Container startup writes privkey to `~/.dolt/creds/<keyid>.jwk` (Doltgres reads it from there)
5. `SELECT dolt_push('origin', 'main')` then works

**Pros**: full Dolt commit graph preserved on DoltHub; native protocol; no token-in-URL risk.
**Cons**: one-time manual UI ceremony per environment; new secret to provision; key rotation needs the same UI dance.

### Path B — REST SQL mirror (PAT, lossy on commit graph)

1. After every successful merge, fire-and-forget `POST https://www.dolthub.com/api/v1alpha1/cogni-dao/knowledge-operator/write/main/main?q=<diff-sql>` with the PAT
2. Skip Dolt push protocol entirely
3. DoltHub becomes a "current-state mirror" — it has the rows but not the commit graph

**Pros**: PAT-only auth (already provisioned); no UI ceremony.
**Cons**: DoltHub doesn't reflect Cogni's Dolt history; external researchers see flat state instead of contribution lineage — undercuts the "knowledge graph as audit trail" narrative.

### Path C — Defer

Land env wiring only (PR #1360 as-is). Successor PR for task.5069 picks A or B after Derek's input. OAuth pair stays tracked by task.5070.

## My recommendation

**Path A** if the commit graph matters (which I think it does, given the syntropy / audit narrative). **Path C** for tonight — A is a meaningful design + ceremony Derek should architect, not me at 11pm.

## DoltHub repo prereq (regardless of path)

`cogni-dao/knowledge-operator` must exist on DoltHub. 30-second UI step at https://www.dolthub.com/repositories/new. Empty public repo, `main` branch.

## What this PR (#1360) still contains

Env wiring for `DOLTHUB_API_TOKEN` + `DOLTHUB_OAUTH_CLIENT_ID/SECRET`. All three are correctly plumbed and CI-green. The PAT is useful immediately for any future REST-side knowledge integration (Path B, librarian read flow, x402 prep). OAuth pair is owned by task.5070 (per-user identity). Nothing in this PR depends on the push job working.

## Files an agent picking up Path A would touch

- `infra/compose/runtime/docker-compose.yml` — add `DOLT_CREDS_PRIVATE_KEY` to doltgres container env
- `nodes/operator/app/src/shared/env/server-env.ts` — new optional env
- `packages/knowledge-store/src/adapters/doltgres/contribution-adapter.ts:546` — fire-and-forget `pushMain` after merge succeeds
- `packages/knowledge-store/src/adapters/doltgres/dolt-remote.ts` (NEW) — encapsulates remote-add + dolt_push SQL
- `scripts/setup-secrets.ts` — replace/augment DoltHub catalog entries
- `docs/runbooks/dolthub-creds-bootstrap.md` (NEW) — the manual UI ceremony

## Files an agent picking up Path B would touch

- `packages/knowledge-store/src/service/contribution-service.ts:227` — fire-and-forget POST to DoltHub REST after `port.merge()` returns
- `packages/knowledge-store/src/adapters/dolthub/rest-mirror.ts` (NEW) — HTTP client wrapping the `/write/main/main` endpoint
- DoltHub repo still needs manual creation (same 30s UI step)
