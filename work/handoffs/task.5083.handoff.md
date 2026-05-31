---
id: task.5083.handoff
type: handoff
work_item_id: task.5083
status: active
created: 2026-05-30
updated: 2026-05-30
branch: derekg1729/operator-node-registry-v0
last_commit: d88c4d721
pr: 1381
---

# Handoff: Operator node-registry v0 — finish E2E wizard

## Read First

- User explicitly paused flighting after `d88c4d721`. Do **not** dispatch candidate flight until Derek resumes.
- PR #1381 head is `d88c4d721 fix(operator): align node setup wizard flow`.
- GitHub Actions are green except external `SonarCloud Code Analysis`, which Derek said to ignore for now. The in-repo `sonar` Actions job passed.
- Legacy `/setup/dao` and `/setup/dao/payments` routes must stay as-is in this PR. Any cleanup of those old surfaces belongs in a later isolated PR.

## Correct Knowledge Block

```text
v3 PRD corrects v2 errors: SoT is .cogni/repo-spec.yaml (not infra/catalog), Dolthub restored as first-class node attribute, columns aligned to identity-model.md primitives, two-PR publish, published/active split, and v0 monorepo nodes may use operator-custodial wallet provisioning only as an explicit design exception/blocker, not by accident (task.5083)
contrib-derek-claude-curitiba-85a9d305
```

Follow-up task requested by Derek: add Dolthub address to node attributes + repo-spec, and create a new Dolthub in the wizard.

## End Goal

One E2E-testable node setup wizard for v0 monorepo-internal nodes:

1. Register node identity.
2. Form DAO with founder wallet signatures.
3. Publish initial `.cogni/repo-spec.yaml` PR with governance and `payments.status: pending_activation`.
4. Provision/confirm operator wallet.
5. Configure payments.
6. Publish activation/update PR and reach `active`.

The user-facing flow should be canonical under `/setup/nodes` and `/setup/nodes/:id`. The older `/setup/dao` pages remain pre-existing legacy surfaces, but do not make them the main node-registry wizard.

## Current Code State

Implemented and pushed:

- Node identity UI now leads with node slug, `node_id`, `scope default`, and target path. Repo URL is no longer the primary human identifier.
- Duplicate slug creation now returns `409` instead of silently reopening an old row. This fixed the confusing “active without signing” path when a reused slug landed on an old node.
- State machine restored to the five-stage workflow shape plus terminal `active`:
  - `dao_pending -> dao_formed -> published -> wallet_ready -> payments_ready -> active`
  - Events: `dao_verified`, `spec_published`, `wallet_provisioned`, `payments_configured`, `activation_published`, `fail`
- `published` was added as a distinct DB status via migration `0030_nodes_published_status.sql`.
- Publish route now advances `dao_formed -> published`, not `dao_formed -> active`.
- Node detail page embeds the DAO formation panel on `/setup/nodes/:id` for `dao_pending`.
- Node detail page shows the wallet stage as an explicit blocker after `published`.
- Legacy `/setup/dao` and `/setup/dao/payments` were restored from the pre-cleanup state and should not be touched in this PR unless absolutely necessary.

Local checks passed before push:

- `pnpm typecheck` in `nodes/operator/app`
- `pnpm lint` in `nodes/operator/app`
- `pnpm test tests/unit/features/nodes/state-machine.test.ts tests/unit/features/nodes/repo-spec-builder.test.ts`
- pre-push `scripts/check-fast.sh`

Remote checks after push:

- `build (operator)`, `static`, `unit`, `component`, `manifest`, CodeQL, title, single-node-scope all passed.
- External SonarCloud failed on quality gate/coverage; Derek said to ignore Sonar for now.

## Known Design Tension

`docs/spec/node-formation.md` still says formation is governance-only and child-owned wallet activation lives outside the shared operator. Derek clarified that for **v0 monorepo-internal nodes**, operator custody of wallet provisioning may be acceptable.

Do not silently reintroduce the deleted wallet provisioning path as if the old architecture were fine. Treat it as a conscious v0 design exception:

- shared operator may provision wallet for monorepo-internal nodes only if the decision is explicit;
- custody/blast-radius/fork-away tradeoff must be reflected in spec/PRD or at least the PR description;
- UI should make wallet provisioning the blocker until that decision is implemented cleanly.

## Next Dev Todo

1. Re-open PR #1381 and inspect the current diff from `origin/main`, not old handoffs.
2. Re-read:
   - `docs/spec/identity-model.md`
   - `docs/spec/node-formation.md`
   - this handoff
   - current `features/nodes/state-machine.ts`
3. Decide the v0 wallet path with Derek:
   - Option A: implement operator-custodial wallet provisioning only for monorepo-internal nodes.
   - Option B: keep wallet step as explicit blocker and publish PR with wizard working through DAO + publish.
4. If implementing wallet provisioning:
   - recover/rebuild the deleted wallet route/capability from older branch history only after updating the design contract;
   - transition `published -> wallet_ready`;
   - write `operator_wallet.address` into the node row and the activation repo-spec path;
   - do not use broad external-node custody.
5. Implement payments stage:
   - `wallet_ready -> payments_ready` after split/payment config is proven;
   - preserve existing payment activation code where possible;
   - do not mark `payments.status: active` without proof.
6. Implement final activation publish:
   - two-PR model: initial governance repo-spec PR, then activation/update PR;
   - `payments_ready -> active` only after activation PR is opened or merged, per final decision.
7. Add Dolthub follow-up if in scope:
   - node attribute;
   - repo-spec field;
   - wizard creation step.
8. Run local checks, push, wait for CI.
9. Only after Derek resumes: dispatch `Candidate Flight` for PR #1381 at the then-current head SHA.
10. Validate E2E on candidate:
    - register a fresh unique slug;
    - form DAO with actual wallet signatures;
    - publish initial PR;
    - observe wallet blocker or wallet provisioning;
    - continue payments if implemented;
    - confirm Loki evidence for own requests.

## Files To Inspect

- `nodes/operator/app/src/features/nodes/state-machine.ts`
- `nodes/operator/app/src/shared/db/nodes.ts`
- `nodes/operator/app/src/app/(app)/setup/nodes/page.tsx`
- `nodes/operator/app/src/app/(app)/setup/nodes/[id]/page.tsx`
- `nodes/operator/app/src/app/(app)/setup/nodes/[id]/NodeActionPanel.client.tsx`
- `nodes/operator/app/src/app/(app)/setup/nodes/[id]/NodeDaoFormationPanel.client.tsx`
- `nodes/operator/app/src/app/api/v1/nodes/route.ts`
- `nodes/operator/app/src/app/api/v1/nodes/[id]/route.ts`
- `nodes/operator/app/src/app/api/v1/nodes/[id]/publish/route.ts`
- `nodes/operator/app/src/features/nodes/repo-spec-builder.ts`
- `nodes/operator/app/src/adapters/server/db/migrations/0030_nodes_published_status.sql`

## Important Caveats

- Authed UI E2E needs Derek’s browser or captured `.local-auth/candidate-a-operator.storageState.json`; currently only `candidate-a-poly.storageState.json` was present during this session.
- Candidate-a was previously flighted successfully at older head `1d36f7f1...`; that is obsolete after `d88c4d721`.
- PR #1390 was opened during manual testing for slug `hi`; it came from a reused/old node row. Do not use that as clean E2E evidence.
- Do not rename the branch.
