---
id: runbook.production-operator-eso-cutover
type: runbook
title: Production Operator ESO Cutover
status: draft
trust: draft
summary: Operator runbook for cutting production operator runtime secrets from the legacy app secret bridge to OpenBao + ExternalSecret without losing custody or deleting rollback keys too early.
read_when: A PR changes production operator ExternalSecret wiring, `operator-env-secrets`, production OpenBao seeding, or the production operator promote boundary.
owner: cogni-dev
created: 2026-06-05
verified: 2026-06-06
tags: [production, operator, openbao, external-secrets, cutover]
---

# Production Operator ESO Cutover

Use this when production operator is being moved from the legacy
`operator-node-app-secrets` bridge to OpenBao-sourced `operator-env-secrets`.

Before changing secrets or deploy behavior, read
[`cicd-secrets-expert`](../../.claude/skills/cicd-secrets-expert/SKILL.md).
That skill is the short-form contract for OpenBao/ESO vs GitHub env secrets,
writer-role auth, entry points, and the anti-patterns this runbook avoids.

## Current Cutover State

As of 2026-06-06:

- PR #1529 merged the production operator manifest wiring:
  `operator-env-secrets`, the `cogni/production/operator` ExternalSecret, and
  production wizard config values for `NODE_MINT_OWNER` /
  `NODE_TEMPLATE_OWNER`.
- A later legacy bridge refresh proved the GitHub-environment values can still
  reach the old `operator-node-app-secrets` path, but that is not the target
  runtime source of truth.
- A production operator app-only promote failed when Argo tried to apply
  `ExternalSecret/cogni-production/operator-env-secrets` and the destination
  cluster did not have the `external-secrets.io/ExternalSecret` CRD available.
- A later preview operator app-only promote succeeded with `deploy-infra`
  skipped. Do not infer production ESO readiness from preview.

The production gate is therefore still: production ESO substrate installed,
`ClusterSecretStore` valid, `operator-env-secrets Ready=True`, then app-only
operator promote with `skip_infra=true`.

## CI/CD Reliability Gate

This runbook is a deployment control, not background documentation. It improves
the production operator release path by turning the ESO cutover into explicit
pass/fail gates that CI/CD operators can execute before a promote:

- production app changes use `promote-and-deploy.yml` with `nodes=operator` and
  `skip_infra=true` unless the PR changes Compose/runtime infra;
- production substrate readiness is proven by live Kubernetes API checks for the
  ESO CRDs, `external-secrets` controllers, and `ClusterSecretStore`;
- runtime readiness is proven by `ExternalSecret/operator-env-secrets
Ready=True`, then public `/readyz` and `/version.buildSha`;
- legacy bridge cleanup is delayed until production serves the expected build
  SHA and rollback custody is closed.

The concrete reliability improvement is eliminating the ambiguous state where
GitHub environment secrets, Compose deploy-infra, and OpenBao/ESO all appear to
manage the same operator runtime values. The gate makes OpenBao +
`operator-env-secrets` the only target runtime source of truth while keeping the
legacy bridge available only as rollback custody until the final cleanup step.

## Rules

- Do not declare "no kube/SSH access" until you have checked the primary clone's
  durable `.local/` directory and the provision init artifacts.
- Do not print secret values. List file names, permissions, sizes, and command
  success only.
- Do not use `.local/<env>-openbao-root-token` for day-2 writes. Use the
  Kubernetes writer role or a production-approved workflow path.
- Do not delete stale VM keys or old `.local` material until production is
  serving the expected `/version.buildSha` and the rollback window is closed.
- Do not run a full infra promote for an app-only cutover unless the PR changes
  Compose/runtime infra. Use `skip_infra=true` when only k8s app manifests and
  OpenBao data are changing.
- Do not treat `nodes=operator` as making `deploy-infra` operator-scoped. The
  `deploy-infra` job is environment-level; unless `k8s-secrets-only` is
  explicitly selected, it reconciles Compose and the legacy k8s secret bridge.

## Access Discovery

Conductor workspaces are git worktrees; they usually do not contain `.local/`.
Look in the operator's primary clone before reporting a blocker:

```bash
PRIMARY_CLONE="${COGNI_PRIMARY_CLONE:-$HOME/dev/cogni-template}"

test -d "$PRIMARY_CLONE/.local" || {
  echo "missing primary .local: $PRIMARY_CLONE/.local"
  exit 1
}

find "$PRIMARY_CLONE/.local" -maxdepth 1 -type f \
  \( -name 'production-*' -o -name 'preview-*' -o -name 'candidate-a-*' \) \
  -print0 | xargs -0 ls -l
```

Expected production files when this laptop is the provisioner:

```text
.local/production-vm-key
.local/production-vm-ip
.local/production-init-passphrase.txt
```

If present, prefer these local Kubernetes custody files:

```text
.local/production-kubeconfig.yaml
.local/production-openbao-init.json
```

If they are absent, check the GitHub Actions init artifact before declaring the
environment unrecoverable:

```bash
gh api repos/Cogni-DAO/cogni/actions/artifacts \
  --jq '.artifacts[] | select(.name=="production-init-artifacts") | [.id,.created_at,.expired] | @tsv'
```

Only decrypt artifacts into `.local/` with the matching
`.local/production-init-passphrase.txt`, then `chmod 600` the kubeconfig, VM key,
and OpenBao init JSON. A clean decrypt is not enough; validate credentials
against the live cluster before trusting them.

## Preflight

1. Confirm the PR renders the production operator overlay with exactly one
   operator ExternalSecret and no legacy `operator-node-app-secrets` references:

   ```bash
   kubectl kustomize infra/k8s/overlays/production/operator \
     | tee /tmp/production-operator.yaml >/dev/null

   rg -n 'kind: ExternalSecret|operator-env-secrets|operator-node-app-secrets' \
     /tmp/production-operator.yaml
   ```

