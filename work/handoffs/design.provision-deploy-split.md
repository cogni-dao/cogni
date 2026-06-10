---
id: design-provision-deploy-split
type: design
work_item_id: task.5017
status: review
created: 2026-06-10
updated: 2026-06-10
branch: derekg1729/provision-deploy-split
supersedes: ""
related:
  - work/handoffs/handoff.provision-deploy-split.md
  - work/handoffs/manual-edits-ledger.node-wizard-2026-06-10.md
---

# Design — Split provisioning from deploying (per-env node-set)

> **For the provisioning/node-env-optimization dev:** this is a review +
> refinement doc, not a fait accompli. The §"Lane boundary" table is the
> who-owns-what so we don't collide. The SSOT decision (§3) is the one place I
> most want your sign-off before I write code. Comment inline / refine in place.

## Outcome

> Success is when **a fresh `provision-env` of any env brings up only the nodes
> that env provisioned (default: operator + scheduler-worker) and reaches
> `/readyz` 200 with zero manual `kubectl`/`bao` edits** — the manual-edits
> ledger's rows 4 and 6–8 become structurally impossible.

## 1. Problem — substrate and deploy-state are conflated

Every recent env outage is one symptom: deploy fans out to nodes the env never
provisioned. Confirmed threading (read end-to-end, 2026-06-10):

| Layer | Today | Consequence |
| --- | --- | --- |
| `infra/catalog/_schema.json` | `candidate_a_branch` **+** `preview_branch` **+** `production_branch` are **all required** for every `type: node\|service` | A node **cannot** declare "candidate-a only" — every node is forced into all 3 envs |
| `scripts/ci/render-node-appset.sh` `deployable_nodes()` | every catalog row with a `candidate_a_branch` × `ENVS=(candidate-a preview production)` | emits the full **cartesian** — 33 AppSet files + 33 lines in the bootstrap `kustomization.yaml` |
| `scripts/setup/provision-env-vm.sh:1885` | globs `${DEPLOY_ENV}-*-applicationset.yaml` and applies **all** of them | env-filtered but **not** node-filtered → a 6 GB preview VM gets ~10 nodes' pods → **OOM** (ledger rows 6–8; ~6 GB fits ~2–3 nodes) |
| `scripts/ci/reconcile-node-substrate.sh:263-273` | `kubectl apply` of `nodes/<node>/k8s/external-secrets/<env>/external-secret.yaml` | that **same file** is also referenced by the Argo overlay (`infra/k8s/overlays/<env>/operator/kustomization.yaml:11`) → **two owners** of one ExternalSecret (ledger row 4) |
| flight `candidate-flight.yml` `reconcile-appset` | applies only the **one** flighted node's AppSet | ✅ already per-node scoped — the structural fix landed here (bug.0378). The bootstrap path never got the same treatment. |

**Root cause:** there is no per-env node-set declaration anywhere. The renderer
assumes "deployable ⇒ deploy everywhere"; provisioning inherits that assumption.

## 2. Scope — 3 concerns, this task is PR 1

The handoff names three. This design fully specs **PR 1** and sketches 2–3 so the
other dev and I agree on the seam; they are separate PRs (`single-node-scope`).

1. **PR 1 (this task, task.5017): per-env node-set gate.** Make `deploy ⊆ provisioned`
   structural. Retires ledger rows 6–8 (the OOM).
2. **PR 2: ExternalSecret single-owner.** Pick one applier for the node ES leaf.
   Retires ledger row 4.
3. **PR 3: flight asserts the new planes.** "node deployed but substrate absent →
   fail loud" extended to the node-set + ES planes.

## 3. SSOT decision — how an env declares its node-set  ⟵ **needs sign-off**

**Recommended: a per-node `envs:` catalog field.** Additive, low blast-radius,
single-glance per node.

```yaml
# infra/catalog/operator.yaml      (deploys everywhere — the default backbone)
envs: [candidate-a, preview, production]

# infra/catalog/oss.yaml           (candidate-a only — opt in to preview/prod later)
envs: [candidate-a]
```

- **Absent ⇒ all three** (back-compat shim for exactly one release; the `--write`
  pass materializes explicit `envs:` on every node, then the default is dropped).
- `deployable_nodes()` → `deployable_nodes_for_env(env)` = rows where `env ∈ envs`.
- The renderer emits `<env>-<node>-applicationset.yaml` **only** for `env ∈ envs`,
  so the bootstrap `kustomization.yaml` shrinks **and** `provision-env-vm.sh`'s
  existing `${DEPLOY_ENV}-*` glob automatically picks up only the env's subset —
  **no change to the provision glob.** That is the elegant part: one renderer
  change cascades correctly through bootstrap + provision.
- **Default node-set:** `[operator, scheduler-worker]` for preview + production
  (operator `/readyz` hard-depends on scheduler-worker `:9000` — ledger row 7);
  every node keeps `candidate-a` (must stay candidate-flightable).

