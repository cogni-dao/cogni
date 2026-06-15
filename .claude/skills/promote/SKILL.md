---
name: promote
description: Promote a sha to preview or production in cogni-template, OR diagnose why a promotion silently failed. Use this skill whenever the user says "/promote", "promote to preview", "promote to production", "ship to prod", "flight this sha", "deploy this PR to preview", "heal preview", "heal preview-operator", "prod is stuck on the old sha", or asks about preview/prod buildSha not advancing. Encodes the precise gh-workflow args, lease semantics, affected-only + admin-merge gotchas (bug.0443), and the Monitor poll-loop you must arm so the dispatch isn't fire-and-forget. Trigger this even when the user only names the symptom ("preview is on stale sha", "production didn't update", "flight-preview hard-failed") — the diagnosis playbook lives here. Do NOT trigger for ordinary code/test/build work; this is exclusively for cd-pipeline operations.
---

# Promote — preview + production playbook

You are operating the cogni-template release pipeline. The pipeline is multi-layered (per-node deploy branches, per-node Argo apps, per-node verify-deploy matrix legs) and has several silent-success seams that can make a green workflow lie about what's deployed. **Trust `/version.buildSha` from outside the cluster**, not workflow conclusions and not `/readyz` (Service-level — the old pod can answer it during rolling cutover, returning the prior buildSha while CI thinks rollout is done).

## When to use

- "promote to preview", "promote to production", "/promote", "ship to prod", "flight this sha", "heal preview", "deploy {PR} to preview/prod"
- "preview is still on old sha", "prod didn't update", "flight-preview hard-failed", "buildSha mismatch"

Do NOT use for code review, test fixes, or routine PR work.

## Ground truth — read first when in doubt

- `.github/workflows/flight-preview.yml` — auto preview trigger on `push:main`, manual recovery dispatch
- `.github/workflows/promote-and-deploy.yml` — does the actual promotion + verification (preview AND production)
- `.github/workflows/pr-build.yml` — `pull_request` (immutable `pr-{N}-{X}` tags) + `merge_group` (`mq-{N}-{Y}` tags); only the latter feeds preview
- `scripts/ci/flight-preview.sh` — three-value lease + dispatch
- `scripts/ci/resolve-pr-build-images.sh` — single source of truth for "does the mq-{N}-{sha} image set exist for this PR"
- `scripts/ci/verify-buildsha.sh` — single source of truth for "is this image actually serving"; per-node /version probes + non-Ingress markers
- `scripts/ci/aggregate-decide-outcome.sh` — closes the silent-success seam (bug.0443)
- `scripts/ci/aggregate-rollup.sh` — computes `current-sha = merge-base` of per-node deploy-branch tips; merges per-node `source-sha-by-app.json` preserving unaffected entries
- `scripts/ci/set-preview-review-state.sh` — lease primitive
- `scripts/ci/lib/image-tags.sh` — `ALL_TARGETS` / `NODE_TARGETS` from `infra/catalog/*.yaml` (axiom 16, CATALOG_IS_SSOT). Source this; never hardcode target lists.
- Per-env deploy branches: `deploy/{candidate-a,preview,production}-{operator,poly,resy,scheduler-worker}` — per-node since task.0376
- `.promote-state/` files on each deploy branch: `current-sha`, `source-sha-by-app.json`, `review-state` (preview only)

## Hostname rule (per `verify-buildsha.sh`)

- `operator` → `https://${DOMAIN}` (root). For preview that's `https://preview.cognidao.org`.
- Every other node → `https://${node}-${DOMAIN_PREFIX}.${BASE}` when DOMAIN has 2+ dots, else `https://${node}.${DOMAIN}`. Concretely:
  - poly preview → `https://poly-preview.cognidao.org`
  - resy preview → `https://resy-preview.cognidao.org`
  - production swaps `preview` for the prod hostname (typically `https://www.cognidao.org` for operator + `<node>.cognidao.org` for others — confirm via `vars.DOMAIN` in the production environment).
- scheduler-worker / migrators → no Ingress, no /version. Use `kubectl rollout status` or trust the verify-deploy job's marker emission.

## Preflight — every promotion, no exceptions

