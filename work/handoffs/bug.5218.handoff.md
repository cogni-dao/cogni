---
id: bug.5218.handoff
type: handoff
work_item_id: bug.5218
status: active
created: 2026-09-17
updated: 2026-09-17
branch: flock-leader/bug-5206-egress-control-env
last_commit: 93134e769f
---

# Handoff: Compute-egress hardens the wrong cluster

## Mission

Pickup: you own **PR #2337** — the last known blocker between the poly-test canary and a
_gradeable_ result. The fleet is minting its first paid Akash lease in a non-production
lane today (dev2 drives that under `task.5132`). This fix does not make the lease mint; it
makes the lease **answer the question we are paying to ask**. Without it the canary boots,
serves `/version`, fails `/readyz?deep=1`, and gets diagnosed as a bad mint when the mint
was fine. Your job is to land #2337 before that lease is spent, and to hold the boundary
that caused it.

## Goal

End state: for any node whose lane is reconciled by a different cluster than the lane names,
the compute-egress allowlist is applied to **the cluster that holds that lane's substrate**.

E2E validation — this is deploy behavior, so prove it on the lane, not in CI:

- `candidate-flight` for poly logs `::notice::candidate-a's akash rows are custodied by
'production' — hardening that cluster's VM`, and the `reconcile-compute-egress` job runs
  with `environment: production`.
- `https://poly-test.cognidao.org/version` → `buildSha` = the flighted sha.
- `https://poly-test.cognidao.org/readyz?deep=1` → **200**. This is the real gate: `deep=1`
  makes EVM RPC, Temporal and scheduler-worker failures fatal instead of logged-and-200
  (`nodes/operator/app/src/app/(infra)/readyz/route.ts:114,137`). A 503 here **names the
  substrate that is still unreachable** — that is the signal this whole fix exists to buy.
- A green `/version` with a red `deep=1` is the exact symptom of this bug. Do not read it
  as a failed mint.

## Start By Reading

- `docs/spec/node-ci-cd-contract.md` § **Lane vs control env** — invariant 11, the rule this
  bug violates. Merged today as #2334; read this before touching anything env-shaped.
- Knowledge hub entry `lane-is-not-control` (and `substrate-one-derivation`) — the reasoning
  and the eleven prior instances. `GET /api/v1/knowledge/lane-is-not-control`.
- `scripts/ci/lib/appset-paths.sh` — `control_env_for()`. The one definition. Its header
  comment is the best short explanation of the split that exists.
- `scripts/ci/resolve-egress-control-env.sh` — the fix (new, this branch).
- `scripts/ci/render-compute-egress-allowlist.sh` — the CIDR renderer. Note its row
  predicate; the new script deliberately reuses it.
- `.github/actions/materialize-compute-workload/action.yml:105-118` — the prior art. The
  same `control_env_for` + `vm_host_for_env` pair, already correct. Mirror it, don't invent.

## Current State

Facts.

- **Branch** `flock-leader/bug-5206-egress-control-env`, last commit `93134e769f`, pushed.
- **PR #2337** open, CI not yet read. Needs dev2's review — it touches the write plane they own.
- **#2334** (the spec) merged to main via merge queue.
- Hub contribution `contrib-flock-leader-21cf8ce7` merged by Derek — `lane-is-not-control`
  is now recallable. It was written 2026-09-17 and sat unmerged; that invisibility is why
  this class of bug recurred.
- The resolver is verified against the live catalog: `candidate-a`, `preview` and
  `production` all resolve to `production`.
- **Not done:** no unit test for `resolve-egress-control-env.sh`. See requirement 4.
- **Not verified:** nothing has executed this code path. It is merged-but-unexecuted until a
  flight runs it — the exact status class that produced today's failures.

Adjacent, owned by dev2 under `task.5132` — do not duplicate:
`#2332` (verify custody), `#2333` (toks4 pin rot), `#2335` (poly env OFF, to recreate a
terminal XR), then the ON PR and the mint.

## Design / Implementation Target

1. The allowlist **contents** stay lane-scoped. `render-compute-egress-allowlist.sh` is
   correct (bug.5191) and must not change. Only the _target VM_ moves.
2. The egress job **runs in** the control env's GitHub environment. `VM_HOST` and
   `SSH_DEPLOY_KEY` are both environment-scoped; overriding the host alone presents the
   lane's deploy key to a foreign VM. This is why the fix is `environment:` and not an input.
3. The firewall target and the CIDR set are derived from the **same row predicate**.
   If they can drift, they will. `resolve-egress-control-env.sh` reuses the renderer's
   predicate for this reason; keep them together or merge them.
4. A lane whose akash rows disagree on control env **fails loud**. Silently picking one
   under-opens the other. This is the `cogni-test-org` case `bug.5208` leaves open — today
   every akash row is production-custodied, so the branch is unreachable but not theoretical.
5. Add a test under `scripts/ci/tests/` asserting (a) a foreign-custodied lane resolves to
   its control env, (b) a k3s-only lane resolves to itself, (c) a mixed lane exits non-zero.
   Author it against a **fixture catalog**, never by patching a live `infra/catalog/*.yaml`
   row — #2325 was exactly that mistake.
6. Boundary: no new platform logic in `.github/workflows/*.yml`. The CI/CD freeze
   (`docs/spec/cicd-platform-boundary.md`) wants a lib primitive before inline workflow
   shell; that is why the resolver is a script and the workflow only calls it.

## Next Actions / Risks

- [ ] `gh pr checks 2337 --watch --fail-fast` — blocks; exit code is the verdict. Re-read
      after, finished ≠ green.
- [ ] Get dev2's review. They own the write plane; two agents editing the same workflows is
      how #2327/#2316 became unmergeable.
- [ ] Add the fixture test (requirement 5) before merge, not after.
- [ ] Land **before** the mint in `task.5132`. After the mint it only helps the retry.
- [ ] Watch the first flight for the `::notice::` line. If it is absent, the resolver did not
      run and the job silently used the lane VM again.

Risks and gotchas:

- **This path has never executed.** Treat first-run defects as expected, not as evidence the
  design is wrong.
- **`environment:` as an expression** is valid in GitHub Actions but changes which secrets
  resolve. If `production` has no `SSH_DEPLOY_KEY`, the job fails at the guard in
  `reconcile-compute-egress/action.yml:41` with a clear message — that is the designed
  failure, not a regression.
- **Do not "fix" a `deep=1` 503 by loosening `deep=1`.** It is the only gate that sees
  substrate. A green `/version` is a boot receipt, not a readiness claim.
- **The wallet is not the risk; a wasted signal is.** Zero spend after a week is the failure
  metric here, not a safety result. If the canary fails, it should fail for a reason the
  scorecard can name.
- This is the **twelfth** instance of one conflation. Before writing any value keyed on env,
  ask which of the two questions it answers. The rule is now in the spec and the hub — cite
  it rather than re-deriving it.
