---
id: secrets-update-guide
type: guide
title: Add or Update a Service Secret
status: draft
trust: draft
summary: How to add or update one service secret in OpenBao, force ESO sync, and prove the running pod actually sees it.
read_when: Adding, updating, or rotating one pod-consumed service secret.
owner: cogni-dev
created: 2026-05-19
verified: 2026-06-06
tags:
  - secrets
  - guides
---

# Add or Update a Service Secret

## Two paths — and the node-dev path lives in the hub

**Node owner/agent setting a secret with only an API key:** the contract —
request shape, the `secrets_manager` (not `developer`) grant, the auth chain, and
the **live per-env status** — is single-sourced as a knowledge guide in the hub,
not restated here (a git snapshot drifts):

> Recall **`node-self-serve-secrets`** — `GET /api/v1/knowledge/node-self-serve-secrets`.
> Code of record: `nodes/operator/app/src/app/api/v1/nodes/[id]/secrets/route.ts`.

**The rest of this doc is the operator-admin break-glass CLI** (`pnpm secrets:set`

- kube custody) — the day-2 fallback for what the self-serve API cannot serve
  (cross-env writes), admin-only. It is not the node-dev contract.

`source: agent` keys (DB creds, DSNs, `AUTH_SECRET`, `CONNECTIONS_ENCRYPTION_KEY`,
`GH_WEBHOOK_SECRET`) are **never** hand-set on either lane — they are substrate-minted
per node and denylisted (`node-secrets-reserved.data.ts`). See §2.

## First Gate

Use this guide only when leaking the value requires rotation or incident
response: tokens, private keys, passwords, webhook secrets, signing material, or
DSNs that embed passwords.

Plain runtime config does not belong in OpenBao. Owner slugs, repo names,
public URLs, feature modes, and routing values belong in repo/GitOps config,
usually a k8s ConfigMap consumed through `envFrom`.

Both paths end at `process.env` and `serverEnv()`. The split is only the source
of truth before the pod starts:

```text
Secret: OpenBao -> ESO -> k8s Secret -> process.env -> serverEnv()
Config: Git overlay -> ConfigMap -> process.env -> serverEnv()
```

## Read First

- [`cicd-secrets-expert`](../../.claude/skills/cicd-secrets-expert/SKILL.md) - OpenBao vs GitHub Environment secrets, tier routing, entry points, and anti-patterns.
- [`docs/spec/secrets-management.md`](../spec/secrets-management.md) - canonical OpenBao + ESO contract.
- [`docs/runbooks/production-operator-eso-cutover.md`](../runbooks/production-operator-eso-cutover.md) - production operator preflight, seed, force-sync, and rollback gates.
- [`devops-expert`](../../.claude/skills/devops-expert/SKILL.md) - required before using deploy branches, production rollout mechanics, or CI/CD state.

## Runtime Path

Pod-consumed secrets flow one way:

```text
OpenBao cogni/<env>/<service>/<KEY>
  -> External Secrets Operator
  -> k8s Secret <service>-env-secrets
  -> Deployment envFrom
  -> process.env.<KEY> after the pod starts
```

GitHub Environment secrets are not the live source for ESO-backed pods. They
carry CI-only/bootstrap access credentials or sealed staging values for a
workflow that writes OpenBao.

## Runtime Path — off-cluster (Akash): the key MUST be declared in `secret_refs`

The ESO `envFrom` flow above is the **k3s** lane. On **Akash / off-cluster
compute the value in OpenBao is not enough** — the workload only receives the
secret keys its service explicitly lists, so writing the value is **two-part**:

```text
1. DECLARE the key  ->  nodes/<node>/.cogni/repo-spec.yaml
                        deployment.services[].secret_refs: [{ key: <KEY> }]
                        (this is what maps the key into the Akash container env)
2. WRITE the value  ->  OpenBao cogni/<env>/<node>/<KEY>   (the rest of this guide)
```

Miss step 1 and the value sits in the vault forever while the pod boots without
it — a **silent no-op**, not an error (the class that stalled poly's copy-trade:
`PAPER_ENFORCE_MODE` was in the vault but absent from `secret_refs`).

