---
id: "bug.5287"
type: handoff
work_item_id: "bug.5287"
status: active
created: 2026-09-28
updated: 2026-09-28
branch: "fix/bug5287-host-routed-observe"
last_commit: "d21fcb4840"
---

# Handoff: Unblock node CI/CD with bounded Crossplane recovery

## Mission

Pickup: own `bug.5287` through real production E2E proof. Poly and toks5 are still blocked; do not mistake green unit checks, an in-progress promotion, or the merged recovery scaffolding for an unblock. The immediate mission is to make the typed Crossplane/actuator path recover a poisoned closed lease without a human lease-generation bump, prove exact SHA through preview and production, and preserve the north star that the legacy bespoke controller is deleted only after Crossplane owns bounded recovery.

## Goal

- toks5 preview recovers from its existing closed lease without a manual dispatch or `leaseGeneration` bump and serves `/version.buildSha == 71747c65e3134fc9151e9007cd1d15a704e6057e`.
- A normal preview-forward toks5 production promotion succeeds and `https://toks5.cognidao.org/version` serves the same exact SHA.
- Poly can use the same ordinary flight/promote path without this developer touching Poly source or forcing Argo; the Poly team currently reports blocked.
- Candidate proof for every operator PR means the official `candidate-flight.yml` succeeds, `https://test.cognidao.org/version.buildSha` equals the exact PR head, and the affected runtime signal is visible in structured logs/XR status.
- Only then may `task.5098` delete the legacy controller; deletion must retain bounded recovery and provider-strike ownership.

## Start By Reading

