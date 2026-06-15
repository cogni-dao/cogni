---
name: cicd-secrets-expert
description: "Secrets architecture reference for node-template — when to use OpenBao+ESO vs GitHub env secrets, which operation pattern fits which write/rotate/add flow, the load-bearing invariants from the spec, the YAML catalog + Zod-loader the script consumes, and where to find the canonical implementation. Use when adding/rotating a secret, designing a service that consumes secrets, debugging an ExternalSecret or writer-role login, deciding between substrate and Compose-infra routing, touching `pnpm secrets:set` / `scripts/secrets/` / `scripts/lib/secrets-catalog-loader.ts` / `nodes/<node>/.cogni/secrets-catalog.yaml` / `infra/secrets-catalog.yaml` / `infra/k8s/argocd/{openbao,external-secrets}/` / per-node ExternalSecret manifests, or evaluating any new workflow that touches secret values. Triggers: 'add a secret', 'add a node secret', 'rotate a key', 'OpenBao', 'ESO', 'ExternalSecret', 'secrets-catalog', 'catalog tier', 'A1', 'A2', 'B-tier', 'writer role', 'bao login', 'vault-action', 'vault-config-operator', 'secrets-manage', 'secret in GH env vs OpenBao', 'where do I put this credential', 'per-node catalog'."
---

# CI/CD Secrets Expert

One-page reference for anyone touching secrets in node-template. Read this BEFORE the spec; this points at what to actually read.

## North star

[`proj.agentic-fork-bootstrap`](../../../work/projects/proj.agentic-fork-bootstrap.md) — easy-start guide for a forking dev that uses OpenBao. Every PR is measured against the **forker's manual-command count**. If your change adds a manual step to `fork-quickstart.md`, that's debt — try a workflow first.

## Load-bearing invariants — gate every secrets decision

Load-bearing subset — canonical numbering is [`docs/spec/secrets-management.md`](../../../docs/spec/secrets-management.md) Invariants 1–16; the rows below are the ones that gate day-to-day secrets work (7, 10–12, 14 omitted — read the spec for the full set):

