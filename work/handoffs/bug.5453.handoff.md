---
id: "bug.5453.handoff"
type: handoff
work_item_id: "bug.5453"
status: active
created: 2026-10-12
updated: 2026-10-12
branch: "docs/bug5453-generation-revert-handoff"
last_commit: "84de0bb964"
---

# Handoff: Candidate flights overwrite the deploy-branch `lease_generation`

## Mission

New mission: you own **bug.5453**. Poly's candidate-a Akash lane is stuck serving a sha nobody asked for, and every `candidate-flight` run has failed for two days because of it. The poly team reported this as "bug.5287: candidate flights revert recovered lease generation 40 to stale catalog generation 39". **That id is wrong and those numerals are unverified** — but there is a real, code-confirmed defect underneath, and it is almost certainly why the flight lane is dark. Your job is to settle one open question with a single cluster read, then close the revert vector so a live lane's generation cannot be silently lowered by an unrelated flight.

Two things make this worth a dev-manager rather than a solo agent: the decisive diagnostic needs candidate-a cluster access that the triaging agent did not hold, and the fix touches the frozen deploy brain (`candidate-flight.yml`), which per `docs/spec/cicd-platform-boundary.md` wants a reviewed primitive rather than more inline workflow shell.

## Goal

End state: a live Akash lane's `lease_generation` cannot be lowered by a flight, and poly's candidate-a lane converges on its desired generation and desired sha.

E2E validation — **`verify-candidate` is the proof, and it is red today, so you cannot fake this**:

1. Flight poly to candidate-a through the operator: `POST /api/v1/vcs/flight {nodeRef:{nodeId:"4b06359a-a859-4399-888e-a8c7a6696f7e", sourceSha:<built poly sha>}}`.
2. `external-node-preflight (poly)`, `flight (candidate-a, poly)` **and `verify-candidate (candidate-a, poly)`** all green in the same run.
3. `curl https://poly-test.cognidao.org/version` → `.buildSha` equals the flighted sha. It currently returns `dd05593876f19acf4b6d9d5e12f3af18fb68a607` regardless of what is flighted.
4. `GET /api/v1/nodes/4b06359a-a859-4399-888e-a8c7a6696f7e/deploy-state` → the candidate-a lease `cogniKey` names the catalog's desired generation, not an older one.

## Start By Reading