Which keys you must declare:

- **Profile keys are implied — do NOT list them.** A service with
  `runtime_profile: cogni-node-app-v1` automatically receives the profile's
  boot-contract keys (`AUTH_SECRET`, `DATABASE_URL`, `DATABASE_SERVICE_URL`,
  `EVM_RPC_URL`, `LITELLM_VIRTUAL_KEY`, `SCHEDULER_API_TOKEN`,
  `BILLING_INGEST_TOKEN`) — the operator unions them in at build time
  (`resolveRuntimeProfileSecretRefs`, `@cogni/repo-spec`). Re-listing them is
  redundant and was pruned fleet-wide (cogni #2401).
- **Node-specific keys you MUST declare** — anything beyond the profile
  (paper-trading flags, wallet creds, CLOB/mirror keys, a node's own vendor
  token) only reaches the pod if it appears in that service's `secret_refs`.

The set a flight actually projects is logged (names only, never values) as
`compute.workload.secret_refs_resolved` on stderr of `materialize-compute-workload`
— read it in the flight log to confirm your key is in the mounted set.

`secret_refs` carries **key names only, never values** — values live in OpenBao
(§ Runtime Path, above). See [`packages/repo-spec/src/node-app-deployment.ts`](../../packages/repo-spec/src/node-app-deployment.ts)
for the profile contract.

## Known shortcoming — on Akash, a changed value is inert until a redeploy (no Reloader)

Declaring the ref and writing the value gets the secret to the pod **at boot**.
But **changing** a value later (a day-2 write, a rotation) does **not** reach a
**running Akash pod on its own** — there is no Reloader on the Akash lane:

| Lane      | Secret value change → running pod picks it up?                                                                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **k3s**   | **Automatic.** ESO syncs the k8s Secret, Stakater Reloader rolling-restarts the pod (`secrets-management.md` Invariant 11). Zero action.                                                               |
| **Akash** | **No.** The pod is a lease reconciled by Argo CD off the `deploy/<env>-<node>` head (`BRANCH_HEAD_IS_LEASE`, `ci-cd.md` Axiom 18). Reloader does not watch leases — the running pod keeps its old env. |

So after `POST /api/v1/nodes/<id>/secrets` (or any rotation) on an Akash node the
value is stored but **inert** until the deploy-branch head moves. A same-SHA
re-flight is an Argo CD **no-op** (identical content) and will NOT restart the
pod. To make a changed value take effect, **force a new deploy head** — bump the
source SHA (new image → new head) or otherwise change the deploy-branch content.

**Verify, don't assume:** `secret written 200` ≠ `pod has the secret`. After the
redeploy, read `/version` + the pod's own logs/behavior. (Proven live 2026-09-24:
poly's `PAPER_ENFORCE_MODE` synced to OpenBao but the pre-sync pod ran on for
minutes; a same-SHA re-flight changed nothing.)