| #   | Rule                                                                                                                                                                      | Where it bites                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 1   | PATH = `cogni/<env>/<service>/<KEY>`; `<service>` = catalog name                                                                                                          | New service → new ExternalSecret dir                          |
| 2   | ONE ExternalSecret per (service, env) with `dataFrom: extract`; target `<service>-env-secrets`                                                                            | Adding keys = NO YAML edit                                    |
| 3   | Pod `envFrom: secretRef: name: <service>-env-secrets` once per container                                                                                                  | Pod spec set ONCE at service creation                         |
| 4   | NO secret value in git — ever                                                                                                                                             | Base64-in-YAML = immediate rotate + audit                     |
| 5   | OpenBao is runtime SSOT; VM `.env` files are rendered views, not authorities                                                                                              | Don't seed runtime values in two places                       |
| 6   | RBAC via path policy (`eso-reader`, `<env>-writer`) bound to k8s SAs                                                                                                      | Phase 5b.3 + 5b.4 of `provision-env-vm.sh`                    |
| 8   | Every access audited via OpenBao audit device → Loki                                                                                                                      | Pipeline not built yet — bug.0445 follow-up                   |
| 9   | Three entry points only: CLI / workflow_dispatch / operator API (`POST /api/v1/nodes/<id>/secrets`, OpenFGA `can_manage_secrets` — shipped #1627). Never raw `bao kv put` | See decision tree below                                       |
| 13  | NO_OPERATOR_ROOT_TOKEN_ON_LAPTOP — bootstrap window only; day-2 uses writer-role JWT                                                                                      | `.local/<env>-openbao-root-token` is never read post-Phase-5b |
| 15  | Pod-facing DB role material is OpenBao-owned, even when Compose renders a copy                                                                                            | No DB password authority in GitHub env or VM `.env`           |
| 16  | New-node secret materialization precedes substrate reconcile/assert                                                                                                       | Generate safe agent values before first flight                |

## Authority model — classify by three axes

Do not use `tier` as the authority model. Every secret has:

| Axis        | Values                                   | Question                       |
| ----------- | ---------------------------------------- | ------------------------------ |
| `origin`    | `agent` · `human` · `derived`            | Who can produce the bytes?     |
| `custody`   | `openbao` · `github-env` · `repo-config` | Which system is authoritative? |
| `consumers` | `pod` · `compose` · `ci` · `external`    | Where does the value get used? |

Hard rule: if a value is consumed by a pod, provisions a pod-facing role, or
must agree with a pod-facing value, custody is OpenBao. GitHub Environment
Secrets may bootstrap access and carry CI-only credentials. VM `.env` files are
rendered views for Compose, never authorities.

Examples:

- `POSTGRES_ROOT_PASSWORD`: Compose/bootstrap-only for now, because pods should
  not consume it.
- `APP_DB_PASSWORD`, `APP_DB_SERVICE_PASSWORD`,
  `APP_DB_READONLY_PASSWORD`, `DOLTGRES_PASSWORD`,
  `DOLTGRES_READER_PASSWORD`, `DOLTGRES_WRITER_PASSWORD`: OpenBao custody;
  Compose renders copies to create roles. (`DOLTGRES_PASSWORD` is the env Doltgres
  superuser the pod itself authenticates as — Doltgres RBAC is table-DML-only, so no
  per-node role; why + value-shape in [databases.md §5.2](../../../docs/spec/databases.md).)
- `OPENFGA_DB_PASSWORD`: OpenBao custody. **OpenFGA is the first shared-infra DB given a dedicated, non-root login role** (its own `openfga` role, OpenBao-sourced — Phase A dropped root from the datastore DSN). That's the **hardening direction, not a snowflake**: `litellm` / `postgres` are still the un-hardened root-owned legacy. Consequence — **shared-infra DBs (openfga, litellm) are provisioned in the `INFRA_ONLY` pass only**; the per-node provision pass must not touch them (it holds no shared-infra password). `litellm` survives the per-node pass only by being root-owned (no password to demand); openfga's dedicated role _exposed_ that the per-node pass should never provision shared infra. `provision.sh` now gates openfga to `INFRA_ONLY`; gating `litellm` the same way is the fuller fix.
- Public URLs / owner slugs / feature modes: repo-config, not OpenBao.

## Biggest systemic shortcoming — the `.env`/`_shared` split-brain

One logical `shared` secret becomes **three physical copies** — `_shared` SSOT, per-node inherited copy (ESO→pod), VM `.env` render (Compose) — written by three writers with **no lockstep**. They drift: the recurring root of secrets outages (litellm / temporal / doltgres / billing `401`·`28P01`). The tell: **pods have no `.env` and rarely drift; every `.env`-bound Compose service is the surface.** Never heal toward `.env` (Invariant 15); the endgame is to **eliminate the copies** (purge the `_shared` bucket + purge the server `.env` → Bao Agent / k8s). Mechanism, evidence, three-layer fix, falsification gate → [`docs/spec/secrets-split-brain.md`](../../../docs/spec/secrets-split-brain.md).

## Routing tree — where does the value render?

| Tier | Consumed by                                                              | Render path                                                    | Custody                          |
| ---- | ------------------------------------------------------------------------ | -------------------------------------------------------------- | -------------------------------- |
| A1   | k8s pod baseline (anything under `nodes/<n>/app/`, every fork)           | OpenBao `cogni/<env>/<service>/*` → ESO → k8s Secret → envFrom | OpenBao                          |
| A2   | k8s pod node-specific (downstream node like `poly`)                      | OpenBao `cogni/<env>/<node>/*` → ESO → k8s Secret → envFrom    | OpenBao                          |
| B    | Compose-infra service (postgres, litellm, temporal, redis, alloy, caddy) | Rendered to VM `.env` or future Bao Agent                      | OpenBao unless CI/bootstrap-only |
| D    | CI-only (workflow consumption, never runtime)                            | GH Env Secret → workflow `env:` block                          | GH Environment Secrets           |
| E    | Repo-level CI (cross-env, one value per repo)                            | GH Repo Secret                                                 | GH Repo Secrets                  |
| F    | Local dev only                                                           | `.env.local` (gitignored)                                      | Operator's laptop                |
| G    | Derived from repo state at provision time (e.g. `nodes/*` listing)       | Computed by loader; written alongside other catalog values     | Auto-generated                   |

Full tier definitions + invariants: [`docs/spec/secrets-classification.md`](../../../docs/spec/secrets-classification.md).
Layer-cake framing (Identity → AuthN → AuthZ → Secrets → DAO → Operator): [`docs/spec/access-control-charter.md`](../../../docs/spec/access-control-charter.md).
Routing checklist (file-by-file propagation): [`.claude/commands/env-update.md`](../../commands/env-update.md) §0.5.

## Runtime env triage

`serverEnv()` validates process env; it does not decide the source of truth.
Classify first:

- **Secret:** leaking it requires rotation or incident response. Route through
  OpenBao/ESO or the proper GH secret tier.
- **Plain config:** owner slugs, repo names, public URLs, feature modes, and
  routing values. Route through GitOps ConfigMaps or repo config.

For either path, k8s object presence is not process proof. Pods read env only at
startup, so prove: source object -> Deployment `envFrom` -> restarted pod env ->
public health. Treat old Argo/workflow failures as leads until live cluster
checks agree.

## App flight substrate assertions are read-only

`candidate-flight.yml` uses `scripts/ci/assert-target-substrate.sh` as a
preflight for selected app rollouts. That gate may verify a Deployment-consumed
k8s Secret exists and its matching ExternalSecret is Ready, but it must not seed
OpenBao, patch GitHub secrets, run `deploy-infra.sh`, or repair Compose/env
state. A missing secret is a substrate failure. For a wizard-created ordinary
node, there should be **zero per-node human secret values**. The environment
must already have the substrate/runtime inputs classified in
`docs/spec/secrets-classification.md#node-wizard-formation-contract`.
If an environment-bank value is missing, repair that bank; do not pass values
through candidate-flight inputs or store them in the wizard.

**"Read-only" applies to `assert`, not the whole flight.** Distinct from the
read-only assertion, `candidate-flight.yml` / `promote-and-deploy.yml` run a
**`materialize-substrate`** job _first_ — the **sole OpenBao writer in the flight**
(`scripts/ci/secret-materialize.sh`, `<env>-writer` token) — which generates the
node's `source: agent` secrets at `cogni/<env>/<node>/*` idempotently before
reconcile/assert, **including the per-node DB creds** (`app_<node>`/`service_<node>`
passwords) and the composed Postgres DSNs (`DATABASE_URL`/`DATABASE_SERVICE_URL`;
only `DOLTGRES_URL` is still deferred) since **#1584** (canonical:
[`ci-cd.md` Axiom 22](../../../docs/spec/ci-cd.md),
`SUBSTRATE_IS_RECONCILED_BEFORE_PROMOTION`). Since #1584 `reconcile-substrate` is
**read-only on OpenBao** (`<env>-db-reader` token, zero `bao kv put/patch`) and
`assert-target-substrate.sh` is read-only too — so only `materialize-substrate`
writes. **Prod gap (bug.5007):**
`materialize-substrate` mints `<env>-writer` via the `openbao-operator`
ServiceAccount, which `candidate-a` has but **production does not** — a prod
promote currently fails there until prod is provisioned with the writer SA or the
job is made env-tolerant.

