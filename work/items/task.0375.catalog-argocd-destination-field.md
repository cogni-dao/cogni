---
id: task.0375
type: task
title: "catalog declares Argo CD destination; retire SSH+kubectl rollout-status"
status: needs_design
priority: 1
rank: 50
estimate: 3
summary: "Close the deploy-side half of task.0374's SSoT pivot. Add Argo CD's native `destination` fields (server, namespace) to `infra/catalog/<node>.yaml`; let the existing ApplicationSet template route per-app. Retire the SSH-to-VM + `kubectl rollout status` block in `wait-for-argocd.sh` in favor of `argocd app wait --health --sync-status`, which is destination-agnostic and stock OSS Argo CD. No new DSL, no per-substrate switch, no new controllers."
outcome: |
  - Each `infra/catalog/<node>.yaml` declares `argocd_destination_server` (default `https://kubernetes.default.svc`) and `argocd_destination_namespace` (default `<name>`). All four current entries land defaults — pure refactor, behavioral no-op.
  - All 3 `*-applicationset.yaml` templates read `{{argocd_destination_server}}` / `{{argocd_destination_namespace}}` from the per-node generator file. Adding a node on a different cluster is a one-line catalog edit; nothing else changes.
  - `scripts/ci/wait-for-argocd.sh` swapped from `ssh root@$VM kubectl rollout status` to `argocd app wait <env>-<node> --health --sync-status --timeout=<n>` against `ARGOCD_SERVER` (in-cluster Argo's HTTPS endpoint, already exposed) using a CI-scoped Argo token. Drops `.local/<env>-vm-{key,ip}` dependency from the verify path. The rollout-status semantics (waits on `Progressing=NewReplicaSetAvailable`) are preserved because Argo Application health does the same observation against whatever cluster the destination points at.
  - `verify-buildsha.sh` unchanged — already destination-agnostic (curls public Ingress).
  - `deploy-infra.sh` and the candidate-flight-infra lever are out of scope. They handle compose, not k8s — different substrate by design, will be evaluated separately.
spec_refs:
  - docs/spec/ci-cd.md
assignees: []
credit:
project: proj.cicd-services-gitops
branch:
pr:
reviewer:
revision: 0
blocked_by: task.0376
deploy_verified: false
created: 2026-04-25
updated: 2026-04-25
labels: [cicd, deployment, ssot]
external_refs:
  - work/items/task.0372.candidate-flight-matrix-cutover.md
  - https://argo-cd.readthedocs.io/en/stable/user-guide/commands/argocd_app_wait/
---

# task.0375 — Catalog declares Argo destination; retire SSH+kubectl

## Problem

Task.0374 (PR #1053) pivoted source-side fields (path_prefix, image_tag_suffix, per-env branches) into `infra/catalog/<node>.yaml`. The deploy-side half stayed hardcoded:

- ApplicationSets pin every generated Application to `destination.server: https://kubernetes.default.svc` (in-cluster). The shared-k3s assumption is in YAML, not catalog.
- `wait-for-argocd.sh` SSHes to a single VM IP from `.local/<env>-vm-ip` and runs `kubectl rollout status`. Adding a node on a different cluster requires editing the script — exactly the drift class 0374 set out to kill.

Adding a heterogeneous node today (different cluster, different cloud) means editing both AppSet templates and the verify script under pressure. The seam exists for source-side; it doesn't for deploy-side.

## Why now

Task.0372 lands the matrix cutover. Once each flight workflow fans out per-node, the per-cell verify is the natural place to consume per-node destination data. Doing this before 0372 = refactoring two moving targets; doing it after 0372 + before the first heterogeneous node = one clean PR.

## Design — use Argo's native fields, no DSL

OSS Argo CD already models "where does this app deploy" with `spec.destination.{server, namespace}`. Argo's control plane handles cross-cluster routing transparently — a registered cluster is queried via the same API surface as the in-cluster one. There is nothing to invent.

**Catalog change** (one field pair per entry, both with sensible defaults):

```yaml
# infra/catalog/operator.yaml
argocd_destination_server: https://kubernetes.default.svc # default; in-cluster
argocd_destination_namespace: operator # default: <name>
```

**AppSet change** (one template substitution per env file):

```yaml
# infra/k8s/argocd/{candidate-a,preview,production}-applicationset.yaml
spec:
  destination:
    server: "{{argocd_destination_server}}"
    namespace: "{{argocd_destination_namespace}}"
```

The four existing nodes get the in-cluster defaults — Argo reconciles a no-op (same destination, same digest).

**Verify change** — `scripts/ci/wait-for-argocd.sh`:

Today (excerpt):

```bash
ssh -i .local/$ENV-vm-key root@$(cat .local/$ENV-vm-ip) \
  "kubectl rollout status deployment/$app -n $app --timeout=${ARGOCD_TIMEOUT}s"
```

After:

```bash
argocd app wait "$ENV-$app" \
  --health --sync \
  --timeout "$ARGOCD_TIMEOUT"
```

`argocd app wait --health --sync` is the stock CLI verb. Internally Argo waits on the same `Progressing=NewReplicaSetAvailable` signal that bug.0326 fixed our SSH path to observe — but it does it for whatever cluster the Application's destination points at, with no SSH and no per-VM credentials in CI. CI auth uses a long-lived `ARGOCD_AUTH_TOKEN` GitHub secret scoped to a `ci-flight` project role with `applications, get/sync/wait` only.

That's the entire change. No switch on `deploy_target.kind`. No new abstraction. The catalog declares Argo's native field; Argo does the rest.

## Out of scope

- **`deploy-infra.sh` / `candidate-flight-infra.yml`.** Compose, not k8s. Different substrate by design. If a future node is compose-only on a separate VM, that's a separate task — and the answer is probably "stop using compose for new nodes," not "make the script substrate-agnostic."
- **Inventing a `deploy_target.kind` enum.** Rejected — Argo's destination is already the abstraction. A kind field would be a parallel ontology with one value (`k3s-shared`) and zero enforcement.
- **Multi-cluster Argo registration.** When the first heterogeneous node lands, that PR registers the cluster (`argocd cluster add`) and sets the catalog field. This task only opens the seam.
- **`require-pinned-release-prs-to-main.yml` purge.** Tracked separately as a small cleanup PR (project blocker #8).

## Validation

- (a) Apply catalog defaults; flight any PR; observe Argo Applications unchanged (same destination, same digest, no reconcile churn).
- (b) `wait-for-argocd.sh` swap: trigger candidate-flight on a PR; verify the script's exit code + duration match the pre-swap baseline within tolerance; verify CI logs no longer contain `kubectl rollout status` lines.
- (c) Negative test: temporarily set one node's `argocd_destination_namespace` to a non-existent namespace on a throwaway branch; flight must fail at `argocd app wait` with a clear destination-mismatch error, not at SSH.
- (d) No `.local/<env>-vm-*` reads remain in any verify-path script (`grep -r '\.local/.*-vm-' scripts/ci/` returns only infra-lever and provisioning scripts).

## Dependencies

- **Hard-blocked on**: task.0376 merged. Preview + production matrix cutover is where the destination-agnostic verify path needs to land in lockstep — task.0372 shipped only candidate-a's per-node shape.
- **Soft-blocked on**: nothing. Catalog default fields can land any time; the verify-script swap is the load-bearing change and wants a quiet window on candidate-a.
