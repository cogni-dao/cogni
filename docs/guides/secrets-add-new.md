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

Updating a pod-consumed secret is a control-plane operation: OpenBao write, ESO sync, pod restart proof. Do not edit pod specs, create per-secret ExternalSecrets, or hand-edit k8s Secret YAML.

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

## Authority Gate

Before choosing a tier, separate three concepts:

| Axis        | Values                                   | Question                       |
| ----------- | ---------------------------------------- | ------------------------------ |
| `origin`    | `agent` · `human` · `derived`            | Who can produce the bytes?     |
| `custody`   | `openbao` · `github-env` · `repo-config` | Which system is authoritative? |
| `consumers` | `pod` · `compose` · `ci` · `external`    | Where does the value get used? |

The rule is strict: if a value is consumed by a pod, provisions a pod-facing
role, or must agree with a pod-facing value, custody is OpenBao. VM `.env`
files are rendered views for Compose, not authorities. GitHub Environment
Secrets may carry CI-only/bootstrap credentials or sealed staging for a
workflow that writes OpenBao; they are not the source of truth for app/runtime
credentials.

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

For generated node-owned values, prefer the deploy lane: declare the key's
shape in the node catalog with `source: agent`, then let
`secret-materialize` write the value during flight/promote. That path uses the
environment writer role from CI and does not require a laptop kubeconfig,
OpenBao root token, or Derek-owned GitHub credential.

For human/vendor values, the **shipped** self-serve lane is the operator API —
`POST /api/v1/nodes/<id>/secrets`, OpenFGA `can_manage_secrets`, caller holds only
an API key, no kube (candidate-a + **production live**, #1627 + #1737). That is the
node owner's path; the how-to lives in the node guide `add-secret.md` (node-template
→ every fork) and the hub entry `node-self-serve-secrets`.

**The CLI path below is the admin/ops fallback** — the env's OpenBao writer-role
path for operators who already hold kube custody. A node owner should use the
self-serve API, not this. (`secrets_manager` is per-node **authority**, not the
operator's writer **custody** — don't conflate them.)

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

Pods read `envFrom` only at startup. After ESO sync, the Deployment must roll before `process.env.<KEY>` is live.

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