The target shape matters. Today the implemented branch is `type=node`; a future
`type=service` branch should assert the service's declared Secret /
ExternalSecret / ConfigMap contract without inheriting node DNS, Caddy, NodePort,
or node-DB assumptions.

## Decision tree — how do I write / rotate the value?

| Operation                                             | Right pattern                                                                                                           | Today's reality                                                                                                                                                                                                                                                    |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Add new secret SHAPE (service X consumes key A)       | PR → `vault-config-operator` CRD → Argo reconciles                                                                      | Not built; tracked in `proj.agentic-fork-bootstrap` Walk                                                                                                                                                                                                           |
| Materialize a new wizard node's runtime secrets       | Generate/derive node-local values and inherit only explicit org/env grants; no per-node human values for ordinary nodes | Shipped: `materialize-substrate` is its own flight job (`scripts/ci/secret-materialize.sh`, `<env>-writer` token), idempotent read-once→diff→write-missing (#1582/#1585; ci-cd.md Axiom 22). The shared-bank / explicit `inheritFrom`-grant model is the follow-up |
| Rotate AUTO-GENERATED value (e.g., `AUTH_SECRET`)     | `rotate-secret.yml` workflow with env-protection; auto-generates value; **human approves event, never sees value**      | Not built; do manual `openssl rand` + `pnpm secrets:set` per [`secrets-rotate.md`](../../../docs/guides/secrets-rotate.md)                                                                                                                                         |
| Rotate VENDOR-MINTED value (OpenAI key, Cherry token) | Operator API route `POST /api/v1/nodes/[id]/secrets`, OpenFGA `can_manage_secrets` — caller holds only an API key       | #1627 prototype (candidate-a-only; preview/prod have no OpenFGA store → 503). Until merged + fleet-wide: CLI on candidate-a + admin/kube custody. See "Who holds secret-write authority" above                                                                     |
| Candidate-a experimentation                           | `pnpm secrets:set <env> <service> <KEY>` via port-forward + writer-role JWT                                             | Shipped — see [`secrets-add-new.md`](../../../docs/guides/secrets-add-new.md)                                                                                                                                                                                      |
| Dynamic DB credentials                                | OpenBao DB engine, no human in loop                                                                                     | Future (Crawl row 3 of `proj.security-hardening`)                                                                                                                                                                                                                  |