2. Confirm public production is healthy before touching the cutover:

   ```bash
   curl -fsS https://cognidao.org/readyz
   curl -fsS https://cognidao.org/version
   ```

3. Confirm OpenBao access uses a short-lived role token, not the root token:

   ```bash
   export KUBECONFIG="$PRIMARY_CLONE/.local/production-kubeconfig.yaml"
   kubectl get ns openbao

   kubectl -n openbao port-forward svc/openbao 8200:8200 &
   export BAO_ADDR=http://127.0.0.1:8200
   export BAO_TOKEN="$(
     bao write -field=token auth/kubernetes/login \
       role=production-writer \
       jwt="$(kubectl create token openbao-operator -n default)"
   )"
   bao token lookup -self >/dev/null
   ```

If production lacks a local kubeconfig but has only `production-vm-key`, record
that exact state. The key is legacy custody material, not proof that the normal
day-2 OpenBao write path exists.

## Edge And Cert Custody

The production TLS certificates are owned by the edge Caddy stack, not by the
operator pod and not by OpenBao:

```text
/opt/cogni-template-edge/docker-compose.yml
docker volume cogni-edge_caddy_data   -> Caddy /data
docker volume cogni-edge_caddy_config -> Caddy /config
```

Do not prune `cogni-edge_caddy_data` or `cogni-edge_caddy_config` during key
cleanup. They persist ACME material and Caddy config state. See
[`infra/compose/edge/AGENTS.md`](../../infra/compose/edge/AGENTS.md) for the
edge-stack contract.

## Substrate Gate

Before applying or waiting on `operator-env-secrets`, prove production has the
ESO CRDs and store:

```bash
kubectl get crd externalsecrets.external-secrets.io
kubectl get crd clustersecretstores.external-secrets.io
kubectl get clustersecretstore openbao-backend
kubectl -n external-secrets get deploy external-secrets external-secrets-webhook
```

If any of these are absent, do not rerun `deploy-infra` as a substitute. Reconcile
the OpenBao/ESO substrate first using the provisioned Argo Applications or the
environment bootstrap path, then continue with seeding and force-sync.

## Seed

Seed `cogni/production/operator` with the operator runtime values already
approved for production. Use the CLI or the per-operation workflow when it
exists; do not paste values into chat, PRs, or workflow inputs.

```bash
pnpm secrets:set production operator GH_REVIEW_APP_ID
pnpm secrets:set production operator GH_REVIEW_APP_PRIVATE_KEY_BASE64
pnpm secrets:set production operator GH_WEBHOOK_SECRET
pnpm secrets:set production operator AUTH_SECRET
pnpm secrets:set production operator DATABASE_URL
pnpm secrets:set production operator DOLTGRES_URL
```

Adjust the key list to the catalog. The invariant is that every key consumed by
the production operator pod exists at `cogni/production/operator` before the
Deployment switches to `operator-env-secrets`.

## Force Sync

After the PR's ExternalSecret manifest is applied by the production deploy
branch, force one ESO reconcile:

```bash
kubectl -n cogni-production annotate externalsecret operator-env-secrets \
  force-sync="$(date +%s)" --overwrite

kubectl -n cogni-production wait externalsecret/operator-env-secrets \
  --for=condition=Ready=True --timeout=120s

kubectl -n cogni-production get secret operator-env-secrets
```

The wait must report `Ready=True`. Do not inspect or print Secret values.

## Promote

For an app-only production operator ESO cutover, dispatch production promotion
from `main` with infra skipped:

```bash
SOURCE_SHA=<main-sha-containing-the-cutover>

gh workflow run promote-and-deploy.yml --repo Cogni-DAO/cogni --ref main \
  -f environment=production \
  -f source_sha="$SOURCE_SHA" \
  -f build_sha="$SOURCE_SHA" \
  -f nodes=operator \
  -f skip_infra=true
```

Use `skip_infra=false` only when the PR also changes Compose/runtime infra that
must be reconciled for the cutover. Watch the workflow to terminal state and
then verify from outside the cluster:

```bash
curl -fsS https://cognidao.org/readyz
curl -fsS https://cognidao.org/version
```

`/readyz` proves service health. `/version.buildSha` proves the new operator pod
is serving.

## Rollback

If `operator-env-secrets` is not `Ready=True`, do not promote. Fix the OpenBao
path, role, or ExternalSecret first.

If promotion completes but production is not serving the expected build SHA,
roll back by promoting the prior known-good production operator digest through
the same deploy branch and workflow. Do not repair production with direct
`kubectl edit` or a hand-written Secret.

## Cleanup Last

Only after production is healthy on the expected build SHA and the rollback
window is closed:

1. Inventory stale `.local` material and old VM keys.
2. Confirm no active workflow or rollback path depends on them.
3. Revoke or rotate obsolete VM SSH keys.
4. Remove destroyed-VM local files from the primary clone.
5. Update the work item or PR with the cleanup evidence.

This cleanup is intentionally last. During a production cutover, custody and
rollback beat tidiness.

## Related

- [`docs/spec/secrets-management.md`](../spec/secrets-management.md)
- [`docs/guides/secrets-add-new.md`](../guides/secrets-add-new.md)
- [`docs/guides/secrets-rotate.md`](../guides/secrets-rotate.md)
- [`docs/guides/multi-node-deploy.md`](../guides/multi-node-deploy.md)
- [`infra/compose/edge/AGENTS.md`](../../infra/compose/edge/AGENTS.md)
- [`cicd-secrets-expert`](../../.claude/skills/cicd-secrets-expert/SKILL.md)
