---
id: github-app-webhook-setup-guide
type: guide
title: GitHub App Setup — Local, Preview, Production
status: active
trust: draft
summary: Create GitHub Apps for webhook ingestion + PR review. One app per environment (local dev, preview, production) because each app has one webhook URL.
read_when: Setting up GitHub webhook ingestion or PR review for any environment.
owner: derekg1729
created: 2026-03-06
verified: 2026-03-11
tags: [github, webhooks, ingestion, review, setup]
---

# GitHub App Setup

> One GitHub App per environment. Each app has one webhook URL — you cannot share an app across local/preview/production.

| Environment | App name convention           | Webhook URL                                                 | Install on                    |
| ----------- | ----------------------------- | ----------------------------------------------------------- | ----------------------------- |
| Local dev   | `cogni-review-dev-<yourname>` | smee.io proxy (see below)                                   | your personal test repo       |
| candidate/test | `cogni-operator-test`      | `https://test.cognidao.org/api/internal/webhooks/github`    | all repos on `cogni-test-org` |
| Preview     | `cogni-review-preview`        | `https://preview.cognidao.org/api/internal/webhooks/github` | `Cogni-DAO/preview-test-repo` |
| Production  | `cogni-review-production`     | `https://cognidao.org/api/internal/webhooks/github`         | `Cogni-DAO/cogni`             |

> The webhook source path is `github` (`api/internal/webhooks/[source]/route.ts` → `source === "github"` reads `GH_WEBHOOK_SECRET`). Review is **payload-driven** — the operator reviews whatever installed repo sends a verified webhook; `GH_REPOS` scopes only the proactive pr-manager, not the review webhook.
>
> `Cogni-DAO/test-repo` is a legacy review-only fixture. It does not satisfy the
> node publish/flight path. Candidate/test node e2e uses the disposable GitHub
> org `cogni-test-org` plus the DoltHub org `cogni-test-nodes`; the test App must
> be installed on all repos in `cogni-test-org` so it can fork `node-template`,
> commit minted node identity, open parent pin PRs in `cogni-monorepo`, and see
> repos that do not exist yet.

## Create a GitHub App

1. Go to `https://github.com/organizations/Cogni-DAO/settings/apps/new` (org) or `https://github.com/settings/apps/new` (personal)

2. Fill in:

| Field          | Value                                |
| -------------- | ------------------------------------ |
| App name       | See table above                      |
| Homepage URL   | `https://github.com/Cogni-DAO/cogni` |
| Webhook URL    | See table above                      |
| Webhook secret | Generate below                       |
| Webhook active | Checked                              |

3. **Permissions (Repository):**

| Permission    | Access       | Why                                         |
| ------------- | ------------ | ------------------------------------------- |
| Actions       | Read & write | PR Manager triggers workflow runs (future)  |
| Checks        | Read & write | PR review creates Check Runs                |
| Contents      | Read & write | PR Manager merges PRs, creates branches     |
| Issues        | Read-only    | Attribution ingestion                       |
| Pull requests | Read & write | PR review posts comments, PR Manager merges |

**Permissions (Organization)** — required only for the operator App that **mints node repos** (node-formation Publish → `forkFromTemplate`):

| Permission     | Access       | Why                                                                                                                                                  |
| -------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Administration | Read & write | `POST /repos/{templateOwner}/node-template/forks` creates the node's named fork (`<mintOwner>/<slug>`) from `node-template`. Without it, Publish 403s. |

> **Install scope for the minting App.** Step 7's single-repo install is enough for _review_ (payload-driven), but an App that **creates + commits to** new node repos must reach repos that don't exist yet. A `selected`-repos install means a freshly-minted `<owner>/<slug>` is **invisible to the App** → the identity-commit 404s even with `administration: write`. So the minting App needs **"All repositories"** on a dedicated nodes/test org (`cogni-test-org` for candidate/test; a production nodes org for live node birth) so it is not org-wide over unrelated operator infra repos. See [node-formation.md § Node Publish](../spec/node-formation.md) + [node-ci-cd-contract.md § Submodule-pinned nodes](../spec/node-ci-cd-contract.md).

4. **Subscribe to events:** Issues, Issue comment, Pull request, Pull request review, Push

5. Click **Create GitHub App**. Note the **App ID**.

6. **Generate a private key:** App settings → Private keys → Generate. Download the `.pem` file.

7. **Install the app:** App settings → Install App → select the target repo from the table above.

## Configure Secrets

### Generate values