The killer rule: **no human types a secret VALUE into a UI in production.** Auto-generated, vendor-minted via operator-app, or dynamic. Form-input is the anti-pattern.

## Who holds secret-write authority — TODAY vs TARGET (READ THIS)

The honest answer to "can a node add its own secret without Derek's GitHub/kube creds?" is **somewhere in between, closer to Derek/GitHub-admin-controlled today.** Do not claim "operator-app RBAC" where it isn't yet shipped. Three distinct authorities — keep them separate:

| Authority                                                          | What it decides                | TODAY (custody)                                                                                                                                                                                                                                                                                                                                                                      | TARGET                                                                           |
| ------------------------------------------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| **Secret declaration** (shape)                                     | "node Y is allowed key KEY_X"  | GitHub repo merge authority — whoever can merge a PR to the catalog. Guarded by required CI + Cogni Git PR Review + branch protections. **No value in the PR.**                                                                                                                                                                                                                      | Same (PR-gated). This rung is fine.                                              |
| **Generated value** (`source: agent`)                              | random bytes minted for node Y | GitHub Actions `materialize-substrate` job: the flight workflow SSHes the env VM and mints an `<env>-writer` OpenBao token via the in-cluster `openbao-operator` SA. **Real and shipped** for candidate-a/preview; **prod gap** — prod lacks the writer SA (bug.5007). "Who can cause it" = whoever can merge/dispatch the env's deploy workflow → **GitHub merge authority again.** | In-cluster Job (SA-bound `<env>-writer`), zero SSH (design §North-star Stage 2). |
| **Human/vendor value** (`source: human`: OpenAI key, Cherry token) | the byte value a vendor minted | **Operator-controlled CLI/kube path** (`pnpm secrets:set` + short-lived writer JWT via port-forward). In this workspace that effectively means **Derek/admin-held repo + kube custody.**                                                                                                                                                                                             | Operator app route + OpenFGA RBAC (see below) — **prototyped, not merged.**      |

**The gap that keeps us on Derek's creds:** there is **no shipped operator-app secrets route** and **no `.github/workflows/secret-set.yml`**. Every value-write today bottoms out in GitHub-merge authority or operator/admin kube custody — i.e. Derek.

**The precise PR/design that closes it** — the value-write complement to the flight triangle (`developer → can_flight → operator-held GitHub App creds`), one rung over with its **own least-privilege role** (`secrets_manager → can_manage_secrets → operator-held OpenBao writer`; distinct from `developer`, mirroring `production_promoter`):

