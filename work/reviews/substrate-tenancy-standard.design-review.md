# Design Review: story.5085 — shared-substrate-tenancy-standard (contrib-flock-leader-conductor-7725c554)

**Target:** entry `shared-substrate-tenancy-standard` + instance-one link edit to merged `noisy-neighbor-database-architecture`, as of contribution commit seq 1.
**Reviewer stance:** critical senior architect; the author is this same agent account, so this review attacked the draft and the fixes were applied as commit seq 2 before requesting merge.

## Summary

Generalizes the merged Postgres noisy-neighbor decision into one eight-verb tenancy lifecycle (declare → meter → bound → admit → watch → contain → graduate → prove) governing every shared substrate, with a per-substrate v0 coverage table and named gaps.

## Through-line check

story.5085's outcome sentence is Postgres-specific ("controlled Poly load replay automatically contained… 13 slots pass /readyz"). The standard does not change that scope — its own Scope discipline section pins tasks 5246/5247 to Postgres only — and the generalization was explicitly CEO-directed this session. Not a wander; PASS, with the note that the standard is an umbrella atom, not new implementation scope.

## Scorecard (of the seq-1 draft; fix column = what seq 2 changed)

| Dimension | Score | Rationale | Fixed in seq 2 |
| --- | --- | --- | --- |
| Simplicity | CONCERN | Invariants section restated the eight verbs under different names — three representations of one idea invites drift | Invariants section deleted; non-derivable content folded into verb 8 and a Residual-risk line |
| OSS-First | PASS | Mandates native per-substrate limits (Postgres roles, Temporal dynamic config, LiteLLM budgets, Redis ACL); forbids bespoke controllers | — |
| Architecture Alignment | PASS | Catalog-declared desired state, platform enforcement, one read model, projections-not-truth — all consistent with node-baas-substrate-model rules 2/4/5 | — |
| Boundary Placement | PASS | Pure policy entry, no code; explicitly routes executable pieces (configs, limits, alert rules) to `docs/spec/*` + code with implementing PRs | strengthened: that routing sentence added |
| Content Boundaries | CONCERN | A "standard" edges toward spec territory; hub is defensible for evolving architecture (node-baas source-of-truth boundary), but executable invariants must not live only here | Scope-discipline section now says executable pieces land in spec/code per implementing PR |
| Scope Discipline | PASS | New focused inbox (one unit of work); Postgres-first implementation untouched; one-sentence edit to the merged parent entry only | — |
| Risk Surface | FAIL | Three accuracy over-claims: (1) "Compute already siloed" contradicted the entry's own citation — the k3s control VM is a proven fleet-wide failure class (control-plane-self-starvation, 2026-09); (2) Temporal "pause namespace" fence and per-namespace bounds were asserted but never verified in our deploy; (3) verb 8 silently re-keyed `ReliabilityStatusV1` by substrate while the merged instance fixes its label set | (1) split into Compute (node apps) vs Compute (control plane) rows + candidate-a delivery-slot row + "not yet profiled" line; (2) Temporal cells marked "unverified in our deploy", fence softened to throttle-toward-zero; (3) verb 8 now states the explicit, low-cardinality `substrate` label extension |

One further CONCERN (accepted, not fixed): verb 4's single admission gate didn't fit spend- or label-shaped substrates; seq 2 makes the gate shape substrate-appropriate while keeping "no waiver". Domain `build-health` is kept for adjacency with the merged instance even though `build-core` is arguable.

## Blocking issues

None remaining — the three Risk Surface over-claims were the blockers; all corrected in contribution commit seq 2 and verified on the branch diff.

## CEO finding (seq 3): orphaned from the reliability expert's surfaces

The seq-1/2 draft cited only `node-baas-substrate-model` and `control-plane-self-starvation` — zero edges into the substrate + reliability expert's existing skill surfaces, so the standard would not have been recalled by the agent that actually operates fleet health. Fixed in commit seq 3: the body now states that Watch signals land as cells in `fleet-reliability-substrate-matrix` (no second matrix) and that fences run through the `fleet-reliability-reconcile-guide` loop with `postgres-crash-observability` evidence discipline, with matching citation edges (extends ×2, supports ×1). Final edge set: 6 citations across the two entries.

## Verdict: APPROVE (at seq 2) — for human merge

The standard is now honest about what is designed (Postgres), what is partial (AI gateway, observability), what is a gap (Temporal, Doltgres, Redis), and what is a proven failure class still shared (control-plane compute, env VM, candidate-a slot). Inbox: https://cognidao.org/knowledge/inbox/contrib-flock-leader-conductor-7725c554