```bash
# 1. SHA exists on main (must be the merge-commit, not the PR head)
SHA=<merge-commit-sha-from-main>
git fetch origin main && git merge-base --is-ancestor "$SHA" origin/main || echo "❌ not on main"

# 2. mq-{N}-{SHA} images exist for ALL nodes you need.
#    Reuse the workflow's own resolver — same logic flight-preview.yml runs.
PR_N=$(gh api "repos/Cogni-DAO/standalone-node/commits/$SHA/pulls" --jq '.[0].number')
IMAGE_TAG="mq-${PR_N}-${SHA}" OUTPUT_FILE=/tmp/resolved.json \
  bash scripts/ci/resolve-pr-build-images.sh
jq '.resolved_targets, .has_images' /tmp/resolved.json
# resolved_targets list MUST include every node you intend to heal.
# Empty / missing nodes = admin-merge bypass (bug.0443) OR affected-only didn't rebuild that node.

# 3. Preview lease state (preview only)
git fetch origin deploy/preview && git show origin/deploy/preview:.promote-state/review-state
# unlocked → safe to dispatch. dispatching/reviewing → wait or you double-fly.

# 4. Production source-sha — pick the NEWEST sha that's verified-green on
#    any preview node. NOT the merge-base of per-node tips. Reason: when a
#    node hasn't been touched in months under affected-only, its preview tip
#    stays at an ancient sha, and merge-base of all four tips lands so far
#    back that the workflow scripts (e.g. resolve-cell-state.sh, added in
#    task.0376) don't even exist in the checkout — every verify-deploy leg
#    exits 127 and prod-pd hard-fails before doing real work.
#    `source_sha` only labels Argo's expected-sha + the deploy-branch tip
#    commit. Per-app digests + BUILD_SHAs are forwarded independently from
#    each preview-{node} overlay via preview_forward=true and recorded in
#    .promote-state/source-sha-by-app.json. So source_sha just needs to be
#    a main sha new enough that the workflow tree contains every script
#    verify-deploy invokes.
#    Pick: the newest preview-{node} promotion sha, e.g. the latest
#    "promote preview <node>: <sha>" commit on any deploy/preview-* branch.
NEWEST=""
for n in operator poly resy scheduler-worker; do
  src=$(git log -1 --format=%s "origin/deploy/preview-$n" \
    | sed -nE 's/.*: ([0-9a-f]{8,40}).*/\1/p')
  [ -z "$src" ] && continue
  if [ -z "$NEWEST" ] || git merge-base --is-ancestor "$NEWEST" "$src" 2>/dev/null; then
    NEWEST="$src"
  fi
done
echo "production source_sha = $NEWEST"
# Sanity: NEWEST must be on main and must contain scripts/ci/resolve-cell-state.sh.
git fetch origin main && git merge-base --is-ancestor "$NEWEST" origin/main
git show "$NEWEST:scripts/ci/resolve-cell-state.sh" >/dev/null \
  || echo "❌ chosen source_sha pre-dates verify-deploy infra; pick a newer sha"
```

## Preview promotion

**Auto path (default):** A PR merged via merge-queue triggers `flight-preview.yml` on `push:main`. No action needed — verify by watching (Monitoring section).

**Manual recovery dispatch** (auto-flight died, or re-running after fixing the lease):

```bash
gh workflow run flight-preview.yml --ref main -f sha=<merge-commit-on-main>
```

`sha` is the **squash/merge commit on main**, NOT the PR head. The workflow resolves the PR via the `(#NNN)` parse from the squash subject, looks up `mq-{PR}-{sha}` images, retags them as `preview-{sha}`, and dispatches `promote-and-deploy.yml` env=preview.

### Affected-only gotcha (task.0376)

`flight-preview` only retags nodes that `pr-build` actually built (`RESOLVED_TARGETS`). Untouched nodes are skipped. If preview-operator is broken and the merging PR was poly-only, the heal flight retags poly only — preview-operator stays broken. **Fix:** open a follow-up PR that touches the broken node's paths (`nodes/<node>/app/` or its dir-local `AGENTS.md`) and merge via merge-queue. The merge_group rebuild produces the missing `mq-*-{node}` image; the auto-flight on the resulting `push:main` heals.

### Admin-merge gotcha (bug.0443)

Admin-merging bypasses `merge_group` → no `mq-*` images → `flight-preview.yml`'s "Hard-fail when no images found for resolved PR" step fires. Same recovery: ship a follow-up PR through merge-queue. Do NOT try to dispatch a deleted `build-multi-node.yml`.

## Production promotion

Manual only. There is no production auto-trigger today (`promote-to-production.yml` was removed in bug.0361).

