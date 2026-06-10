---
id: handoff-provision-deploy-split
type: handoff
work_item_id: ""
status: active
created: 2026-06-10
updated: 2026-06-10
branch: ""
last_commit: 5fdb2afa0d
---

# Handoff: Split provisioning from deploying (retire the manual-edits ledger)

## Mission

New mission: **cleanly split provisioning (substrate) from deploying (Argo apps +
images)** so every env reaches reproducibly-green with zero hand-edits. A parallel
session got operator green on candidate-a + preview, but only by propping it up
with out-of-band `kubectl`/`bao` edits (see the ledger). Each of those edits is a
symptom of the two concerns being conflated. You own making them unnecessary.

## Goal

- **Deploy ⊆ provisioned, per env.** An env only deploys node AppSets for nodes
  whose substrate (DB, roles, ExternalSecret, Doltgres) it actually provisioned.
  No more all-catalog AppSets shipped to a 6 GB VM that provisioned one node.
- **ExternalSecrets are single-owner** (Argo-managed, or provisioning is the sole
  idempotent applier) — never two un-owned ESes fighting over one target Secret.
- **Provision owns all substrate mutation; deploy/flight asserts substrate
  read-only** (the candidate-flight axiom, extended to the ES + node-set planes).
- E2E proof: re-provision preview from scratch → operator (its provisioned node
  set) reaches `/readyz` 200 with **no manual `kubectl`/`bao`** — the ledger's
  rows 4/6/8 never need to happen.

## Start By Reading

- `work/handoffs/manual-edits-ledger.node-wizard-2026-06-10.md` — the concrete
  failure evidence; every row is a requirement for this split.
- `.claude/skills/devops-expert/SKILL.md` §"Node capacity per VM" + `docs/research/2026-06-10-vm-pod-memory-efficiency.md` — why deploy ⊆ provisioned is load-bearing (capacity).
- `.claude/skills/cicd-secrets-expert/SKILL.md` — ESO ownership invariants (2: one ES per service/env; the duplicate that bit us violated this).
- `infra/k8s/argocd/<env>-<node>-applicationset.yaml` (one per catalog node, every env) — the all-catalog deploy fan-out to change.
- `scripts/ci/render-node-appset.sh` + `scripts/ci/reconcile-node-substrate.sh` — where AppSets are rendered/applied; where the per-env node-set gate belongs.
- `nodes/operator/k8s/external-secrets/{candidate-a,preview,production}/external-secret.yaml` — the ES leaves (preview/prod naming bug already fixed in `a4b01407cf`; the _ownership_ model is the open work).

## Design / Implementation Target

1. **Per-env node-set is declared, not assumed.** Add an explicit "which nodes
   deploy to env X" source (catalog field or per-env list) consumed by AppSet
   rendering + `reconcile-appset`. Default small (operator + scheduler-worker);
   nodes opt in per env. Deploying a node whose substrate isn't provisioned must
   fail loud, not OOM silently.
2. **One owner per ExternalSecret target.** Node ES leaves become Argo-managed
   (tracked, single-owner) OR provisioning is the sole applier with the
   convention name `<node>-env-secrets` — never both. No out-of-band `kubectl
apply` of an ES that Argo also manages.
3. **Provision/deploy contract holds:** flight/promote asserts substrate
   (read-only) and refuses on missing substrate with a loud handoff to the
   provision lane — never mutates DBs/roles/ESes itself. (Extends the existing
   `candidate-flight` "no deploy-infra" axiom to the ES + node-set planes.)
4. Regression guard: a re-provision of preview must NOT require any ledger-style
   manual edit to reach operator `/readyz` 200.

## Next Actions / Risks

- [ ] Decide the per-env node-set source of truth (catalog `envs:` field vs a
      per-env list) and thread it through `render-node-appset.sh` + `reconcile-appset`.
- [ ] Make node ExternalSecret leaves single-owner; delete the out-of-band apply path.
- [ ] Add a flight-time assertion: "node deployed but substrate absent" → fail loud.
- [ ] Falsifying test: re-provision preview → operator green, zero manual edits.
- [ ] Coordinate with the active provisioning dev (owns `provision-env` /
      `deploy-infra`; PR #1605 in flight) — this is the same seam they're working.
- Risk: candidate-a + preview currently green ONLY via manual cluster state (ledger
  rows 4/6/8) — a re-provision/flight reverts them until this lands. Don't assume
  the green is durable yet.
- Risk: per-env node-set must include `scheduler-worker` wherever `operator`
  deploys — operator `/readyz` hard-depends on it (`:9000`).

## Pointers

| File / Resource                                                      | Why it matters                                              |
| -------------------------------------------------------------------- | ----------------------------------------------------------- |
| `work/handoffs/manual-edits-ledger.node-wizard-2026-06-10.md`        | The evidence + the rows this work retires                   |
| `infra/k8s/argocd/preview-*-applicationset.yaml`                     | All-catalog deploy fan-out (the OOM source)                 |
| `scripts/ci/render-node-appset.sh` / `node-applicationset.yaml.tmpl` | Where the per-env node-set gate goes                        |
| `scripts/ci/reconcile-node-substrate.sh`                             | Provisioning's substrate writer (ES + DB) — the deploy seam |
| `nodes/operator/k8s/external-secrets/*/external-secret.yaml`         | ES leaves; ownership model is open                          |
| commit `a4b01407cf`                                                  | Already-landed ESO naming fix (the first durable increment) |
| Provisioning dev (active)                                            | Owns `provision-env`/`deploy-infra`; coordinate — same seam |