- Design: [`docs/design/node-self-serve-secrets.md`](../../../docs/design/node-self-serve-secrets.md) (operator-mediated, OpenFGA-authorized). Sibling: [`node-wizard-secret-setting.md`](../../../docs/design/node-wizard-secret-setting.md) (shape, shipped).
- PR: **#1627** (prototype) — `POST /api/v1/nodes/[id]/secrets` + `OperatorSecretsPlanePort` + `OpenBaoSecretsAdapter` (operator pod self-logins with its OWN projected SA token, `audience: cogni-openbao`) + `can_manage_secrets` OpenFGA relation + build-time A2 allowlist. Caller holds **only an API key — no kubeconfig, no vault token.**
- **Candidate-a-only today:** preview/prod have no OpenFGA store, so every check there is `authz_unavailable` (503). Merging #1627 gives the RBAC path on candidate-a; full fleet needs OpenFGA in preview/prod.

Three defense-in-depth gates in #1627: OpenFGA `can_manage_secrets` (fail-closed) → catalog A2 allowlist (build-time typed module) → OpenBao policy explicit-`deny` on `_system`/`_shared`.

**Validation status + the road to a proper e2e:** [`docs/design/node-self-serve-secrets-validation-roadmap.md`](../../../docs/design/node-self-serve-secrets-validation-roadmap.md) — the layered proof (L1 candidate-a authz **done**; L2 full write needs the allowlist codegen + the OpenBao writer-role DRY fix; L3 human-in-loop deployed e2e). **Load-bearing gotcha:** the write env is operator-stamped (`deployEnv = env.DEPLOY_ENVIRONMENT`), so `cogni/<operator-env>/<node>/*` is the only path it can write — a prod operator **cannot** write a candidate-a node's secret. Any cross-env "set my candidate-a secret from the prod operator" needs an explicit authz-scoped `targetEnv` param (not in #1627).

## Dual-plane secrets — the silent-webhook-fail class (READ THIS)

Some secrets must **byte-equal a value held by an external system**, not merely exist. The operator's `GH_WEBHOOK_SECRET` must equal the **GitHub App's webhook secret**; an OAuth `*_CLIENT_SECRET` must equal the provider's app config. These are **dual-plane**: one copy in our pod, one on the external plane — they only work if identical.

**The trap (live bug, preview 2026-06-03):** `GH_WEBHOOK_SECRET` was `source: agent` with **no `syncTo`**, generated `randHex 32` **every provision** → it could never match the App's webhook secret → **every webhook failed HMAC verification**, silently (a `level:40` warn `component:webhook-route msg:"webhook verification failed"`, no alert, no 5xx). The App just looks dead — no PR reviews, no node-wizard. `deploy-infra` re-applying the Secret was the **breaking** path, not the healing one — a generated value never equals an externally-held one **unless something pushes it there**. That push is what `syncTo` declares.

**`syncTo` is an external mirror, not custody.** `origin` says who can produce
the bytes, `custody` says where the value is authoritative, and `syncTo` says
whether a copy must also be pushed to an external system.

| axis              | values                                                                                                                                              | answers                                                              |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `source:`         | `agent` (we generate, `generate:` required) · `human` (un-generatable; vendor-minted, human supplies once, e.g. `GH_REVIEW_APP_PRIVATE_KEY_BASE64`) | where the value **originates**                                       |
| `syncTo:` _(opt)_ | `github-app-webhook` · _(unset)_                                                                                                                    | does it **also** live in an external system we must keep in lockstep |

`GH_WEBHOOK_SECRET` is `source: agent` + `syncTo: github-app-webhook` — **we generate it** (origin is internal; calling it `source: external` lied about that), and it ALSO must byte-match the App. The materializer/provisioner generates it into OpenBao; the infra lane then pushes it (`scripts/secrets/sync-app-webhook-secret.sh`: App JWT → `PATCH /app/hook/config`):

```
APPID + GH_REVIEW_APP_PRIVATE_KEY_BASE64 → RS256 JWT (iss=APPID, exp≤10m)
PATCH /app/hook/config  -d '{"secret":"<generated GH_WEBHOOK_SECRET>"}'   # endpoint EXISTS
```