Two ways to dispatch:

- **Agent / API (preferred):** `POST /api/v1/deploy/promote {nodeId, env:"production", sourceSha?}` — RBAC-gated (`can_promote_production`), dispatched by the operator GitHub App, never a personal credential. **App-digest only — `skip_infra=true` is hard-set (`APP_PROMOTE_IS_NO_INFRA`)**; infra is a separate deliberate lever.
- **Human CLI:** the `gh` dispatch below.

```bash
# SOURCE_SHA must be (a) on main, (b) new enough to contain all current
# verify-deploy scripts. The newest per-node preview promotion sha is the
# safe default. See preflight #4 for the picker.
SOURCE_SHA=<newest-preview-node-promotion-sha>
gh workflow run promote-and-deploy.yml --ref main \
  -f environment=production \
  -f source_sha=$SOURCE_SHA \
  -f build_sha=$SOURCE_SHA \
  -f nodes=
  # skip_infra defaults to TRUE (app-digest promotion is orthogonal to substrate,
  # mirroring candidate-flight, which has no deploy-infra job). Add `-f skip_infra=false`
  # ONLY when this SOURCE_SHA's diff vs the deployed sha changes the substrate:
```

### When to deploy infra (`skip_infra=false`) — the 1%

App promotion never implies infra. Set `skip_infra=false` ONLY when the promoted diff touches the substrate/Compose layer:

1. **`infra/compose/**`\*\* — edge/Caddy routes, litellm, temporal, autoheal, db-backup, alloy, openclaw-gateway runtime.
2. **A new/changed secret the VM must materialize** — a new per-node `ExternalSecret` / ESO-OpenBao declaration, or a compose service consuming a new env var. If it's _pod_ secrets only (no Compose change), add `-f deploy_infra_mode=k8s-secrets-only` instead.
3. **Edge/runtime topology** — a new Compose service, a Caddy route, NodePort/ingress wiring living in compose infra.

Everything else — app code, app image, k8s overlay/digest, **DB migrations** (run by the migrator image in the k8s lane, not deploy-infra) — is app-only ⇒ leave `skip_infra` at its `true` default.

- `source_sha` = newest sha that's currently green on any preview node (preflight #4). Do NOT use `deploy/preview:.promote-state/current-sha` — `aggregate-rollup.sh` writes the merge-base of per-node tips there, which under prolonged affected-only divergence lands behind the workflow scripts and hard-fails verify-deploy at exit 127. The per-app digest + BUILD_SHA forwarding (via `preview_forward=true` and `source-sha-by-app.json`) is what actually carries each node's content; `source_sha` is only the Argo / deploy-branch label.
- `build_sha` = same as `source_sha` for normal merge-queue merges (pr-build merge_group bakes BUILD_SHA = queue commit = main HEAD). Differs only in unusual squash-merge scenarios.
- `nodes` = empty for all-nodes; CSV like `operator,poly` to scope.
- `skip_infra` = **defaults true** (app-only). Set `false` ONLY for the substrate-change cases enumerated above; app promotion is orthogonal to infra.

After dispatch, **always** confirm production `/version.buildSha` actually advanced — see Monitoring.

## Monitoring — Monitor tool, not eyeballing

Every promotion gets a Monitor armed before you walk away. The pattern emits one line per state change so you don't have to poll. Cover ALL terminal states (success, failure, cancelled, hung) — silence is not success.

