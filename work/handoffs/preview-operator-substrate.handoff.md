---
id: "preview-operator-substrate"
type: handoff
work_item_id: ""
status: active
created: 2026-06-10
updated: 2026-06-10
branch: ""
last_commit: "c4e6b5f200"
---

# Handoff: Preview + Prod Substrate — get operator /readyz 200 (capacity, not image)

## Mission

**Pickup.** You own **preview + prod substrate**: right-size per-env capacity, fix the ESO ownership conflict + per-node ExternalSecret leaves, then promote so **preview operator serves `/readyz 200`**. The fresh-env provision bugs that orphaned VMs and SIGKILLed runs are fixed and merged — provision-env now reliably completes green (substrate). What remains is **not** a provision bug: preview operator pods are **Pending — Insufficient memory**, so a green substrate + a promote still yields `/readyz 502`. A second dev owns **candidate-a** (per-node-DB-cred cutover + node-wizard E2E); **do not write to candidate-a**, and they will **not write to preview**. Stay in your lane.

## Goal

- Preview **operator** `/version.buildSha == 15c6eb59…` AND `https://preview.cognidao.org/readyz == 200` (operator pods Running/Ready, not Pending).
- Preview VM **not over-committed**: k3s requests fit alongside the Compose stack; no node-app pods stuck `Pending` (Insufficient memory).
- Durable, reproducible-in-git capacity fix (per-env node set), not a one-off `kubectl scale`.

## Start By Reading

- `docs/research/2026-06-10-vm-pod-memory-efficiency.md` — dev2's capacity numbers + levers (he authored it; pull it if not yet on main).
- `.claude/skills/devops-expert/SKILL.md` → "Node capacity per VM".
- `.claude/skills/provision-env/SKILL.md` — esp. **Gotcha 18** (per-(svc,env) ESO leaf must exist), **Gotcha 19** (per-env node membership ≠ global catalog; Phase 9 scoping), and **Gotcha 20** (monitoring — `ScheduleWakeup` is the only durable run-watch; a background `gh run watch` is killed on session resume).
- `.claude/skills/promote/SKILL.md` — the flight/promote lever + lease semantics.
- `scripts/setup/provision-env-vm.sh` (Phase 6 ESO leaves, Phase 7 AppSets, Phase 9 — now soft) · `infra/k8s/argocd/preview-*-applicationset.yaml` · `infra/k8s/overlays/preview/<node>/`.

## Current State

**Done + merged to main (`c4e6b5f200`):**