No-human-secret done right: agent generates, agent pushes, **zero human, self-healing** (provisioning owns both copies → every infra-lever deploy re-converges). Do NOT make it `source: human`/carry — that drags a human into the App's "Change secret" field for a value that's ours to generate.

⚠️ **Sync only fires on the infra lever** (`deploy-infra` via `candidate-flight-infra` / `provision-env`), NOT on app-lever promotes (`candidate-flight`/`flight-preview`/`promote-and-deploy` = Argo image bump, never touches the Secret). `assert-target-substrate.sh` is also read-only: it can fail a flight when the Deployment-consumed Secret / ExternalSecret is absent or not Ready, but it does not heal the value. In an established ESO environment, `deploy-infra` must source `GH_WEBHOOK_SECRET` from OpenBao before invoking the sync and must fail closed if the App PATCH fails; otherwise the pod plane and GitHub App plane can silently diverge again. Fresh/plain-Secret bootstrap may still use workflow env input until the operator ESO target exists.

**Heal-proof test** = redeploy twice; a PR on the test repo must still post a `cogni-git-review` review.

## OpenBao availability — sealed = DOWN, not secure (READ THIS)

Counterintuitive but load-bearing: a **sealed** OpenBao serves **nothing** — it 503s every ESO sync, every `materialize`/`reconcile-substrate` `auth/kubernetes/login`, and openfga's config load. OpenBao must run **UNSEALED ~100% of the time**; unsealed-and-running is the _correct_ operational state. The seal protects **data at rest** (stolen storage = encrypted/useless), **not** runtime access — that's auth methods + path policy (Invariant 6) + in-cluster-only (no Ingress). So "keep it sealed / minimize unsealed time" is backwards: an _unexpected_ seal is an **outage**, not a safe state.

**The fragility (`bug.5011`, prod outage 2026-06-11 02:25):** prod OpenBao is **Shamir 1-of-1, no auto-unseal**. It OOMKilled on the 6 GB box → resealed → secret plane down (openfga 503, `node-substrate` promote failures) until a human `kubectl exec … bao operator unseal`. **Any** restart (OOM, reboot, chart upgrade) reseals it.

**Recorded decision (`bug.5011`) — do not re-litigate without the trigger:**