```bash
# Copy-paste template. Set TARGET_SHA, FLIGHT_ID, and HOSTS for the env.
TARGET_SHA=<expected-buildsha-40-chars>
SHORT=${TARGET_SHA:0:12}
FLIGHT_ID=<flight-preview-or-promote-deploy-run-id-you-just-dispatched>
HOSTS="https://preview.cognidao.org https://poly-preview.cognidao.org https://resy-preview.cognidao.org"
# Self-discover the dispatch time so we can find the chained promote-and-deploy run.
DISPATCH_AT=$(gh run view "$FLIGHT_ID" --json createdAt --jq .createdAt)
PD_ID=""
prev_flight="" prev_pd=""
declare -A prev_bs=()
echo "watching flight=$FLIGHT_ID target=$SHORT hosts=$HOSTS dispatched=$DISPATCH_AT"
deadline=$(( $(date +%s) + 2400 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  fs=$(gh run view "$FLIGHT_ID" --json status,conclusion --jq '"\(.status)/\(.conclusion)"' 2>/dev/null || echo "api-fail/")
  [ "$fs" != "$prev_flight" ] && echo "[flight $FLIGHT_ID] $fs" && prev_flight="$fs"
  if [ -z "$PD_ID" ]; then
    PD_ID=$(gh run list --workflow=promote-and-deploy.yml --limit 5 --json databaseId,createdAt \
      --jq "[.[] | select(.createdAt > \"$DISPATCH_AT\")] | .[0].databaseId // empty" 2>/dev/null || echo "")
    [ -n "$PD_ID" ] && echo "[discovered promote-and-deploy] $PD_ID"
  fi
  if [ -n "$PD_ID" ]; then
    ps=$(gh run view "$PD_ID" --json status,conclusion --jq '"\(.status)/\(.conclusion)"' 2>/dev/null || echo "api-fail/")
    [ "$ps" != "$prev_pd" ] && echo "[promote-deploy $PD_ID] $ps" && prev_pd="$ps"
  fi
  all_match=1
  for host in $HOSTS; do
    bs=$(curl -sk --max-time 8 "$host/version" 2>/dev/null \
          | python3 -c 'import json,sys
try: print(json.loads(sys.stdin.read()).get("buildSha","")[:12])
except: print("")' 2>/dev/null || echo "")
    if [ "$bs" != "${prev_bs[$host]:-}" ]; then
      echo "[$host /version buildSha] ${bs:-<empty>}"
      prev_bs[$host]=$bs
    fi
    [ "$bs" = "$SHORT" ] || all_match=0
  done
  if [ "$all_match" = "1" ]; then
    echo "[DONE] all hosts match $SHORT"
    exit 0
  fi
  sleep 30
done
echo "[TIMEOUT] flight=$prev_flight promote=$prev_pd buildshas=$(declare -p prev_bs)"
exit 2
```

Wrap in a `Monitor` tool call with `timeout_ms` 2400000 (40 min) and a descriptive name like `"heal preview-operator: flight {ID} → promote-deploy → all preview /version → {SHORT}"`.

### When `/version.buildSha` doesn't advance — Loki, not SSH

`/version.buildSha` answers "is the new app pod serving" but says nothing
about why a host-side compose container (alloy, autoheal, db-backup,
alloy-k8s-events) is crash-looping. Don't SSH-tail. Both layers ship to the
same Loki:

```logql
# 1. App pod startup / env validation (k3s pod logs)
{namespace="cogni-<env>",pod=~"<service>-.*"} |~ "Error|EnvValidation|panic|started|ready"

# 2. Host-side compose container stdout (host alloy → Loki)
{env="<env>",service="<compose-svc>"} | json | level=~"error|warn"
# compose-svc ∈ {litellm, caddy, temporal, autoheal, db-backup, openclaw-gateway,
#                llm-proxy-openclaw, alloy-k8s-events}

# 3. Kubernetes Events stream (pod OOMKilled, probe failures, evictions, rollout)
{env="<env>",source="k8s-events"} | json
# Use this when a node restarted but app stderr is empty — kubelet's reason
# (OOMKilled, ImagePullBackOff, Liveness probe failed) only lives in events,
# not in container logs.

# 4. Argo control-plane — "a node's app never appeared" / "stuck OutOfSync"
{namespace="argocd",source="k8s-events",kind="ApplicationSet"} | json
# msg: created/Deleted Application "<env>-<node>" — proves the AppSet IS
# generating (a `created`+`Deleted` pair on the same app = it generated then
# pruned: a catalog/overlay condition, NOT a stuck controller).
{namespace="argocd",source="k8s-events",kind="Application",reason=~"OperationStarted|OperationCompleted|Failed"} | json
# msg: "Initiated automated sync to <sha>" → "sync operation to <sha> succeeded"
# — Argo's reconcile state for that one app, by sha.
```

`source="k8s-events"` requires the `alloy-k8s-events` compose service from
PR #1233 to be deployed in the env you're querying. If empty: check
`{service="alloy-k8s-events", env="<env>"}` for crash logs first.

**Reaching for `kubectl get applications` / `kubectl describe applicationset`
is the anti-pattern.** The `applicationset-controller` and
`application-controller` emit every generate / create / prune / sync
transition as a k8s Event — already in Loki via stream #4 above. `kind=ApplicationSet`
answers "is the AppSet generating this node's app at all"; `kind=Application`
answers "is Argo syncing it to the expected sha." No SSH, no kubeconfig — which
is also the SOC2 posture (read-only, audited, zero standing cluster credential).
Verified 2026-06-02: the `candidate-a-wisp` "AppSet won't generate" report was
false — Loki showed the controller had `created` then `Deleted` the Application.