Tracked for a proper fix (an Akash Reloader-equivalent — auto-bump
`leaseGeneration` on a value diff so Argo CD redeploys without an image rebuild):
[`bug.5256`](https://cognidao.org/work/items/bug.5256).

## Authority Gate

A secret decision has three orthogonal axes — `origin` / `custody` / `consumers`.
The canonical table + rules live in the spec: see
[`secrets-management.md` § Authority Model](../spec/secrets-management.md#authority-model).
Do not re-derive them here.

The one rule you need at the keyboard: **if a value is consumed by a pod,
provisions a pod-facing role, or must agree with a pod-facing value, its custody
is OpenBao.** VM `.env` files are rendered views for Compose, not authorities.
GitHub Environment Secrets carry only CI-only/bootstrap credentials or sealed
staging for a workflow that writes OpenBao.

For DB material, this means:

- `POSTGRES_ROOT_PASSWORD` may remain Compose/bootstrap-only for now because no
  pod should use it.
- `APP_DB_PASSWORD`, `APP_DB_SERVICE_PASSWORD`,
  `APP_DB_READONLY_PASSWORD`, `DOLTGRES_PASSWORD`,
  `DOLTGRES_READER_PASSWORD`, and `DOLTGRES_WRITER_PASSWORD` are
  OpenBao-custodied when they create roles or support pod-facing DSNs.
- `DATABASE_URL`, `DATABASE_SERVICE_URL`, and `DOLTGRES_URL` may be rendered
  from components, but those components must be OpenBao-owned.

## New Wizard Nodes

Do not use this guide to invent a per-node human secret for a freshly wizarded
ordinary node. The per-node human-secret list is empty.

Use the YAML catalog for the current key-level classification and
[`secrets-classification.md`](../spec/secrets-classification.md#node-wizard-formation-contract)
for the node-wizard formation boundary.

If a needed environment value is missing, repair the environment bank before
rerunning flight. Do not pass the value through candidate-flight inputs, save
it in the wizard, or add it to the node formation PR.

## 1. Confirm The Destination

Identify:

- `<env>`: `candidate-a`, `preview`, or `production`
- `<service>`: catalog service name, such as `operator`, `node-template`, `scheduler-worker`, or `_shared`
- `<KEY>`: uppercase env var name
- `<namespace>`: the k8s namespace, such as `cogni-production`
- `<externalsecret>` and `<secret>`: usually `<service>-env-secrets`; the operator also follows this shape as `operator-env-secrets`
- `<deployment>`: the Deployment that consumes the Secret

## 2. Choose The Writer Lane

Three lanes, by `source` and who you are. Pick before you touch anything. The
**self-serve API is the default lane** for a node owner; the CLI lane is
break-glass admin (see the the hub guide `node-self-serve-secrets`).

| Value kind                                                                                                                                  | Lane                                                                                                                | Who runs it                        |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `source: agent` (generated/derived — `AUTH_SECRET`, `CONNECTIONS_ENCRYPTION_KEY`, DB creds, DSNs, tokens)                                   | **Never set by hand.** `secret-materialize` mints it per node on every flight/promote.                              | the substrate (CI), automatically  |
| `source: human` vendor value (OAuth secret, API key) — **same env as the operator you call**                                                | ✅ **THE PATH — Self-serve API**: `POST /api/v1/nodes/<id>/secrets` with only an API key + `secrets_manager` grant. | node owner / their agent           |
| `source: human` vendor value — **different env** than any operator that knows the node, OR an env the API does not yet serve (preview/prod) | ⚠️ **Break-glass operator-admin CLI** (§3–8 below) against the target env's OpenBao.                                | operator-admin (kube + writer JWT) |

> **🚫 Do not self-serve a `source: agent` key.** It is minted fresh per node
> and is on the route's substrate-reserved denylist
> (`node-secrets-reserved.data.ts`) — a write is rejected `403 key_reserved`.
> Overwriting one breaks the node: `CONNECTIONS_ENCRYPTION_KEY` makes every
> stored BYO-AI connection undecryptable, `AUTH_SECRET` invalidates sessions,
> `GH_WEBHOOK_SECRET` silently fails webhook HMAC. If the value already exists,
> the substrate owns it; leave it alone.

### Self-serve API prerequisites (satisfy these first)

Before THE PATH resolves at all:

1. **The node must exist in that env's `nodes` registry.** The route resolves
   `id` (UUID or slug) against the registry (`resolveNodeRef` in
   `nodes/operator/app/src/app/_lib/node-rbac.ts`) **status-agnostically**, and
   returns **`404 node_not_found`** if the node isn't registered on the operator
   you're calling. A node registered only on prod is not resolvable on the
   candidate-a operator (and vice-versa) — this is the same fact as "cross-env is
   not yet API-reachable" below, stated as a prerequisite.
2. **A `secrets_manager` grant on that node** — `POST /nodes/{id}/access-requests
{role:"secrets_manager"}` → owner approves. The route checks
   `can_manage_secrets ← secrets_manager`, fail-closed (`503 authz_unavailable` /
   `403 authz_denied`, never owner-fallback).
3. **You call the host that serves your target env** (see the mapping below).

### Self-serve API: `env` is a required, validated body field

`POST /api/v1/nodes/<id>/secrets` takes a **required `env`** (a `FLIGHT_ENVS`
value — `candidate-a` · `preview` · `production`), mirroring deploy's
`dispatchNodePromote({ env })` and the observability logs proxy's `?env=`:

```json
{
  "env": "candidate-a",
  "key": "X_OAUTH_CLIENT_SECRET",
  "value": "…",
  "op": "set"
}
```

The operator writes only its **own** env. It compares your stated `env` to its own
`DEPLOY_ENVIRONMENT` and **`409 wrong_operator_env`** on a mismatch, naming the host
to call instead. So you state intent and a wrong target is a **loud rejection, never
a silent wrong-env write** (the bug that clobbered prod beacon). Mapping today:

| Operator host               | Serves env (accepts `env=`) |
| --------------------------- | --------------------------- |
| `https://cognidao.org`      | `production`                |
| `https://test.cognidao.org` | `candidate-a`               |

**Cross-env is still NOT delivered by self-serve today** (you must call the host
that serves your target env). A node's registry + `can_manage_secrets` grant must
also exist on that env's operator. Setting a _candidate-a_ secret for a node only
registered on prod is not yet API-reachable — use the operator-admin CLI (§3–8)
against that env's OpenBao until the env-aware node model + cross-env write adapter
land (see `docs/design/node-self-serve-secrets.md` Phase 3, deliverables D1–D4).

### A catalog `service: _shared` _human_ secret is STILL self-served

Do not confuse the **catalog service tier** `_shared` with the OpenBao **`_shared`
namespace** the self-serve route denies. They are different things:

- The route's `_shared` deny (NAMESPACE_OWNERSHIP invariant in
  `nodes/operator/app/src/app/api/v1/nodes/[id]/secrets/route.ts`) is about the
  **destination OpenBao path** — a node owner may write only their own
  `cogni/<env>/<node>/*`, never the cross-cutting `cogni/<env>/_shared` or
  `cogni/<env>/_system` paths.
- A catalog entry's `service: _shared` is a **fan-out/inheritance tier** — it means
  "every node that opts in inherits this value," not "write it to the `_shared`
  OpenBao path."

So a `service: _shared`, `source: human` catalog secret is set the normal
self-serve way: **you write it node-scoped on the OWNING node** (`cogni/<env>/<node>/<KEY>`,
via `POST /api/v1/nodes/<owning-node>/secrets`), and the materializer inherits
the shared value into other nodes on their next flight (`inherit_shared_value` in
`scripts/ci/secret-materialize.sh` scans the `node-template`/`operator`/`_shared`
ancestors and writes the value into each consuming node's own path).

**Worked example — `DOLT_CREDS_JWK`** (catalog `tier: A1`, `service: _shared`,
`source: human`, the DoltHub mirror push key): mint it once (`dolt creds new`),
then self-serve it to the owning node's path (the operator that runs the mirror),
e.g. `POST /api/v1/nodes/operator/secrets {env, key:"DOLT_CREDS_JWK", value, op:"set"}`.
`secret-materialize` then inherits it to any other node that consumes it. You never
need kube custody or the `_shared` OpenBao path for this.

### Catalog lanes (for completeness)

For `source: agent` values the deploy lane is automatic: declare the key's shape
in the catalog with `source: agent` and `secret-materialize` writes it during
flight/promote using the env writer role from CI — no laptop kubeconfig, OpenBao
root token, or Derek-owned GitHub credential. The GitHub Actions OIDC writer-role
workflow (`gha-<env>-writer`) for human values is still unbuilt; until it exists
the CLI path below is the operator day-2 path for cross-env human values.

## CLI / kube path (§3–8) — LEGACY / BREAK-GLASS ADMIN

> **⚠️ This is the break-glass / day-2 admin lane, not the node-dev contract.**
> Use it only when the [self-serve API](#the-path-self-serve-api) cannot serve
> your case — an env not yet provisioned (preview/prod, see the
> the hub guide `node-self-serve-secrets`), or a
> cross-env write. It requires kube custody + a short-lived OpenBao writer JWT
> and is operator-admin-only. A node owner adding a vendor secret on candidate-a
> should never reach this far.

## 3. Recover Kube Custody

Agent worktrees usually do not contain `.local/`. Use the operator's primary clone or the downloaded/decrypted provision artifact. Do not rely on stale VM IP/key files when a provision artifact contains the current kubeconfig.

```bash
PRIMARY_CLONE="<primary-clone>"

# Preferred if present.
export KUBECONFIG="$PRIMARY_CLONE/.local/<env>-kubeconfig.yaml"

# If the direct file is absent, use the downloaded provision artifact directory.
export KUBECONFIG="$PRIMARY_CLONE/.local/<provision-artifact-dir>/<env>-kubeconfig.yaml"

chmod 600 "$KUBECONFIG"
kubectl get ns openbao external-secrets
```

If you do not know where the provision artifact was stored, search the primary clone's `.local/` directory for `<env>-kubeconfig.yaml` and `<env>-openbao-init.json`. The kubeconfig is the day-2 access file. The OpenBao init JSON/root token is bootstrap custody and must not be used as the day-2 write token.

## 4. Prove The Substrate

Before writing a value, prove the target cluster has ESO and can read OpenBao:

```bash
kubectl get crd externalsecrets.external-secrets.io
kubectl get crd clustersecretstores.external-secrets.io
kubectl get clustersecretstore openbao-backend
kubectl -n external-secrets get deploy external-secrets external-secrets-webhook
```

For a concrete service, also prove it already consumes the ESO-backed Secret:

```bash
kubectl -n <namespace> get externalsecret <externalsecret>
kubectl -n <namespace> get deploy <deployment> -o jsonpath='{range .spec.template.spec.containers[0].envFrom[*]}{.configMapRef.name}{.secretRef.name}{"\n"}{end}'
```

If the service still consumes a legacy Secret, stop and use the service-specific cutover runbook. Do not claim an OpenBao write is live in a pod that is not wired to `operator-env-secrets` / `<service>-env-secrets`.

## 5. Mint A Short-Lived Writer Token

Open a local tunnel to OpenBao and exchange a Kubernetes ServiceAccount token for the env writer role:

```bash
kubectl -n openbao port-forward svc/openbao 8200:8200 &
export BAO_ADDR=http://127.0.0.1:8200

export BAO_TOKEN=$(bao write -field=token auth/kubernetes/login \
  role=<env>-writer \
  jwt=$(kubectl create token openbao-operator -n default))
```

Do not export `.local/<env>-openbao-root-token` as `BAO_TOKEN`. The bootstrap root token is not a day-2 write credential.

## 6. Write The Secret

Interactive:

```bash
pnpm secrets:set <env> <service> <KEY>
```

Non-interactive, when the value is already in an environment variable:

```bash
printf '%s' "$VALUE" | pnpm secrets:set <env> <service> <KEY>
```

Do not print the value, put it in argv, or paste it into a PR, workflow input, or chat.

Confirm key presence only:

```bash
bao kv get -format=json "cogni/<env>/<service>" \
  | jq -e '.data.data | has("<KEY>")' >/dev/null
```

## 7. Force ESO Sync

```bash
kubectl -n <namespace> annotate externalsecret <externalsecret> \
  force-sync="$(date +%s)" --overwrite

kubectl -n <namespace> wait externalsecret/<externalsecret> \
  --for=condition=Ready=True --timeout=120s

kubectl -n <namespace> get secret <secret> -o json \
  | jq -e '.data | has("<KEY>")' >/dev/null
```

This proves the k8s Secret has the key. It does not prove the running process has it.

## 8. Prove The Running Process

Pods read `envFrom` only at startup. After ESO sync, the Deployment must roll before `process.env.<KEY>` is live. The `reloader.stakater.com/auto: "true"` annotation auto-rolls the pod **only if Stakater Reloader is installed in the target cluster** — it is a silent no-op otherwise (the gap that left prod unrolled in bug.5040; backfill via `scripts/setup/register-substrate-apps.sh`).

Check whether Reloader exists:

```bash
kubectl get deploy,pods -A | rg -i reloader
```

If Reloader is installed and the Deployment has `reloader.stakater.com/auto: "true"`, wait for rollout:

```bash
kubectl -n <namespace> rollout status deployment/<deployment> --timeout=240s
```

Then prove process presence without printing the value:

```bash
# Replace OPENAI_API_KEY with the key you wrote.
POD=$(kubectl -n <namespace> get pod \
  -l app.kubernetes.io/name=node-app,app.kubernetes.io/instance=<service> \
  -o jsonpath='{.items[0].metadata.name}')

kubectl -n <namespace> exec "$POD" -- /bin/sh -c 'test -n "$OPENAI_API_KEY"'
```

If Reloader is absent or does not roll the pod, do not use `kubectl rollout restart` as an invisible production mutation. Use the deploy branch/GitOps path: commit a one-time pod-template restart annotation to the relevant `deploy/<env>-<service>` branch, let Argo roll it, then repeat the process-level proof. Read `devops-expert` first.

## 9. Public Health

For public web services, finish with external health/version checks:

```bash
curl -fsS https://<service-domain>/readyz
curl -fsS https://<service-domain>/version
```

Use `/version.buildSha` to verify the expected application build when a deploy changed the app image. For secret-only pod restarts, the build SHA should stay the same.

## What You Did Not Have To Do

- Edit a pod spec for a new env var.
- Create or edit a per-secret ExternalSecret.
- Hand-edit a live k8s Secret.
- Touch `OPENBAO_SEED_TOKEN`.
- Use the OpenBao root token.
- Treat a GitHub Environment secret timestamp as live pod proof.
- Treat a VM `.env` entry as runtime secret authority.

## Anti-Patterns

- Pasting secret values into chat, PRs, workflow inputs, shell history, or committed files.
- Using this guide for plain runtime config.
- Using GitHub Environment secrets as proof that an ESO-backed pod has the value.
- Classifying a pod-facing DB credential as Compose-only because a Compose
  provisioner renders it.
- Rendering a runtime value from VM `.env` when OpenBao has a different value.
- Treating k8s Secret presence as proof that a running process has the value.
- Using stale `.local/<env>-vm-ip` or SSH keys when a provision artifact contains the current kubeconfig.
- SSHing into production to run OpenBao or Kubernetes mutations instead of using the provisioned kubeconfig, Kubernetes auth, and deploy branch.
- Using `kubectl rollout restart` in production instead of a visible deploy-branch/GitOps rollout.
- Using `bao kv put` manually and replacing sibling keys. Let `pnpm secrets:set` choose `put` vs `patch`.

## CLI Behavior

`scripts/secrets/set-secret.sh`:

1. Validates `<env>` is `candidate-a`, `preview`, or `production`.
2. Validates `<service>` matches `infra/catalog/<service>.yaml` or `_shared`; refuses `_system`.
3. Validates `<KEY>` matches `^[A-Z][A-Z0-9_]*$`.
4. Reads value from stdin; never echoes.
5. Requires `BAO_ADDR` and `BAO_TOKEN`.
6. Uses `bao kv put` only for a missing path; otherwise uses `bao kv patch`.
7. Passes the value via stdin (`KEY=-`) so it never enters argv.

## Related

- [`docs/spec/secrets-management.md`](../spec/secrets-management.md)
- [`docs/guides/secrets-rotate.md`](./secrets-rotate.md)
- [`docs/runbooks/fork-quickstart.md`](../runbooks/fork-quickstart.md)
- [`docs/runbooks/production-operator-eso-cutover.md`](../runbooks/production-operator-eso-cutover.md)
- [External Secrets Operator `dataFrom` docs](https://external-secrets.io/latest/api/externalsecret/#external-secrets.io/v1.ExternalSecretDataFromRemoteRef)
- [OpenBao KV v2 docs](https://openbao.org/docs/secrets/kv/kv-v2/)
- [Stakater Reloader](https://github.com/stakater/Reloader)