```bash
# Webhook secret
WEBHOOK_SECRET=$(openssl rand -hex 20)
echo "Webhook secret: $WEBHOOK_SECRET"
# Paste this into the GitHub App's webhook secret field

# Base64-encode the private key
APP_KEY=$(base64 < ~/Downloads/<app-name>.*.private-key.pem | tr -d '\n')
echo "Base64 key: $APP_KEY"
```

### Local dev — `.env.local`

```bash
GH_REVIEW_APP_ID=<app-id>
GH_REVIEW_APP_PRIVATE_KEY_BASE64=<base64-key>
GH_REPOS=<owner>/<test-repo>
GH_WEBHOOK_SECRET=<webhook-secret>
GH_WEBHOOK_PROXY_URL=https://smee.io/<your-channel>  # see below
```

### Deployed envs — the pod reads OpenBao (ESO), not GitHub env secrets

Post-ESO migration (`task.5094`/#1460), the running operator pod consumes
`GH_REVIEW_APP_ID` / `GH_REVIEW_APP_PRIVATE_KEY_BASE64` / `GH_WEBHOOK_SECRET` from OpenBao at
`cogni/<env>/operator/*` (ESO → `operator-env-secrets` → `envFrom`). A `gh secret set --env <env>`
only reaches the pod on the **next provision** (it seeds the GitHub env that provisioning fans into
OpenBao). To configure a **live, already-provisioned env** (e.g. candidate-a) **now**, write straight
to OpenBao and bounce the pod — see [`secrets-add-new.md`](./secrets-add-new.md):

```bash
# Live env (no reprovision). Path = the operator pod's extract: cogni/<env>/operator/*.
pnpm secrets:set candidate-a operator GH_REVIEW_APP_ID                 # paste App ID
pnpm secrets:set candidate-a operator GH_REVIEW_APP_PRIVATE_KEY_BASE64 # paste base64 PEM
pnpm secrets:set candidate-a operator GH_WEBHOOK_SECRET                # paste the App's webhook secret
kubectl rollout restart deploy/operator-node-app -n cogni-candidate-a  # until Reloader is cluster-wide
```

Set both copies of the webhook secret to the **same** value — the App's webhook-secret field and
`GH_WEBHOOK_SECRET` in OpenBao — or signature verification 401s (the dual-plane class, `bug.5000`).

### Preview / Production — GitHub env secrets (seed for the NEXT provision)

```bash
# Preview
APP_ID=<preview-app-id>
gh secret set GH_REVIEW_APP_ID --repo Cogni-DAO/cogni --env preview --body "$APP_ID"
gh secret set GH_REVIEW_APP_PRIVATE_KEY_BASE64 --repo Cogni-DAO/cogni --env preview --body "$APP_KEY"
gh secret set GH_WEBHOOK_SECRET --repo Cogni-DAO/cogni --env preview --body "$WEBHOOK_SECRET"
gh variable set GH_REPOS --repo Cogni-DAO/cogni --env preview --body "Cogni-DAO/preview-test-repo"

# Production
APP_ID=<prod-app-id>
gh secret set GH_REVIEW_APP_ID --repo Cogni-DAO/cogni --env production --body "$APP_ID"
gh secret set GH_REVIEW_APP_PRIVATE_KEY_BASE64 --repo Cogni-DAO/cogni --env production --body "$APP_KEY"
gh secret set GH_WEBHOOK_SECRET --repo Cogni-DAO/cogni --env production --body "$WEBHOOK_SECRET"
gh variable set GH_REPOS --repo Cogni-DAO/cogni --env production --body "Cogni-DAO/cogni"
```

## Local Dev — smee.io Webhook Proxy

GitHub can't reach localhost. Use smee.io to forward webhooks.

1. Go to `https://smee.io/new` — copy the channel URL
2. Set it as the GitHub App's webhook URL
3. Add `GH_WEBHOOK_PROXY_URL=<smee-url>` to `.env.local`
4. Run `pnpm dev:smee` in a separate terminal
5. Run `pnpm dev:stack`

Test: push a commit or open a PR on your test repo. Check smee dashboard + app logs.

## Verify

1. Open a PR on the target repo (or `pnpm dev:trigger-github` for local dev)
2. GitHub App → Advanced → Recent Deliveries: green checkmarks
3. PR shows "Cogni Git PR Review" Check Run + review comment

## Troubleshooting

| Symptom                 | Fix                                              |
| ----------------------- | ------------------------------------------------ |
| 404 from webhook route  | `GH_WEBHOOK_SECRET` not set — add it and restart |
| 401 from webhook route  | Secret mismatch — compare app config vs env var  |
| Check Run never appears | App missing `checks:write` permission            |
| Review silently skipped | `GH_REVIEW_APP_ID` or private key not configured |
| No smee forwarding      | `pnpm dev:smee` not running                      |
