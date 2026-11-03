---
id: guide.multi-node-deploy
type: guide
title: Multi-Node Deployment — k3s + Argo CD
status: draft
trust: draft
summary: Provision a VM, set up GitHub environment secrets, and deploy operator + poly + resy via the trunk-based candidate-a → preview → production pipeline.
read_when: Setting up a new deployment environment (candidate-a, preview, production), forking node-template, debugging CI/CD pipeline shape
owner: derekg1729
created: 2026-04-03
verified: 2026-05-05
tags: [deployment, k3s, argo-cd, ci-cd, infrastructure]
---

# Multi-Node Deployment — k3s + Argo CD

> **Scope note:** this doc covers the **legacy k3s app lane + state substrate**. Node apps target Akash via the operator compute API per [ci-cd.md](../spec/ci-cd.md) Axiom 23 (`AKASH_IS_NODE_APP_TARGET`, gated on story.5016); the k3s cluster remains the state substrate (`CHERRY_IS_STATE_SUBSTRATE`, Axiom 24).

## Architecture

```
PR open                        →  pr-build.yml (affected-only build, push pr-{N}-{sha} images to GHCR)
selected PR (workflow_dispatch) →  candidate-flight.yml      → write deploy/candidate-a-{node}     → Argo CD
merge to main                   →  flight-preview.yml         → write deploy/preview-{node}        → Argo CD
manual /promote (production)    →  promote-and-deploy.yml     → write deploy/production-{node}    → Argo CD
```

**Two trust surfaces, one repo:**

- **Code branches** (`main`, `feature/*`) — code changes, human-reviewed PRs.
- **Deploy branches** — per-node, machine-written, direct bot commits (no PRs).
  - Layout: `deploy/{env}-{node}` for `env ∈ {candidate-a, preview, production}` and `node ∈ {operator, poly, resy, scheduler-worker}`.
  - Each branch is an orphan tree containing only the kustomize overlay state Argo CD reconciles. Per-node split landed in `task.0376`; pre-split `deploy/{env}` branches still exist as legacy refs but the pipeline writes the per-node ones.

Argo CD runs apps (operator, poly, resy, scheduler-worker) on k3s. Compose runs supporting infra (Postgres, Temporal, LiteLLM, Redis, Doltgres, Caddy) directly on the VM. The full pipeline contract lives in [`cd-pipeline-e2e.md`](../spec/cd-pipeline-e2e.md) and [`ci-cd.md`](../spec/ci-cd.md). Canary was retired in `bug.0312`; do not look for it.

## 1. Provision VM (~5 min)

One command per environment. Bootstraps Docker + k3s + Argo CD + Compose infra; provisions the Cherry Servers VM via OpenTofu; writes the SSH key + IP to `.local/`.

```bash
# candidate-a (pre-merge slot, default DNS = test.cognidao.org)
CHERRY_AUTH_TOKEN=<token> DOMAIN=test.cognidao.org \
  bash scripts/setup/provision-test-vm.sh candidate-a

# preview (long-lived, DNS = preview.cognidao.org)
CHERRY_AUTH_TOKEN=<token> bash scripts/setup/provision-test-vm.sh preview

# production (long-lived, DNS = cognidao.org)
CHERRY_AUTH_TOKEN=<token> bash scripts/setup/provision-test-vm.sh production
```

Outputs (gitignored):

- `.local/{env}-vm-key` — SSH private key for `root@<VM_IP>`
- `.local/{env}-vm-ip` — VM IP (single line)
- `.local/{env}-vm-age-key` — sops/age key for sealed-secret decryption

See [`provision-test-vm.sh`](../../scripts/setup/provision-test-vm.sh) for the full lifecycle.

## 2. Set DNS (3 A records per environment)

All point to the VM IP. URL pattern: `{DOMAIN}`, `poly-{DOMAIN}`, `resy-{DOMAIN}`.

| env         | operator               | poly                        | resy                        |
| ----------- | ---------------------- | --------------------------- | --------------------------- |
| candidate-a | `test.cognidao.org`    | `poly-test.cognidao.org`    | `resy-test.cognidao.org`    |
| preview     | `preview.cognidao.org` | `poly-preview.cognidao.org` | `resy-preview.cognidao.org` |
| production  | `cognidao.org`         | `poly.cognidao.org`         | `resy.cognidao.org`         |

Use `/dns-ops` skill or Cloudflare dashboard.

## 3. GitHub Environment + Secrets (~1 min)

Repository-level (already set, do not rotate without a coordinated rollout): `ACTIONS_AUTOMATION_BOT_PAT`. `GITHUB_TOKEN` handles GHCR push automatically.

Per-environment (one block per env you provision):