1. **Memory headroom** — OpenBao limit 512Mi→1Gi (#1617) so it isn't container-OOMKilled; #1616 lean-prod cut node pressure too. Mitigates the OOM _trigger_ only.
2. **Sealed-state → Loki alert** — the no-silent-outage control: detect an unexpected seal, page, unseal in minutes. Free, no vendor. This is the durable fix, because you cannot prevent every reseal.
3. **Auto-unseal (KMS) DEFERRED** behind a written trigger: _reseals recur post-#1617, OR a SOC2 engagement starts_. KMS is the audit-correct control but it is our first AWS/GCP dependency on a Cherry+OSS stack — premature at 0 users. If a real SOC2 deadline lands, flip it to now.
4. **REJECTED: in-cluster stored-key unseal sidecar** — key-next-to-lock, fails SOC2.

## Anti-patterns — instant reject

- Human typing a secret VALUE into a production UI or GitHub workflow input. See killer rule.
- Treating `tier: B`, GitHub Environment Secrets, or VM `.env` as authority for
  a runtime secret. If it feeds a pod or a pod-facing role, OpenBao owns it.
- Candidate-flight accepting secret values as inputs. Flight may invoke
  materialization for safe generated/derived node values and fail if the
  environment's required DAO/org bank is missing; it must not carry values.
- A **dual-plane** secret (must byte-match an external system — GitHub App webhook secret, OAuth client secret) declared with **no `syncTo:`** — it silently fails verification forever and `deploy-infra` re-breaks it every run. Add `syncTo:` (keep `source: agent` if we generate the value). See "Dual-plane secrets" above.
- Generic catch-all workflow (`secrets-manage.yml`-shaped). Per-operation only.
- `ssh root@vm kubectl ...` or `ssh root@vm bao ...`. Use local kubectl + port-forward + writer-role JWT.
- Treating k8s Secret or ConfigMap presence as proof that a running pod has the value. Prove the process after rollout.
- Treating a failed app-flight substrate assertion as permission to run
  `deploy-infra` from the app flight. Heal secrets/substrate through the owning
  secrets or infra lane; keep app flight read-only until image promotion.
- Re-exporting `.local/<env>-openbao-root-token` after Phase 5b — violates Invariant 13.
- `bao kv put` instead of `bao kv patch` (replaces sibling keys).
- `bao login -method=kubernetes` in OpenBao CLI 2.5.x — that subcommand doesn't exist; use raw API: `bao write auth/kubernetes/login role=X jwt=Y`.
- Per-secret ExternalSecret YAML — violates Invariant 2.
- `valueFrom: secretKeyRef` per env var in pod spec — violates Invariant 3.
- Base64-in-git "encryption" — violates Invariant 4.
- Sealed Secrets / SOPS+ksops — explicitly rejected per `proj.security-hardening` Design Notes.
- Editing `scripts/setup-secrets.ts` to add/remove a SECRETS array entry — there isn't one. The script loads YAML via `scripts/lib/secrets-catalog-loader.ts`. Edit the appropriate `secrets-catalog.yaml` instead.
- ExternalSecret manifests under `infra/k8s/secrets/external-secrets/<env>/<node>/` — that pre-wizard tree is PURGED. Remote-source/wizard nodes carry their leaf in the node repo at `k8s/external-secrets/<env>/`, mounted by the operator as `nodes/<node>/k8s/external-secrets/<env>/` when pinned. Only the cluster-scoped `ClusterSecretStore` remains under the old dir.
- Treat the operator overlay-local ExternalSecret as a legacy operator exception, not the node standard. `infra/k8s/overlays/<env>/operator/external-secret.yaml` is Argo-owned because the operator Deployment patch lives in that overlay; source name `env-secrets` renders through `namePrefix: operator-` to object `operator-env-secrets`, while `spec.target.name` stays `operator-env-secrets`.

## The catalog (per-node YAML + Zod loader)

`scripts/setup-secrets.ts` does NOT hold a hardcoded SECRETS array. It calls a Zod-validated loader that walks YAML catalogs:

| File                                       | Domain                                                                                  | Holds                                                                                                                                                                  |
| ------------------------------------------ | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `infra/secrets-catalog.yaml`               | **operator-domain**                                                                     | `_shared`, `_system`, B/D/E/G entries, A2 placeholders, **and (today) all node A1/A2 entries** — node-template's catalog was migrated here by task.5094                |
| `nodes/<node>/.cogni/secrets-catalog.yaml` | **node-domain** (single-node-scope: a node engineer adds their node's secret in ONE PR) | A1/A2 entries the node owns; `service:` auto-fills from parent dir. **Loader-supported but currently empty** — no node populates it yet (post-task.5094 consolidation) |
| `scripts/lib/secrets-catalog-loader.ts`    | **operator-domain (substrate)**                                                         | Zod schema + walker (walks both paths above) + uniqueness + service-allowlist assertions                                                                               |

**To add a node secret today:** edit `infra/secrets-catalog.yaml` — node entries are consolidated there post-task.5094 (per-node `.cogni/secrets-catalog.yaml` is loader-supported and is the sovereignty target, but no node uses it yet).
**To add an operator-domain secret (B/D/E/G, or `_shared` cross-cutting):** edit `infra/secrets-catalog.yaml`. Operator-domain PR.
**The loader rejects at module load:** missing `tier`, name collision across files, per-node `service:` mismatch with parent dir, unknown `service:` value not in the allowlist (`_shared`/`_system` + present nodes + canonical-future-domain names from `node-ci-cd-contract.md`).

## Files to read by topic

| If you're doing…                                | Read                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Understanding the tier system + invariants      | [`docs/spec/secrets-classification.md`](../../../docs/spec/secrets-classification.md)                                                                                                                                                                                                                                                                                                              |
| Designing node-wizard secret behavior           | [`docs/design/node-wizard-secret-setting.md`](../../../docs/design/node-wizard-secret-setting.md)                                                                                                                                                                                                                                                                                                  |
| The layered authority model (Identity → DAO)    | [`docs/spec/access-control-charter.md`](../../../docs/spec/access-control-charter.md)                                                                                                                                                                                                                                                                                                              |
| Adding a new secret to your node                | Edit `nodes/<node>/.cogni/secrets-catalog.yaml` + read [`docs/guides/secrets-add-new.md`](../../../docs/guides/secrets-add-new.md)                                                                                                                                                                                                                                                                 |
| Adding a `_shared` / B / D / E / G secret       | Edit `infra/secrets-catalog.yaml`                                                                                                                                                                                                                                                                                                                                                                  |
| Rotating an existing secret                     | [`docs/guides/secrets-rotate.md`](../../../docs/guides/secrets-rotate.md)                                                                                                                                                                                                                                                                                                                          |
| Following the bootstrap flow                    | [`docs/runbooks/fork-quickstart.md`](../../../docs/runbooks/fork-quickstart.md)                                                                                                                                                                                                                                                                                                                    |
| **Provisioning a new env** (candidate-\*, fork) | Dispatch [`.github/workflows/provision-env.yml`](../../../.github/workflows/provision-env.yml) (`-f env=<env> -f encryption_passphrase=…`). Full walkthrough — 7 minting secrets + init-artifact custody — in [`docs/runbooks/fork-quickstart.md`](../../../docs/runbooks/fork-quickstart.md) §6. The runner owns the tofu+bao+kubectl session; the operator's laptop never holds substrate creds. |
| Adding a new service (new k8s Deployment)       | [`docs/guides/node-formation-guide.md`](../../../docs/guides/node-formation-guide.md) + add ExternalSecret under `nodes/<node>/k8s/external-secrets/<env>/`                                                                                                                                                                                                                                        |
| Touching substrate provisioning                 | [`scripts/setup/provision-env-vm.sh`](../../../scripts/setup/provision-env-vm.sh) Phases 5b.1–5b.5                                                                                                                                                                                                                                                                                                 |
| Touching the CLI                                | [`scripts/secrets/set-secret.sh`](../../../scripts/secrets/set-secret.sh) + test [`scripts/ci/tests/set-secret.test.sh`](../../../scripts/ci/tests/set-secret.test.sh)                                                                                                                                                                                                                             |
| Touching the loader / catalog schema            | [`scripts/lib/secrets-catalog-loader.ts`](../../../scripts/lib/secrets-catalog-loader.ts) (Zod schema + walker)                                                                                                                                                                                                                                                                                    |
| Touching any node's ExternalSecret              | Remote-source/wizard nodes: `nodes/<node>/k8s/external-secrets/<env>/` (per-node, node-domain) — the single repo-wide convention. Operator legacy overlay: keep `infra/k8s/overlays/<env>/operator/external-secret.yaml` aligned until operator moves to the same node-domain leaf. No aggregator; only the cluster-scoped `ClusterSecretStore` lives under `infra/k8s/secrets/external-secrets/`. |
| Touching substrate Argo Applications            | `infra/k8s/argocd/{openbao,external-secrets}-application.yaml`                                                                                                                                                                                                                                                                                                                                     |
| Touching the env-var classification routing     | [`.claude/commands/env-update.md`](../../commands/env-update.md) — k8s app vs Compose-infra split                                                                                                                                                                                                                                                                                                  |
| Designing a new workflow that handles secrets   | This file + `proj.agentic-fork-bootstrap` anti-patterns. Run it past the killer rule.                                                                                                                                                                                                                                                                                                              |

## When to escalate

Surface to operator before writing code if:

- Adding a NEW entry point that isn't already CLI / workflow_dispatch / operator-MCP — Invariant 9 lists the only three sanctioned shapes.
- Changing `eso-reader` policy or `<env>-writer` role binding — affects every consumer.
- Bumping OpenBao or ESO chart version — rotation drill required (see `secrets-rotate.md` §Upgrade discipline).
- Anything that smells like Invariant 4 (NO_VALUE_IN_GIT) — finding a value in YAML / commit message / PR diff / chat is always a rotate-now event.
- Designing a workflow where humans type values into a form — recheck against the killer rule before building.