**Rejected — branch-presence as the gate** (deploy to env X iff `<env>_branch`
set; relax schema to require only `candidate_a_branch`). Zero new fields, maximal
reuse — but it **couples deploy-branch naming to set-membership** and touches ~24
branch-field consumers (`grep` count) with a looser schema. Higher blast radius
for a cross-dev seam. Keep branch fields required and orthogonal; `envs:` is the
sole deploy-set gate. *(If you prefer this, say so — it's genuinely more syntropic,
just riskier to land cleanly while we're both in these files.)*

**Rejected — separate `infra/catalog/_env-nodes.yaml` list.** One file showing the
whole per-env picture is nice for capacity review, but it splits the SSOT (node
facts in `<node>.yaml`, deploy-reach in a second file) and violates the per-node
locality the branch fields already established. A `pnpm` helper can print the
env→nodes matrix from the `envs:` fields instead.

## 4. Implementation — PR 1

- **Modify** `infra/catalog/_schema.json` — add `envs` (array of
  `enum: [candidate-a, preview, production]`, `minItems: 1`, must contain
  `candidate-a`). Not in `required` yet (back-compat default).
- **Modify** `infra/catalog/*.yaml` — add explicit `envs:` to every node/service.
  `operator`, `scheduler-worker` → all three; all others → `[candidate-a]`.
- **Modify** `scripts/ci/render-node-appset.sh` — `deployable_nodes()` →
  `deployable_nodes_for_env(env)`; `write`/`check`/`render_kustomization_block`
  iterate the per-env set. `--check` now also fails if a committed
  `<env>-<node>-applicationset.yaml` exists for a node where `env ∉ envs` (stale).
- **Run** `pnpm gen:node-appset` — deletes the now-orphaned preview/production
  AppSets (8 nodes × 2 envs = 16 files) + trims the bootstrap kustomization.
- **Modify** `scripts/ci/reconcile-node-substrate.sh` — fail loud at entry if
  `DEPLOY_ENVIRONMENT ∉ envs(TARGET_NODE)` (don't provision substrate for a node
  the env isn't allowed to deploy — keeps provision ⊇ deploy honest from the
  substrate side too).
- **Test** `scripts/ci/tests/*` — extend the render-node-appset drift test to
  assert per-env subsetting (preview set == {operator, scheduler-worker}).

**No change needed:** `provision-env-vm.sh` glob (auto-narrows), flight
`reconcile-appset` (already per-node), `image-tags.sh` `NODE_TARGETS` (derived
from `type == node`, not branches — unaffected).

## 5. Lane boundary — who owns what (so we don't collide)

| Surface | Owner | Note |
| --- | --- | --- |
| `infra/catalog/_schema.json` + `envs:` field | **me (task.5017)** | new field; coordinate if you're also editing schema |
| `render-node-appset.sh` + generated AppSets + bootstrap kustomization | **me** | the renderer is the keystone of PR 1 |
| `reconcile-node-substrate.sh` env-guard | **me** | small guard at top; the body (DB/caddy/ES) is **yours** |
| `provision-env-vm.sh` (Phase 7/9, capacity, parallelism) | **you** | I touch **nothing** here — the glob auto-narrows |
| ExternalSecret ownership model (PR 2) | **TBD — let's decide together** | provisioning-owned vs Argo-owned is a substrate/deploy call |
| Node capacity / memory limits / VM sizing | **you** | I only reduce pod count; right-sizing limits is your lane |

If you're mid-flight on any "me" row, ping and we'll re-split. PR #1605 already
merged, so I'm building on current `main`.

## 6. Invariants  <!-- CODE REVIEW CRITERIA -->

- [ ] DEPLOY_SUBSET_OF_PROVISIONED: an env's bootstrap + provision apply only AppSets for nodes where `env ∈ envs` (spec: ci-cd CATALOG_IS_SSOT)
- [ ] CATALOG_IS_SSOT: `envs:` is declared once per node in `infra/catalog/<node>.yaml`; renderer + provision derive, never hardcode (spec: ci-cd axiom 16)
- [ ] FAIL_LOUD_ON_MISSING_SUBSTRATE: deploying/provisioning a node outside the env's set errors, never OOMs silently
- [ ] CANDIDATE_A_ALWAYS: every node/service includes `candidate-a` in `envs` (stays candidate-flightable)
- [ ] SCHEDULER_WITH_OPERATOR: any env whose set contains `operator` also contains `scheduler-worker` (`/readyz` dep — ledger row 7)
- [ ] SINGLE_NODE_SCOPE: PR 1 touches catalog + renderer + reconcile guard only; ES-ownership + flight-assert are separate PRs
- [ ] SIMPLE_SOLUTION: reuses the existing per-node AppSet renderer + provision glob; no new files, no per-env list

## 7. Falsifying test (deploy_verified for the mission)

Re-provision preview from scratch → `kubectl -n cogni-preview get pods` shows only
operator + scheduler-worker → operator `/readyz` 200 → **zero** rows added to the
manual-edits ledger. PR 1 alone makes rows 6–8 impossible; rows 4 closes with PR 2.

## 8. Open questions for refinement

1. **`envs:` field vs branch-presence** (§3) — your call; I default to the field.
2. **ES owner (PR 2):** provisioning-sole-applier (substrate-owned, drop it from
   the Argo overlay) **or** Argo-managed (drop the `kubectl apply` from
   reconcile-node-substrate)? I lean provisioning-owned (ES *is* substrate), but
   you own that seam.
3. **Default node-set** beyond `[operator, scheduler-worker]` — any env-specific
   additions you already need (e.g. a node on preview for demo)?