```bash
ENV=candidate-a   # or preview, production
gh api repos/Cogni-DAO/cogni/environments/$ENV -X PUT --silent
gh secret set VM_HOST          --repo Cogni-DAO/cogni --env $ENV --body "$(cat .local/$ENV-vm-ip)"
gh secret set SSH_DEPLOY_KEY   --repo Cogni-DAO/cogni --env $ENV < .local/$ENV-vm-key
gh variable set DOMAIN         --repo Cogni-DAO/cogni --env $ENV --body "$( case $ENV in candidate-a) echo test.cognidao.org;; preview) echo preview.cognidao.org;; production) echo cognidao.org;; esac )"
```

App secrets (LITELLM_MASTER_KEY, AUTH_SECRET, …) live as k8s sealed-secrets on the cluster, written by the provision script via `pnpm setup:secrets`. They are **not** GitHub secrets.

## 4. Trigger the pipeline

There is no auto-trigger on a `canary` push (canary is dead). You enter the pipeline through one of three doors:

- **Routine PR work**: open a PR. `pr-build.yml` builds affected images and pushes `pr-{N}-{sha}` tags. Nothing deploys yet.
- **Validate a PR on candidate-a**: dispatch `candidate-flight.yml` with the PR number. The workflow resolves the `pr-{N}-{sha}` digests, writes them to `deploy/candidate-a-{node}`, and Argo reconciles. See [`candidate-flight-v0.md`](./candidate-flight-v0.md).
- **Promote to preview / production**: merging to main fires `flight-preview.yml` automatically. Production is **manual only** — a human dispatches `promote-and-deploy.yml` with `environment=production` and the `source_sha` currently green on preview. Use the `/promote` skill.

Watch in the Actions tab. The end-of-deploy gate is `verify-buildsha.sh` curling `/version.buildSha` and asserting it matches the expected SHA. CI conclusions can lie about deploys; `/version.buildSha` is the source of truth.

## 5. Manual deploy-branch surgery (last resort)

The pipeline writes deploy branches; humans rarely should. When you must (kill switch, recovery), edit the per-node branch directly:

```bash
git clone --single-branch -b deploy/candidate-a-poly <repo-url> /tmp/deploy-poly
cd /tmp/deploy-poly
# Edit infra/k8s/overlays/candidate-a/poly/kustomization.yaml — change the digest field
git commit -am "chore(cd): manual digest update [poly]" && git push
# Argo syncs within 30s; verify via curl below.
```

For preview / production, use `/promote` rather than direct surgery — it handles the lease + rollout-status verification properly.

## 6. Verify

```bash
ENV=candidate-a   # or preview, production

# Hit each node's /version from outside the cluster (the only honest deploy probe)
case "$ENV" in
  candidate-a) BASE=test.cognidao.org ;;
  preview)     BASE=preview.cognidao.org ;;
  production)  BASE=cognidao.org ;;
esac
curl -sk "https://${BASE}/version" | jq .buildSha
curl -sk "https://poly-${BASE/cognidao.org/}cognidao.org/version" | jq .buildSha
curl -sk "https://resy-${BASE/cognidao.org/}cognidao.org/version" | jq .buildSha

# In-cluster checks (READ-ONLY SSH only, candidate-a allowed; preview discouraged; production forbidden)
ssh -i .local/$ENV-vm-key root@$(cat .local/$ENV-vm-ip) "kubectl -n argocd get applications"
ssh -i .local/$ENV-vm-key root@$(cat .local/$ENV-vm-ip) "kubectl -n cogni-$ENV get pods"
```

## 7. Sizing

Every node-app inherits the **Tier 0** memory standard from `infra/k8s/base/node-app/deployment.yaml`:

- 512Mi container limit, 256Mi request
- `NODE_OPTIONS=--max-old-space-size=384`

If a node OOMs at Tier 0 in production (Loki signal: `{stream="stderr"} |~ "FATAL ERROR"`), bump it via overlay patch — **never silently override container memory without paired NODE_OPTIONS** (V8 auto-sizes to ~50% of cgroup, ignoring un-paired memory bumps; this is what produced `bug.5012`). The full tier table, formula, and traffic-vs-memory model live in [`docs/research/nextjs-node-memory-sizing.md`](../research/nextjs-node-memory-sizing.md). `infra/k8s/overlays/production/poly/kustomization.yaml` is the reference Tier-1 patch.

## 8. Destroy

```bash
ENV=candidate-a
cd infra/provision/cherry/base
tofu workspace select $ENV
tofu destroy -var-file=terraform.$ENV.tfvars
```

## Related

- [`INFRASTRUCTURE_SETUP.md`](../runbooks/INFRASTRUCTURE_SETUP.md) — full secret catalog + SSH key generation
- [`cd-pipeline-e2e.md`](../spec/cd-pipeline-e2e.md) — pipeline contract + networking
- [`ci-cd.md`](../spec/ci-cd.md) — operating rules, branch model, environments
- [cicd-e2e-required-sequence](https://cognidao.org/knowledge/cicd-e2e-required-sequence) (hub) — ship one PR to candidate-a and beyond
- [`multi-node-dev.md`](./multi-node-dev.md) — local development guide
- `pnpm setup:secrets` — interactive secret provisioning (preview, candidate-a, production)
