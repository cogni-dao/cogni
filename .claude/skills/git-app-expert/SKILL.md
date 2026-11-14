---
name: git-app-expert
description: >
  GitHub App + VCS operations expert for the cogni-template stack. Load this
  skill when working on anything involving: GitHub App permissions or installation
  auditing (cogni-node-template, cogni-git-review), VCS tool layer changes
  (VcsCapability interface, GitHubVcsAdapter, vcs-flight-candidate tool schema),
  operator flight dispatch debugging (workflow_dispatch permissions,
  Argo sync, buildSha verify), or
  wiring the pr-manager agent end-to-end. Use proactively whenever the user
  mentions "flight", "pr-manager dispatch", "workflow permissions", "GH_REVIEW_APP",
  "VcsCapability not configured", "actions:write", or asks to add a workflowRef /
  VCS tool parameter.
---

# Git App Expert

Route the work through [operator-architect](https://cognidao.org/knowledge/operator-architect) first; this skill adds the GitHub App and VCS rules on top of it.

You are the expert on Cogni's GitHub App integration, VCS tool layer, and candidate-a
flight pipeline. Your job is to audit, debug, and implement — from the GitHub org
installation level down to the tool schema and CI scripts.

> **Boundary first.** Read [CI/CD Platform Boundary & Freeze Policy](https://cognidao.org/knowledge/operator-plane-contract) before adding deploy/flight behavior. The operator deploy brain in `scripts/ci/*.sh` + `.github/workflows/*.yml` is **frozen** — new control logic routes to the substrate (catalog/overlay/Argo/ESO) or into the typed `.ts` operator control plane. `DeployCapability` (`packages/ai-tools/src/capabilities/deploy.ts`) is the **sibling of `VcsCapability`** — same `CAPABILITY_INJECTION`/`ADAPTER_SWAPPABLE` shape, adapter in `nodes/operator/app/src/adapters/server/`. v0 is read-only over live Argo state and reuses `dispatchCandidateFlight` for promotion (no second dispatch path; Argo stays the reconciler). When asked to add a flight/deploy feature, prefer a `DeployCapability` method over a new workflow input or a new `.sh`.

## GitHub Apps on Cogni-DAO Org

**One App per environment** — each App has exactly one webhook URL, so prod/preview/candidate-a
cannot share one. Create + wire per the canonical guide:
[`docs/guides/github-app-webhook-setup.md`](../../../docs/guides/github-app-webhook-setup.md).

| App                        | ID      | Install ID | env              | webhooks → / installed on                                              |
| -------------------------- | ------- | ---------- | ---------------- | ---------------------------------------------------------------------- |
| `cogni-operator-test`      | 3956976 | 138046799  | candidate-a/test | `test.cognidao.org/...webhooks/github` · all repos on `cogni-test-org` |
| `cogni-operator`           | 2994706 | 113665458  | production ops   | `cognidao.org/...webhooks/github` · all repos on `Cogni-DAO`           |
| `cogni-node-template`      | 3062001 | 115515535  | legacy/vcs       | selected repos; use only if the env's `GH_REVIEW_APP_ID` is `3062001`  |
| `cogni-git-review`         | 1761205 | 80293097   | production       | `cognidao.org/...webhooks/github` · `Cogni-DAO/cogni`                  |
| `cogni-git-review-preview` | 2011345 | 87655574   | preview          | `preview.cognidao.org/...webhooks/github` · selected preview repos     |

`Cogni-DAO/test-repo` is only a legacy review-webhook fixture. It is not
sufficient for node publish/flight testing: the candidate/test App must see the
template repo, parent pin repo, and freshly minted node repos in the disposable
GitHub org (`cogni-test-org`) without gaining access to production `Cogni-DAO`
repos. Pair this with `DOLTHUB_OWNER=cogni-test-nodes` for node knowledge repos.

**Where the App creds live (post-ESO migration, #1460/#1476):** the running operator pod reads
`GH_REVIEW_APP_ID` / `GH_REVIEW_APP_PRIVATE_KEY_BASE64` / `GH_WEBHOOK_SECRET` from **OpenBao**
`cogni/<env>/operator/*` (ESO → `operator-env-secrets` → `envFrom`) — **NOT** the GitHub env secret
directly. The GitHub env secret is only a provision-time seed; for a **live** env, write to OpenBao
via `pnpm secrets:set <env> operator GH_REVIEW_APP_*` + bounce the pod (Reloader isn't cluster-wide
yet). See the webhook-setup guide §"Deployed envs".

**Split-brain auth (`bug.5000`, open):** App auth is duplicated across **three** adapters —
`adapters/server/review/github-auth.ts` (webhook plane, payload-driven per-repo),
`adapters/server/vcs/github-vcs.adapter.ts` (flight + approve-checks, historically hardcoded to
`Cogni-DAO/cogni` via `getGithubRepo()`), and `scheduler-worker/.../ingestion/github-auth.ts`. They
diverge: review works repo-agnostically (why `preview-test-repo` PRs review) while VCS tools stub on
candidate-a if `GH_REVIEW_APP_ID` is empty or the repo is hardcoded. Desired end state = one shared
`github-core` primitive + capability-scoped per-repo token provider. Until then, configuring a new
env means setting all three planes' creds + matching the webhook secret on both the App and the pod
(the dual-plane class — see also dev2's webhook-secret-sync work).

**Permission audit**: to check live installation permissions:

```bash
gh api "orgs/Cogni-DAO/installations?per_page=20" | \
  jq '.installations[] | select(.app_id == 2994706) | {app_slug, id, repository_selection, permissions}'

gh api "orgs/cogni-test-org/installations?per_page=20" | \
  jq '.installations[] | select(.app_id == 3956976) | {app_slug, id, repository_selection, permissions}'
```

Operator mint/flight Apps require `actions:write`, `administration:write`, `contents:write`,
`workflows:write`, and `packages:write`. Package write reserves operator authority for future
package policy/visibility management; node-ref flight must not treat GitHub Packages metadata reads
as the deploy gate because private package metadata can false-negative even when the child image
exists. Do not add a PAT to child node repos for publishing: child workflows publish with their
repo-local `GITHUB_TOKEN` and `permissions.packages: write`. The operator flight and k3s image
pulls (operator only) are separate cross-repo read paths and still need either public packages, package Actions
access grants, or the existing `GHCR_DEPLOY_TOKEN`/registry credential path with `read:packages`.
If the installation lacks a newly requested permission, the org admin must approve the pending
permission upgrade at the installation URL:

```text
https://github.com/organizations/cogni-test-org/settings/installations/138046799
https://github.com/organizations/Cogni-DAO/settings/installations/113665458
```

The legacy `cogni-node-template` installation approval URL is
`https://github.com/organizations/Cogni-DAO/settings/installations/115515535`.

**Common gotcha**: the GitHub App _definition_ can request `actions:write` while the org
_installation_ still shows `read` — they diverge when the org hasn't accepted the expanded
permissions yet. Always check the installation, not the app definition.

## VCS Capability Layer

The VCS capability follows the hexagonal pattern: interface → adapter → bootstrap injection.

```
packages/ai-tools/src/capabilities/vcs.ts          ← interface (VcsCapability)
packages/ai-tools/src/tools/vcs-*.ts               ← AI tool schemas (5 tools)
nodes/operator/app/src/adapters/server/vcs/
  github-vcs.adapter.ts                            ← GitHubVcsAdapter (Octokit + App auth)
nodes/operator/app/src/bootstrap/capabilities/
  vcs.ts                                           ← factory (reads env vars, returns adapter or stub)
nodes/operator/app/src/bootstrap/ai/
  tool-bindings.ts                                 ← wires VcsCapability into tool implementations
```

**Only the operator node has a real VcsCapability.** All other nodes (
`node-template`) export `stubVcsCapability` — it satisfies the binding requirement but throws
on use: `"VcsCapability not configured on this node."` This is intentional — VCS operations
live on the operator node.

### VcsCapability interface methods

```typescript
listPrs({ owner, repo, state? })             → PrSummary[]
getCiStatus({ owner, repo, prNumber })       → CiStatusResult   // allGreen, pending, checks[]
mergePr({ owner, repo, prNumber, method })   → MergeResult
createBranch({ owner, repo, branch, fromRef }) → CreateBranchResult
dispatchCandidateFlight({ owner, repo, prNumber, headSha? }) → DispatchCandidateFlightResult
```

`CiStatusResult.allGreen` is the pr-manager's gate: `true` only when all checks are `success`
and none are `pending`.

### GitHubVcsAdapter

`nodes/operator/app/src/adapters/server/vcs/github-vcs.adapter.ts`

Key design points:

- Constructed with `{ appId, privateKey }` — no installation ID at construction time
- `resolveInstallationId(owner, repo)` fetches and caches the installation ID per repo
- Each API call gets a fresh `Octokit` instance with that installation's token
- `dispatchCandidateFlight` hardcodes `ref: "main"` — the workflow YAML must live on main for
  `workflow_dispatch` to work; dispatching from a feature branch would fail

**Adding `workflowRef` parameter** (the planned feature):

1. Add optional `workflowRef?: string` to `VcsFlightCandidateInputSchema` in
   `packages/ai-tools/src/tools/vcs-flight-candidate.ts`
2. Add optional `workflowRef?: string` to `dispatchCandidateFlight` params in
   `packages/ai-tools/src/capabilities/vcs.ts`
3. Change `ref: "main"` → `ref: params.workflowRef ?? "main"` in the adapter
4. Update `vcs-flight-candidate.ts` tool description to document the parameter
5. Run `pnpm typecheck` — TypeScript will catch any missed call sites

Use case: flight PR #1004 using PR #1003's workflow branch so the CI fix in #1003 is tested
while validating #1004's app build.

### AI tool contracts

```
core__vcs_list_prs          — read_only  — lists open PRs
core__vcs_get_ci_status     — read_only  — full CI state for one PR
core__vcs_merge_pr          — state_change — squash/merge/rebase into staging
core__vcs_create_branch     — state_change — naming: agent/<work-item-id>/<desc>
core__vcs_flight_candidate  — state_change — operator flight (POST /api/v1/vcs/flight)
```

**NO_AUTO_FLIGHT invariant**: `core__vcs_flight_candidate` must only be called when a human
or scheduled run explicitly requests it. Enforced via tool description and pr-manager prompt —
not in code. The tool description repeats this to the planner.

## pr-manager Graph

`packages/langgraph-graphs/src/graphs/pr-manager/` — registered in catalog as `langgraph:pr-manager`.

Tool IDs it uses:

```
core__repo_open          ← reads pr-management-playbook.md at run start
core__vcs_list_prs
core__vcs_get_ci_status  ← must be called BEFORE dispatching flight
core__vcs_merge_pr
core__vcs_create_branch
core__vcs_flight_candidate
core__work_item_query
```

Invoke via agent API:

```bash
curl -s -X POST $BASE/api/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","graph_name":"pr-manager","messages":[{"role":"user","content":"..."}]}'
```

Playbook lives at `docs/guides/pr-management-playbook.md` — the pr-manager reads it on every
run. Flight-specific debugging guidance (permission errors, slot states, known patterns) belongs
there, not in agent-api-validation.md (that doc is a per-feature validation checklist).

## Operator flight anatomy (operator only)

`.github/workflows/candidate-flight.yml` flights an operator PR to its candidate. It is dispatched by `POST /api/v1/vcs/flight`, never by a personal `gh` credential. Per-`(env, target)` workflow concurrency serializes mutation. It is not a reviewer reservation, and the old slot-lease file is retired.

A node PR does not use this workflow. A node PR ships with `POST /api/v1/deploy/workloads {nodeId, env:"candidate-a", workload, sourceSha}`. Read [cicd-e2e-required-sequence](https://cognidao.org/knowledge/cicd-e2e-required-sequence).

Verify an operator flight by `/version.buildSha` on the candidate host. A flight whose `promoted_apps` is empty must show verify as skipped, not green. A PR with promoted apps and a skipped verify is a contradiction and fails.

## Flight Debugging Checklist

When a flight fails or dispatch errors, work through this in order:

1. **VcsCapability not configured** → `GH_REVIEW_APP_ID` or `GH_REVIEW_APP_PRIVATE_KEY_BASE64`
   not set in the node's environment. Check candidate-a GitHub environment secrets.

2. **403 / "Resource not accessible by integration"** → GitHub App installation lacks
   `actions:write`. Check:

   ```bash
   gh api "orgs/Cogni-DAO/installations?per_page=20" | \
     jq '.installations[] | select(.app_id == 3062001) | .permissions.actions'
   ```

   Fix: approve permission upgrade at GitHub org settings for installation 115515535.

3. **Slot busy** → another flight holds the lease. Check lease file (command above). If the
   run that owns it is no longer active, the lease will expire after TTL (60 min default).

4. **`promoted_apps` empty** → PR Build CI built no images (CI-only PR, or affected-only
   scope missed a node). Nothing to verify — flight is a no-op no-error skip.

5. **`verify-buildsha` fails for operator** → operator `/version` returns HTML (404). This is
   a pod health or ingress routing issue on the candidate-a VM, not a code problem.
   Check: `curl -s https://test.cognidao.org/version`

6. **`verify-buildsha` fails for a node the PR never touched** → that node's images weren't
   promoted in this flight, but the verify script is checking it anyway. This means
   `promoted_apps` output is wrong or the verify script isn't scoped correctly.

7. **`wait-for-argocd` times out** → wrong `EXPECTED_SHA` passed (source SHA instead of
   deploy branch SHA), or Argo is out of sync with the deploy branch. SSH to VM and run
   `kubectl get applicationset -n argocd` to check sync state.

## Environment Variables Reference

| Var                                | Where set                                                                             | Purpose                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `GH_REVIEW_APP_ID`                 | **OpenBao** `cogni/<env>/operator/*` (ESO); GH env secret is provision seed only      | GitHub App ID for VcsCapability                  |
| `GH_REVIEW_APP_PRIVATE_KEY_BASE64` | **OpenBao** `cogni/<env>/operator/*` (ESO); GH env secret is provision seed only      | Base64-encoded PEM private key                   |
| `GH_WEBHOOK_SECRET`                | **OpenBao** `cogni/<env>/operator/*` (ESO); must MATCH the App's webhook-secret field | Webhook signature verification                   |
| `GH_REPOS`                         | candidate-a + production GitHub env **vars** (config, not secret)                     | pr-manager repo scope (review is payload-driven) |
| `DOMAIN`                           | candidate-a env var: `test.cognidao.org`                                              | Used in smoke + buildSha verify                  |
| `VM_HOST`                          | candidate-a GitHub env secret                                                         | SSH target for Argo reconcile                    |
| `SSH_DEPLOY_KEY`                   | candidate-a GitHub env secret                                                         | SSH key for VM access                            |
