---
id: bug.0379
type: bug
title: "flight + verify-candidate distinct concurrency groups → cross-PR race window"
status: needs_design
priority: 3
rank: 80
estimate: 1
summary: "task.0372's per-cell concurrency uses two distinct group keys: `flight-<env>-<node>` (push) and `verify-candidate-<env>-<node>` (read). Two PRs touching the same node back-to-back can interleave: flight-1 push → flight-2 push → verify-1 starts with stale EXPECTED_SHA → wait-for-argocd timeout because Argo already reports flight-2's tip. Low-frequency window (requires 2 PRs same node back-to-back mid-verify) but the failure mode is a confusing red verify on a flight that actually deployed. Fix is to share one concurrency group across the (flight, verify-candidate) pair for the same (env, node)."
outcome: |
  - `flight` and `verify-candidate` matrix cells for the same `(env, node)` share one concurrency group (e.g. `flight-and-verify-<env>-<node>`).
  - Two PRs touching the same node serialize through the full push→verify cycle; matrix cells on different nodes still run in parallel.
  - Trade-off documented: a verify in progress for PR-A blocks the next flight push for PR-B on the same node. Acceptable since matrix-cell scope is tight and verify is bounded by `ARGOCD_TIMEOUT`.
spec_refs:
  - docs/spec/ci-cd.md
assignees: []
project: proj.cicd-services-gitops
branch:
pr:
created: 2026-04-25
updated: 2026-04-25
labels: [cicd, concurrency, task.0372-followup]
external_refs:
  - work/items/task.0372.candidate-flight-matrix-cutover.md
  - work/items/bug.0378.reconcile-appset-shared-write-race.md
---

# bug.0379 — flight↔verify cross-PR race

## Problem

After task.0372, candidate-flight runs two matrix legs per (env, node):

```
flight (push to deploy/<env>-<node>)        concurrency: flight-<env>-<node>
verify-candidate (wait-for-argocd + curls)  concurrency: verify-candidate-<env>-<node>
```

Distinct group keys → no serialization between the two legs across PRs.

Race scenario, same node, two PRs back-to-back:

```
t0: PR-A flight pushes deploy/candidate-a-poly @ shaA
t1: PR-A verify starts; reads EXPECTED_SHA=shaA from artifact
t2: PR-B flight pushes deploy/candidate-a-poly @ shaB     (no group conflict)
t3: PR-A verify polls Argo: sync.revision == shaB ≠ shaA  → wait-for-argocd timeout
t4: PR-A verify fails red on a flight that actually deployed cleanly
```

Frequency: low (requires 2 PRs touching the same node back-to-back during verify, ~1–3 min window). Failure mode: confusing red verify, no actual broken deploy. Reviewer flagged at task.0372 review L160/L315.

## Fix

Share one concurrency group across the (flight, verify-candidate) pair for the same (env, node):

```yaml
flight:
  ...
  concurrency:
    group: flight-and-verify-${{ matrix.env }}-${{ matrix.node }}
    cancel-in-progress: false

verify-candidate:
  ...
  concurrency:
    group: flight-and-verify-${{ matrix.env }}-${{ matrix.node }}
    cancel-in-progress: false
```

Cross-node parallelism is preserved; cross-PR same-node serializes through the full push→verify cycle.

Trade-off: a stuck verify for PR-A blocks PR-B on the same node until ARGOCD_TIMEOUT (default ~5 min) elapses. Acceptable.

## Validation

- (a) Trigger two flights against the same node from two different PRs ≤30s apart; observe PR-B's flight job sit in `pending` until PR-A's verify completes.
- (b) Different nodes still run fully parallel.
- (c) Matrix-cell isolation property preserved: a single failed verify on one node doesn't fail siblings.

## Out of scope

- Replacing matrix groups with a single workflow-level concurrency on the whole PR — that would re-serialize everything we built task.0372 to parallelize.
- bug.0378 fix (reconcile-appset apply race) is orthogonal — different shared write, different group.
