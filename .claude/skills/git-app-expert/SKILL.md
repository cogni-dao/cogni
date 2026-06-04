---
name: git-app-expert
description: >
  GitHub App + VCS operations expert for the cogni-template stack. Load this
  skill when working on anything involving: GitHub App permissions or installation
  auditing (cogni-node-template, cogni-git-review), VCS tool layer changes
  (VcsCapability interface, GitHubVcsAdapter, vcs-flight-candidate tool schema),
  candidate-a flight dispatch debugging (workflow_dispatch permissions, slot
  acquisition, Argo sync, buildSha verify), per-app slot isolation work, or
  wiring the pr-manager agent end-to-end. Use proactively whenever the user
  mentions "flight", "pr-manager dispatch", "workflow permissions", "GH_REVIEW_APP",
  "VcsCapability not configured", "actions:write", or asks to add a workflowRef /
  per-app lease / VCS tool parameter.
---

# Git App Expert

You are the expert on Cogni's GitHub App integration, VCS tool layer, and candidate-a
flight pipeline. Your job is to audit, debug, and implement — from the GitHub org
installation level down to the tool schema and CI scripts.

## GitHub Apps on Cogni-DAO Org

**One App per environment** — each App has exactly one webhook URL, so prod/preview/candidate-a
cannot share one. Create + wire per the canonical guide:
[`docs/guides/github-app-webhook-setup.md`](../../../docs/guides/github-app-webhook-setup.md).

| App                   | ID      | Install ID | env         | webhooks → / installed on                            |
| --------------------- | ------- | ---------- | ----------- | ---------------------------------------------------- |
| `cogni-node-template` | 3062001 | 115515535  | (vcs/flight)| org-wide; `actions:write` for `workflow_dispatch`    |
| `cogni-git-review`    | 1761205 | 80293097   | production  | `cognidao.org/...webhooks/github` · `Cogni-DAO/cogni`|
| `cogni-operator-test` | (per-env)| —         | candidate-a | `test.cognidao.org/...webhooks/github` · `Cogni-DAO/test-repo` |

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
  jq '.installations[] | select(.app_id == 3062001) | {app_slug, permissions}'
```

`actions:write` is required for `workflow_dispatch`. If the installation shows `actions:read`,
the org admin must approve the pending permission upgrade at:
`github.com/organizations/Cogni-DAO/settings/installations/115515535`

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

**Only the operator node has a real VcsCapability.** All other nodes (`poly`, `resy`,
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
5. Run `pnpm check:fast` — TypeScript will catch any missed call sites

Use case: flight PR #1004 using PR #1003's workflow branch so the CI fix in #1003 is tested
while validating #1004's app build.

### AI tool contracts

```
core__vcs_list_prs          — read_only  — lists open PRs
core__vcs_get_ci_status     — read_only  — full CI state for one PR
core__vcs_merge_pr          — state_change — squash/merge/rebase into staging
core__vcs_create_branch     — state_change — naming: agent/<work-item-id>/<desc>
core__vcs_flight_candidate  — state_change — dispatches candidate-flight.yml
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

## Candidate-Flight.yml — 3-Job Anatomy

`.github/workflows/candidate-flight.yml` — triggered by `workflow_dispatch` with `pr_number` input.

```
flight job
  ├─ acquire-candidate-slot.sh   → writes infra/control/candidate-lease.json (state: leased)
  ├─ resolve-pr-build-images.sh  → finds GHCR digests for this PR's image tag
  ├─ promote-build-payload.sh    → patches deploy/candidate-a overlay; emits promoted_apps
  ├─ push deploy/candidate-a
  └─ reconcile ArgoCD ApplicationSet via SSH

verify-candidate job (gated: promoted_apps != '')
  ├─ wait-for-argocd.sh          → EXPECTED_SHA = deploy_branch_sha (NOT source SHA)
  ├─ wait-for-candidate-ready.sh → DOMAIN health check
  ├─ wait-for-in-cluster-services.sh
  ├─ smoke-candidate.sh
  └─ verify-buildsha.sh          → per-app /version.buildSha check (SOURCE_SHA_MAP mode)

release-slot job (always, if acquired == true)
  ├─ decide: state=free (verify success or nothing promoted) | state=failed (otherwise)
  ├─ release-candidate-slot.sh   → updates infra/control/candidate-lease.json
  └─ report commit status to PR
```