- `work/handoffs/bug.5453.handoff.md` (this file), then **[bug.5453](https://cognidao.org/work/items/bug.5453)** — the full triage, including what was and was not verified.
- `.github/workflows/candidate-flight.yml`, job `prepare-substrate-deploy-branch` — the `cp` of the catalog row and, right above it, the `PRESERVED_IMAGE_REF` dance that protects the deployed _digest_ from exactly this class. That asymmetry is the bug.
- `nodes/operator/app/src/app/api/v1/nodes/[id]/envs/route.ts` — `replacementLeaseGeneration(...)`. This is why a live generation can legitimately be _ahead_ of any source tree: it is derived from ledger-receipt evidence, not authored in git.
- **[bug.5287](https://cognidao.org/work/items/bug.5287)** — read only its `CURRENT STATE 2026-09-30` section and the `LIVE INSTANCE + NEW LEVERAGE 2026-10-06` section. Seven rounds above those correct each other; do not read them as settled fact. Its open defect #2 (task.5157, replay-forever receipts) is the adjacent failure you must not confuse with this one.
- **[bug.5324](https://cognidao.org/work/items/bug.5324)** — the competing hypothesis. The allocation ledger behind `deploy-state` can be stale, so the evidence below is consistent with two different conditions.
- Hub: `receipt-is-not-liveness`, `check-reads-not-record`, `guard-needs-proven-writer`. This arc keeps producing instances of all three; expect to add a fourth.
- `docs/spec/cicd-platform-boundary.md` — the freeze policy that constrains where your fix is allowed to live.

## Current State

Facts only, all re-verified 2026-10-12 08:4x–08:5xZ against `origin/main` at `84de0bb964`.

**The flight lane is dark.** `candidate-flight` last succeeded `2026-10-10T00:19:46Z`; 12+ consecutive failures since, latest [run 38222598378](https://github.com/cogni-dao/cogni/actions/runs/38222598378). The preflight is **not** the problem — it has been green since #2617 landed on 2026-10-08. The failing job is `verify-candidate`:

```
verify-buildsha: map mode restricted to NODES=poly (1 app(s))
❌ poly: buildSha=dd05593876f1 != expected 21ea4d407d08 after 420s / 75 attempts
❌ buildSha mismatch — deploy did not actually promote expected images.
```

**The generation gap.** `GET /nodes/{poly}/deploy-state` reports the latest candidate-a lease as:

| field               | value                                                           |
| ------------------- | --------------------------------------------------------------- |
| cogniKey            | `xcw:cogni-candidate-a:4b06359a-a859-4399-888e-a8c7a6696f7e:36` |
| state               | `allocated`                                                     |
| externalName (dseq) | `1790213576026`                                                 |
| closure             | `unknown`                                                       |

…while `infra/catalog/poly.yaml` has desired `lease_generation.candidate-a: 39` on both `origin/main` and `origin/deploy/candidate-a-poly`. The same response calls the lane `health: healthy, replicas 1/1` while it serves `dd05593876f1` — treat that health field as non-evidence.

**Generation 40 does not appear anywhere I can see.** `lease_generation.candidate-a` on `origin/main` went 37 → 38 (2026-09-30, #2498) → 39 (2026-10-02, #2556, _"re-mint candidate-a lease at gen 39 after an operator-released lease"_) and has been 39 for ten days. If a 40 existed it existed only off main and off the deploy branch — consistent with the reported revert, but not evidence of it.

**The revert vector is confirmed in code.** `prepare-substrate-deploy-branch` does:

```bash
mkdir -p infra/catalog
cp "../app-src/infra/catalog/${NODE}.yaml" "infra/catalog/${NODE}.yaml"
...
git add -A && git commit -m "candidate-flight ${NODE}: prepare substrate shape" && git push
```

Unconditional, whole-file, every flight. The deploy branch's catalog row is what Argo/the materializer renders the XR from, so any generation present there but absent from the flighted tree is silently lowered — **by an unrelated flight of the same node**. Same class as the already-recorded "a value living only outside the flighted tree is reverted by the next flight" (bit story.5016 and bug.5147); this is that pattern applied to the one field where a revert spends money and takes a node off its desired sha.

**Not started:** nothing has been changed for bug.5453. No branch, no PR. This handoff and the work item are the only artifacts.

## Design / Implementation Target

1. **Settle the condition first, with one read, before writing any code.** Read the live `XComputeWorkload` for poly in namespace `cogni-candidate-a` and record verbatim: desired generation, observed generation, and the lease child's `status.requestDetails.body.cogniKey`. If desired is 39 and the key is `:36`, the generation is not propagating — bug.5453. If the XR is on 39 and serving, the ledger behind `deploy-state` is stale — that is bug.5324 and this bug's urgency drops. **Do not skip this.** Four prior sessions on this arc each named a cause before proving it; two of them shipped on the guess.
2. **`lease_generation` must never be lowered by a shape commit.** Either preserve the live value across the `cp` the way `PRESERVED_IMAGE_REF` preserves the deployed digest, or fail loud naming both values and refusing the commit. Silently winning with the older number is the behaviour to delete. Pick one and say why in the PR.
3. **Respect the freeze.** `candidate-flight.yml` and `scripts/ci/*.sh` are the frozen deploy brain. A guard that tightens existing behaviour is acceptable in place; new promotion semantics are not. If the honest fix is "the deploy-branch catalog row is the wrong home for a ledger-derived field", say so and route it, rather than growing the workflow.
4. **Regression test in the shape of the bug.** Deploy branch at generation N+1, flighted tree at N, flight runs, generation is not lowered. The existing `scripts/ci/tests/*.test.sh` harness is the home; `tests/ci-invariants/` if the assertion is static over the workflow YAML.
5. **Close under the minting key, never a reconstructed one.** If any path you touch closes a lease, the key must be read back from `status.requestDetails.body.cogniKey` including any `:recover:<n>` suffix. A key rebuilt from the generation number hands REMOVE something the actuator never allocated and a live lease bills forever. This is bug.5287's explicit caution and it has already cost real money on this fleet.
6. **Do not widen `onGiveUp` and do not bump a generation to "see if it helps".** The `[Hold]`-only enum is a deliberate interlock pending task.5154; the 2026-09-29 insolvency would have blacklisted the fleet's own provider pool without it. A speculative bump on a live serving lane is covered by bug.5322 and is how nodes have gone down.

## Next Actions / Risks

- [ ] Read the live poly XR in `cogni-candidate-a` and record the three values from requirement 1 onto bug.5453.
- [ ] Branch the decision on that read: bug.5453 if the generation is not propagating, hand to bug.5324 if the ledger is stale.
- [ ] Implement requirement 2 plus the regression test from requirement 4.
- [ ] Prove with a green `verify-candidate` on a real poly flight and a matching `/version.buildSha`.
- [ ] Correct the poly team's reference: the id they quoted is bug.5287, the work is bug.5453.

**Blocked on a human, name it up front:** step 1 needs candidate-a cluster access. The triaging agent verified it does not hold it — `kubectl` is present but its only context is a local kind cluster, and the laptop's SSH keys for candidate-a are absent (the 2026-03-25 `cogni_template_production_deploy` key fails host-key verification against the current VMs). Per the `provision-env` custody rule the only durable copies live at `~/dev/cogni-template/.local/provision-creds/<env>/`, whose `README.md` is the custody SSoT and carries the live VM IP. **Whoever picks this up must either hold that credential or get it from Derek before starting — do not accept the loop and then bounce.**

**Risks and gotchas:**

- `deploy-state`'s `health: healthy` is not liveness. It calls this lane healthy while it serves the wrong sha. Same for `state: allocated` on the lease — that is the receipt's creation-time record, not chain state (`receipt-is-not-liveness`).
- `closure: unknown` means nobody has read the chain. The chain is the only authority on lease liveness.
- Do not conflate this with bug.5287's replay-forever defect. There, a _fresh_ key is forced through the full mint path and serves; here the question is whether a fresh key is ever requested at all. Opposite ends of the same pipe.
- `verify-candidate` failing is the honest signal and it should stay failing until the lane converges. Do not relax the 420s budget or the expected-sha check to get a green run.
- A green `candidate-flight` with `external-node-preflight` **skipped** proves nothing about this lane; check the job list, not the run conclusion.