- Work item `bug.5287` from `GET https://cognidao.org/api/v1/work/items/bug.5287` — canonical scope and class A/B/C census.
- [CI/CD platform boundary](../../docs/spec/cicd-platform-boundary.md) and [CI/CD axioms](../../docs/spec/ci-cd.md).
- [Crossplane composition](../../infra/crossplane/xcomputeworkload/composition.yaml), especially OBSERVE mapping, `$closedForCurrentKey`, `$renderLease`, failure/status emission, and the recovery counter.
- [XRD](../../infra/crossplane/xcomputeworkload/xrd.yaml), especially `bootPolicy.onGiveUp` and `status.recovery`.
- [`AkashTxActuator.observe`](../../nodes/operator/app/src/features/compute/akash-tx/akash-tx-actuator.ts) and [`createAkashTxDispatcher`](../../nodes/operator/app/src/features/compute/akash-tx/akash-tx-http.ts).
- [`compute-workload-readiness.ts`](../../nodes/operator/app/src/features/compute/compute-workload-readiness.ts) — the merged reader tolerates the `None` sentinel.
- PRs [#2465](https://github.com/cogni-dao/cogni/pull/2465), [#2464](https://github.com/cogni-dao/cogni/pull/2464), and current [#2467](https://github.com/cogni-dao/cogni/pull/2467).

## Current State

- PR #2465 merged at `188d371cb89240e21585be2ddcd447b694e0b3ff`: readiness treats `failure.reason == "None"` as absent at both consumers.
- PR #2464 merged by `cogni-operator[bot]` at `de0149c10ef8643c97e548d65fa5524542f6de54`. It merged during active promotions despite the announced hold. It is live in operator preview and Crossplane composition revision 9.
- #2464 acceptance: stale failures clear; `status.recovery` is absent fleet-wide; no `:recover:` key and no `akash_tx_create`/`akash_tx_leased` event was emitted. This is safe scaffolding, not recovery. `onGiveUp` remains schema-limited to `Hold`.
- #2464 exact-head candidate run [36485929811](https://github.com/cogni-dao/cogni/actions/runs/36485929811) succeeded and candidate served `f94a29e28944f316d008333e7968dc63638ce767`.
- Current PR #2467 at implementation commit `d21fcb4840a28cb8b0eee7fb4493cef6a0a167ab` emits `publicHost` only on unpaid OBSERVE and logs `akash_tx_host_routed_probe_result` with key/host/SHA/found/state/endpoint-count/tri-state-serving. It does not widen recovery or enable spending.
- High-fidelity `crossplane render` succeeded against a realistic toks5 preview XR and rendered the exact public host and SHA only in OBSERVE. Local `check` suites were intentionally not used; one pre-push hook ran `check:fast` for six seconds, found only formatting, and the formatting issue was fixed. Remote CI is authoritative.
- At handoff, #2467 CI had `unit` and `build (operator)` in progress; all completed checks were green. No candidate flight has been dispatched for #2467.
- At handoff, Poly-owned preview run [36489078829](https://github.com/cogni-dao/cogni/actions/runs/36489078829) and production run [36489459674](https://github.com/cogni-dao/cogni/actions/runs/36489459674) were in progress. Do not cancel, modify, or force-sync them.
- toks5 remains blocked: preview DNS was unresolved/404/530 intermittently; production serves old SHA `cf5de44c45ff533335b6861735e61f622b6b39cc`; desired SHA is `71747c65e3134fc9151e9007cd1d15a704e6057e`; preview XR alternates `LeaseClosed`/`None`, `serving:false`, with no recovery key.
- Production Postgres exit-2 crash loop is tracked separately by the dev-manager under `bug.5293`; it causes live `ledger_unavailable` and can block authz/merge. Do not hide or misclassify it as stale status.
- All local monitors were stopped for this handoff. Worktree is clean on `fix/bug5287-host-routed-observe` tracking its origin branch.

## Design / Implementation Target

1. Land and deploy #2467 reader/writer safely, then prove public edge, XR `serving`, and `akash_tx_host_routed_probe_result` agree across the fleet. Healthy toks4 production must remain serving; a false negative blocks all recovery-predicate work.
2. Never key a destructive predicate on `serving` until host-routed proof is live and observed. Do not use XR Ready as the E2E signal; public `/version` exact SHA is authoritative.
3. Re-home provider screening and durable strike/tried state in the actuator ledger before enabling paid replacement. The legacy controller is currently the only writer; in-memory state or Crossplane status is insufficient.
4. Keep recovery deterministic and bounded: `xcw:<namespace>:<node>:<leaseGeneration>:recover:<n>`, maximum three, one mutation per revision, explicit terminal exhaustion, and no retry loop against a settled key.
5. Keep `Hold` the permanent default. Admit `Replace` only after strike recording is live, then opt in per node/environment—toks5 preview first. Never globally enable it.
6. Stay off Poly source and never force Argo there. Platform changes must let the Poly team re-dispatch normally; coordinate quiet windows because composition auto-sync and actuator images deploy on different clocks.
7. Do not delete the legacy controller until live recovery proof exists and every durable behavior it uniquely writes has a new owner. The target is one authority, not zero recovery.

## Next Actions / Risks

- [ ] Poll #2467 remote CI; fix real failures only. Do not run local `check`/`check:fast` on this constrained host.
- [ ] Wait for both Poly promotions to become terminal and observe two consecutive quiet-fleet samples before using the single candidate slot.
- [ ] Flight exact #2467 head through the production operator API; require green `candidate-flight.yml`, exact candidate `/version`, and the structured host-routed marker in logs.
- [ ] Merge #2467 only in a quiet window, observe composition auto-sync, then promote the operator image so the new log marker is live in production. Never force Argo.
- [ ] Compare every public `/version` result with XR `serving`; specifically prove toks4 production does not become a false negative. If it does, stop and fix probe routing before recovery work.
- [ ] Implement actuator-ledger provider strikes/tried-set ownership, candidate/prod prove it, then expand the XRD to admit `Replace` without changing its default.
- [ ] Opt only toks5 preview into `Replace`; prove one bounded recovery key is minted, no more than three can exist, and preview serves exact `71747c65` without manual generation change.
- [ ] Run normal toks5 preview-forward production promotion and require workflow green plus exact production `/version` SHA; only then mark `bug.5287` deploy-verified.
- Risk: the operator bot enqueued #2464 twice despite explicit holds. Check PR timeline/queue continuously; dequeue unexpected entries immediately.
- Risk: `ledger_unavailable` is live while `bug.5293` persists. Preserve the distinction between “probe false,” “probe could not run” (`serving:null` log), and ledger failure.