- `#1600` — 3 deploy-infra fresh-env fixes: (1) `PROVISION_INFRA_ONLY` decouples openfga/litellm DB creation from the fail-soft per-node loop; (2) OpenFGA ID delivery tolerates **absent** operator ExternalSecret; (3) scheduler-worker rollout tolerates **absent** Deployment (Phase 5f runs before Phase 7 AppSets).
- `#1605` — (a) Phase 9 `/readyz` is **soft + parallel + global-budgeted** (provision green = substrate; app `/readyz` is the promote's job) — stops the 60-min SIGKILL that orphaned the VM + broke `VM_HOST`; (b) deploy-infra operator-tier OpenFGA checks (ExternalSecret refresh + pod process-env proof) non-fatal on a fresh/rebuilding env; (c) provision-env Gotcha 20 (monitoring).
- Preview substrate **provisioned green** (run `27259379198`); init artifact uploaded → `VM_HOST` + kubeconfig + VM key finalized (orphan/SSH-deadlock resolved). Read-only preview creds are decrypted in dev2's `.local` (diagnosis only).

**Blocked — operator `/readyz` still 502 (root cause = CAPACITY, confirmed by dev2 against live preview):**

- operator's **2 pods are both `Pending` — Insufficient memory (16m/30m)**. Not an image problem; a promote bumps the image but can't schedule a pod the VM won't fit.
- The ~6 GB preview VM **co-hosts k3s + the full Compose stack** (postgres/doltgres/litellm/temporal×3/redis/caddy ≈ 2.8 GB). k3s reports the whole 5.9 GB as allocatable — it can't see Compose's 2.8 GB — so it **over-commits**; ~half the node-app pods go `Pending`. **10 nodes × 2 ReplicaSets don't fit; a ~6 GB VM holds ~2–3 node-apps, not 10.**
- **ESO ownership conflict:** a stray `env-secrets` ExternalSecret targets `operator-env-secrets` (extract `preview/operator`) and **collides** with the dedicated `operator-env-secrets` ES → `SecretSyncedError: owned by another ExternalSecret`. The operator secret won't sync until the stray ES is deleted.
- In flight (will NOT reach 200 alone — capacity): flight-preview `27263263017` (success) → promote-and-deploy child `27263292160` (in_progress) for operator sha `15c6eb593fad…`. Expect operator to land its image but stay `Pending`.

## Design / Implementation Target

The operator-on-preview recipe — **in this order** (promote LAST):

1. **Free memory — run a small node set on preview.** Operator-only is acceptable (Derek only cares about operator now). **Durable** = fewer per-env AppSets/overlays (make the per-env node membership a single SSOT and derive it — ties to Gotcha 19's "subset env" model). **Fast** = suspend / scale-0 the non-operator Argo apps. Must end with operator's pods schedulable.
2. **Delete the stray `env-secrets` ExternalSecret** that collides with `operator-env-secrets` — operator's secret can't sync while two ES own it.
3. **THEN promote `#1594`** (`gh workflow run flight-preview.yml --ref main -f sha=15c6eb593fadd3f98e657640bc60b1c339d3f83e`) → operator schedules + image lands → `/readyz 200`.

Boundaries that must hold:

- **Do NOT write to candidate-a** (dev2 owns it: `#1584` per-node-DB-cred cutover + node-wizard E2E + agent-api-validation). Preview + prod only.
- **Prod apex cutover is live** (Gotcha 1) — never repoint prod to an app-less VM; blue-green or have the rollback IP.
- Capacity fix must be **in git** (per-env overlays/AppSet), not a transient `kubectl scale` that Argo `selfHeal` reverts (Gotcha 9).

## Next Actions / Risks

- [ ] Pull dev2's `docs/research/2026-06-10-vm-pod-memory-efficiency.md` for the exact per-pod request numbers + levers.
- [ ] Decide preview node set = operator-only (confirm with Derek); implement as fewer per-env AppSets/overlays (durable) — start by suspending/scale-0 non-operator Argo apps to unblock fast.
- [ ] Verify operator pods leave `Pending` once the node set shrinks (`kubectl -n cogni-preview get pods` via the decrypted preview kubeconfig).
- [ ] Delete the stray `env-secrets` ExternalSecret; confirm `operator-env-secrets` reaches `SecretSynced=True` (no "owned by another ExternalSecret").
- [ ] Unlock the preview lease if `dispatching` (`scripts/ci/set-preview-review-state.sh unlocked`), then promote `#1594`; watch operator `/version.buildSha → 15c6eb59` + `/readyz 200`.
- [ ] Right-size or scale the preview VM (≥ the Compose 2.8 GB + k3s requests) if operator-only still doesn't fit, or register the Compose reservation with k3s so it stops over-committing.
- Risk: a promote "succeeds" while operator stays `Pending` — `/version.buildSha` from outside the cluster is the only real signal (provision-env Gotcha header).
- Risk: per-env node-set change must not regress candidate-a/prod overlays (shared renderers).
- Risk (monitoring): waiting on a 15–30 min flight/promote → use a **`ScheduleWakeup` matched to the phase (~5 min), re-armed every turn**; a background `gh run watch` will be killed on session resume (Gotcha 20).

## Pointers

| File / Resource | Why it matters |
| --- | --- |
| `docs/research/2026-06-10-vm-pod-memory-efficiency.md` | dev2's capacity numbers + the actual levers (per-pod requests, what fits) |
| `.claude/skills/devops-expert/SKILL.md` → "Node capacity per VM" | the over-commit model: k3s can't see Compose's RAM |
| `.claude/skills/provision-env/SKILL.md` (Gotchas 18/19/20) | ESO leaf existence, per-env node membership, monitoring discipline |
| `infra/k8s/argocd/preview-<node>-applicationset.yaml` | the per-env AppSet set to prune for an operator-only preview |
| `infra/k8s/overlays/preview/<node>/` | per-node overlays; per-env node membership lives here (Gotcha 19) |
| `nodes/<node>/k8s/external-secrets/preview/` | per-(svc,env) ESO leaves; the stray `env-secrets` ES collision (Gotcha 18) |
| `scripts/ci/set-preview-review-state.sh` | preview lease lock/unlock (orphans as `dispatching`) |
| flight-preview `27263263017` / promote-and-deploy `27263292160` | in-flight operator promote (image lands, pods stay Pending until capacity is freed) |
| run `27259379198` | the green substrate provision (Phase 9 soft) — proves provision-env reliability |