**Critical**: `EXPECTED_SHA` for wait-for-argocd.sh is `deploy_branch_sha` (the deploy branch
tip after promotion), not the source PR head SHA. Passing the wrong SHA causes silent timeouts
because Argo tracks the deploy branch, not the source branch.

**`promoted_apps` gate**: if empty (nothing was promoted, e.g., CI-only PR with no built
images), verify-candidate is visibly SKIPPED — not silently green. A PR with promoted apps
where verify was skipped is a contradiction → flight fails.

### Slot lease file

`infra/control/candidate-lease.json` on `deploy/candidate-a` branch.

Leased state:

```json
{ "slot": "candidate-a", "state": "leased", "pr_number": N, "head_sha": "...",
  "run_id": "...", "acquired_at": "...", "expires_at": "...", "status_url": "..." }
```

Released state:

```json
{ "slot": "candidate-a", "state": "free"|"failed", "released_at": "...",
  "last_owner": { "pr_number": N, "head_sha": "...", "run_id": "..." } }
```

Check live lease:

```bash
gh api "repos/Cogni-DAO/node-template/contents/infra/control/candidate-lease.json?ref=deploy%2Fcandidate-a" \
  | jq -r '.content' | base64 -d | jq .
```

## Per-App Slot Isolation (Planned)

**Current**: one global `candidate-lease.json` — all apps share a single slot. A poly-only
PR blocks operator and vice versa.

**Goal**: per-app leases so `poly` and `operator` can fly concurrently.

Design:

- Replace single `infra/control/candidate-lease.json` with per-app files:
  `infra/control/candidate-lease-{app}.json`
- `promote-build-payload.sh` already emits `promoted_apps` (e.g., `"poly"` for poly-only PRs)
- `acquire-candidate-slot.sh` takes `APP_NAMES` env, acquires lock per promoted app
- A PR is blocked only if any of _its_ promoted apps are currently leased by another flight
- `release-candidate-slot.sh` releases only the apps that were acquired
- `candidate-flight.yml` passes `promoted_apps` to acquire/release steps

This change is in-scope for the `feat/vcs-workflow-ref-git-app-expert` branch.

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

6. **`verify-buildsha` fails for resy** → resy SHA mismatch — resy images weren't promoted
   in this flight (poly-only PR) but the verify script is checking resy anyway. This means
   `promoted_apps` output is wrong or the verify script isn't scoped correctly.

7. **`wait-for-argocd` times out** → wrong `EXPECTED_SHA` passed (source SHA instead of
   deploy branch SHA), or Argo is out of sync with the deploy branch. SSH to VM and run
   `kubectl get applicationset -n argocd` to check sync state.

## Environment Variables Reference

| Var                                | Where set                                   | Purpose                         |
| ---------------------------------- | ------------------------------------------- | ------------------------------- |
| `GH_REVIEW_APP_ID`                 | **OpenBao** `cogni/<env>/operator/*` (ESO); GH env secret is provision seed only | GitHub App ID for VcsCapability |
| `GH_REVIEW_APP_PRIVATE_KEY_BASE64` | **OpenBao** `cogni/<env>/operator/*` (ESO); GH env secret is provision seed only | Base64-encoded PEM private key  |
| `GH_WEBHOOK_SECRET`                | **OpenBao** `cogni/<env>/operator/*` (ESO); must MATCH the App's webhook-secret field | Webhook signature verification  |
| `GH_REPOS`                         | candidate-a + production GitHub env **vars** (config, not secret) | pr-manager repo scope (review is payload-driven) |
| `DOMAIN`                           | candidate-a env var: `test.cognidao.org`    | Used in smoke + buildSha verify |
| `VM_HOST`                          | candidate-a GitHub env secret               | SSH target for Argo reconcile   |
| `SSH_DEPLOY_KEY`                   | candidate-a GitHub env secret               | SSH key for VM access           |
