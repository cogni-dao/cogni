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
verified: 2026-06-07
tags: [github, webhooks, ingestion, review, setup]
---

# GitHub App Setup

> One GitHub App per environment. Each app has one webhook URL — you cannot share an app across local/preview/production.

| Environment            | App name                      | App ID    | Install ID  | Webhook URL                                                 | Install on                    |
| ---------------------- | ----------------------------- | --------- | ----------- | ----------------------------------------------------------- | ----------------------------- |
| Local dev              | `cogni-review-dev-<yourname>` | per-dev   | per-dev     | smee.io proxy (see below)                                   | your personal test repo       |
| candidate/test         | `cogni-operator-test`         | `3956976` | `138046799` | `https://test.cognidao.org/api/internal/webhooks/github`    | all repos on `cogni-test-org` |
| Preview review-only    | `cogni-git-review-preview`    | `2011345` | `87655574`  | `https://preview.cognidao.org/api/internal/webhooks/github` | selected preview repos        |
| Production review-only | `cogni-git-review`            | `1761205` | `80293097`  | `https://cognidao.org/api/internal/webhooks/github`         | `Cogni-DAO/cogni`             |
| Production operator    | `cogni-operator`              | `2994706` | `113665458` | `https://cognidao.org/api/internal/webhooks/github`         | all repos on `Cogni-DAO`      |

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

### Review-only App permissions

Use these for local dev and review-only preview/production Apps. They can receive webhooks,
create check runs, review PRs, and drive PR-manager on already-installed repos. They do not mint
node repos and they do not validate node GHCR packages.

| Permission    | Access       | Why                                         |
| ------------- | ------------ | ------------------------------------------- |
| Actions       | Read & write | PR Manager triggers workflow runs (future)  |
| Checks        | Read & write | PR review creates Check Runs                |
| Contents      | Read & write | PR Manager merges PRs, creates branches     |
| Issues        | Read-only    | Attribution ingestion                       |
| Pull requests | Read & write | PR review posts comments, PR Manager merges |
| Workflows     | Read & write | PR Manager may author workflow files        |

### Operator mint/flight App permissions

Use these for `cogni-operator-test` and `cogni-operator`. This is the App that backs
`GH_REVIEW_APP_ID` in the operator pod and is allowed to mint node repos, write node identity,
open parent pin PRs, and dispatch candidate-flight.

| Permission     | Access       | Why                                                                                              |
| -------------- | ------------ | ------------------------------------------------------------------------------------------------ |
| Actions        | Read & write | Dispatches `candidate-flight.yml` with `workflow_dispatch`.                                      |
| Administration | Read & write | Creates named forks from `node-template` and changes repo settings needed by node birth.         |
| Checks         | Read & write | Writes review/check status where the operator acts as the App.                                   |
| Contents       | Read & write | Writes `.cogni/repo-spec.yaml`, `.github/workflows/*`, `.gitmodules`, catalog, and pin branches. |
| Issues         | Read & write | Work-item/issue coordination where GitHub issues are used.                                       |
| Packages       | Read & write | Reserved for operator-owned package policy/visibility management; not a node-ref flight gate.    |
| Pull requests  | Read & write | Opens and updates node birth/pin PRs.                                                            |
| Workflows      | Read & write | Writes workflow files; GitHub rejects workflow-file edits without this.                          |

Do **not** add a PAT, `GHCR_DEPLOY_TOKEN`, or any human-managed registry credential to child node
repos for publishing. Node repo Actions publish with repo-local `GITHUB_TOKEN` and
`permissions.packages: write`. The operator App should hold package write authority so package
policy/visibility management can move into the operator instead of human console steps. Node-ref
flight dispatch does not rely on GitHub Packages metadata; private GHCR package metadata can be
unreadable to the App even when the node's own publish workflow succeeded.

Parent candidate-flight and k3s pulls are separate cross-repo read paths. They require one of:

- public child packages;
- package-level Actions access granted to the parent repo;
- the existing parent/cluster `GHCR_DEPLOY_TOKEN` registry credential with `read:packages`.

`Administration` above is a **Repository permission** in the GitHub App UI. No separate
organization permission is currently required for node birth beyond installing the operator App on
**All repositories** in the mint org.

The package permission for operator Apps is **Repository permissions → Packages → Read and write**.
The live installation audit must show `.permissions.packages == "write"`.

> **Install scope for the minting App.** Step 7's single-repo install is enough for _review_ (payload-driven), but an App that **creates + commits to** new node repos must reach repos that don't exist yet. A `selected`-repos install means a freshly-minted `<owner>/<slug>` is **invisible to the App** → the identity-commit 404s even with `administration: write`. So the minting App needs **"All repositories"** on a dedicated nodes/test org (`cogni-test-org` for candidate/test; a production nodes org for live node birth) so it is not org-wide over unrelated operator infra repos. See [node-formation.md § Node Publish](../spec/node-formation.md) + [node-ci-cd-contract.md § Submodule-pinned nodes](../spec/node-ci-cd-contract.md).