New compose services don't ship logs until added to the host-alloy allowlist
regex in `infra/compose/runtime/configs/alloy-config.{,metrics.}alloy`. If
`{service=<svc>}` returns silence post-deploy, fix the regex before
diagnosing further — it's not Loki, it's the filter.

## Lease respect (preview only)

Never re-flight a sha while `.promote-state/review-state` on `deploy/preview` is `dispatching` or `reviewing`. The lease guards against double-promotion.

- `unlocked` → safe to dispatch.
- `dispatching` → a flight is in-flight; wait or check the run's actual outcome before forcing.
- `reviewing` → a flight reached E2E success; awaiting human gate. Don't bypass.

If a previous flight died and the lease is genuinely orphaned (rare — `aggregate-decide-outcome.sh`'s `if: always() &&` unlock should release it):

```bash
GH_TOKEN=$(gh auth token) GITHUB_REPOSITORY=Cogni-DAO/standalone-node \
  DEPLOY_BRANCH=deploy/preview \
  bash scripts/ci/set-preview-review-state.sh unlocked
```

Only do this when you've verified the prior run reached a terminal state. Bypassing while a flight is genuinely live causes overlay corruption.

## Failure modes — first-step diagnosis

| Symptom                                                                                                                                          | First diagnosis                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| flight-preview red at "Hard-fail when no images found for resolved PR"                                                                           | Admin-merge bypass (bug.0443). Recovery: merge-queue follow-up PR.                                                                                                                                                                                                                                                                |
| aggregate-preview red, "no cell reported promoted=true"                                                                                          | Same admin-merge cause OR sha has zero images. Verify with `resolve-pr-build-images.sh` (preflight #2).                                                                                                                                                                                                                           |
| aggregate-production red, "Axiom 19 contradiction: scheduler-worker"                                                                             | bug.0443 fix in `verify-buildsha.sh` is missing/reverted. The `NON_INGRESS_NODES` marker-emission block must be present.                                                                                                                                                                                                          |
| verify-buildsha timeout 90s                                                                                                                      | Pod cutover incomplete; usually transient. Re-check `/version` directly in 60s. If still wrong, check Argo app revision matches deploy-branch tip.                                                                                                                                                                                |
| `verify-deploy` green but `/version.buildSha` still old                                                                                          | CDN/edge cache, OR you hit `/readyz` (which the old pod still answers) instead of `/version`. Always use `/version.buildSha` for verification, never `/readyz`.                                                                                                                                                                   |
| Lease stuck `dispatching`                                                                                                                        | The exit-1 + `if: always() &&` unlock should have fired. If not, manually unlock as above (cautiously).                                                                                                                                                                                                                           |
| Production "succeeded" but only some nodes advanced                                                                                              | Affected-only — `nodes` input was scoped, or the source sha's image set didn't cover all targets. Verify per-node `current-sha` on each `deploy/production-*`.                                                                                                                                                                    |
| prod-pd: every `verify-deploy (<node>)` red at `Resolve cell state` with `bash: app-src/scripts/ci/<script>: No such file or directory` exit 127 | `source_sha` predates the verify-deploy script tree. Don't use `deploy/preview:.promote-state/current-sha` — `aggregate-rollup.sh` writes the merge-base of per-node tips, which under affected-only divergence regresses behind script additions. Re-dispatch using preflight #4's picker (newest preview-{node} promotion sha). |

## Discipline

- **`/version.buildSha` is the only deploy verification that matters.** CI conclusions can lie. `/readyz` can lie (old pod answers during rolling cutover).
- **Per-node truth, not per-workflow.** Every promotion advances _some_ nodes, not necessarily all. Check each `deploy/<env>-<node>:.promote-state/current-sha` independently.
- **Admin-merge breaks the pipeline.** If you see a CD-affecting PR getting admin-merged, file a bug AND propose a merge-queue follow-up; don't pretend the resulting silent-skip will heal itself.
- **Don't dispatch without arming a Monitor.** Fire-and-forget is how outages survive shift changes.
- **Catalog-as-SSOT for target lists.** Source `scripts/ci/lib/image-tags.sh`; never inline `(operator poly resy scheduler-worker)`.