### GHCR package requirement for wizard E2E

Node repos must publish source-addressed GHCR packages:

```text
ghcr.io/<lower-owner>/<lower-repo>:sha-<sourceSha>
```

The node workflow must use repo-local `GITHUB_TOKEN` with:

```yaml
permissions:
  contents: read
  packages: write
```

The image build must include the source label before first publish:

```yaml
labels: |
  org.opencontainers.image.source=https://github.com/${{ github.repository }}
```

The operator API does not reject node-ref images based on GitHub Packages metadata reads. The hard
image gate is the parent `candidate-flight.yml` digest resolution step, which runs
`scripts/ci/resolve-node-ref-image.sh` against `image_repository:sha-<sourceSha>`. Package
visibility is not an API preflight gate; parent workflow and deploy-time image-pull credentials are
separate substrate concerns.

4. **Subscribe to events:** Issues, Issue comment, Pull request, Pull request review, Push

5. Click **Create GitHub App**. Note the **App ID**.

6. **Generate a private key:** App settings → Private keys → Generate. Download the `.pem` file.

7. **Install the app:** App settings → Install App → select the target repo from the table above.

8. **Accept permission upgrades on the installation.** Editing the App definition is not enough.
   The org installation keeps the old permissions until an org admin accepts the upgrade.

   Current install approval URLs:

   ```text
   https://github.com/organizations/cogni-test-org/settings/installations/138046799
   https://github.com/organizations/Cogni-DAO/settings/installations/113665458
   ```

   The older `cogni-node-template` installation on `Cogni-DAO` is
   `https://github.com/organizations/Cogni-DAO/settings/installations/115515535`; use it only if
   `GH_REVIEW_APP_ID` for that environment is `3062001`.

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

### Verify operator App installation permissions

After changing an App definition, verify the **installation**, not just the App settings page. The
installation is what produces runtime installation tokens.

Candidate/test must show `repository_selection: "all"` and at least:

```json
{
  "actions": "write",
  "administration": "write",
  "checks": "write",
  "contents": "write",
  "issues": "write",
  "metadata": "read",
  "packages": "write",
  "pull_requests": "write",
  "workflows": "write"
}
```

Audit candidate/test:

```bash
gh api "orgs/cogni-test-org/installations?per_page=100" \
  --jq '.installations[] | select(.app_id == 3956976) | {app_slug, id, repository_selection, permissions}'
```

Audit production operator:

```bash
gh api "orgs/Cogni-DAO/installations?per_page=100" \
  --jq '.installations[] | select(.app_id == 2994706) | {app_slug, id, repository_selection, permissions}'
```

Fail conditions:

- `permissions.packages` is absent or not `"write"` → future operator-owned package policy writes
  will fail.
- `repository_selection` is not `"all"` for `cogni-operator-test` → newly spawned repos may be
  invisible to the App.
- `permissions.workflows` is not `"write"` → node birth cannot write `.github/workflows/*`.
- `permissions.actions` is not `"write"` → the App cannot dispatch `candidate-flight.yml`.

### Verify GHCR package state

After a fresh wizard spawn, the child repo PR Build must publish its source-addressed package/tag.
The flight endpoint does not use these GitHub Packages API reads as a hard gate, because private
package metadata can be unreadable to a repo-level App installation. Use this only as an operator
debug check when package permissions allow it.

```bash
repo=<spawned-repo-name>
gh api "/orgs/cogni-test-org/packages/container/${repo}" \
  --jq '{name, visibility, repository: .repository.full_name}'
```

Expected:

```json
{
  "name": "<spawned-repo-name>",
  "repository": "cogni-test-org/<spawned-repo-name>"
}
```

Then confirm the source-SHA tag exists:

```bash
source_sha=<40-char-child-sha>
gh api "/orgs/cogni-test-org/packages/container/${repo}/versions" \
  --jq --arg tag "sha-${source_sha}" '[.[] | select(.metadata.container.tags[]? == $tag) | {id, tags: .metadata.container.tags}]'
```

Expected: a non-empty array containing `sha-<sourceSha>`.

## Troubleshooting

| Symptom                                                         | Fix                                                                                          |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 404 from webhook route                                          | `GH_WEBHOOK_SECRET` not set — add it and restart                                             |
| 401 from webhook route                                          | Secret mismatch — compare app config vs env var                                              |
| Check Run never appears                                         | App missing `checks:write` permission                                                        |
| Review silently skipped                                         | `GH_REVIEW_APP_ID` or private key not configured                                             |
| No smee forwarding                                              | `pnpm dev:smee` not running                                                                  |
| Node-ref flight returns `source_missing` or `repo_spec_missing` | Confirm the requested child SHA exists and contains `.cogni/repo-spec.yaml` with the node id |
