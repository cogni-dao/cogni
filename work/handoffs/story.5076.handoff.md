---
id: "story.5076-handoff-2026-10-12"
type: handoff
work_item_id: "story.5076"
status: active
created: 2026-10-12
updated: 2026-10-12
branch: "bug.5447-lane-local-substrate (PR #2691) · derekg1729/task-5238-temporal-health (PR #2689)"
last_commit: "c1ff7ca73d (PR #2691 head) · dbf1a7e75b (PR #2689 head) · main 84de0bb9+"
---

# Handoff: Temporal substrate — lane isolation + observable health for node schedules

## Mission

Pickup: you own [story.5076](https://cognidao.org/work/items/story.5076) ("Make durable agent workflows node-sovereign") and its two live child lanes: [bug.5447](https://cognidao.org/work/items/bug.5447) lane-local substrate topology (PR #2691) and [task.5238](https://cognidao.org/work/items/task.5238) server-observed worker health (PR #2689). Critical context that invalidates older briefings: **the production schedule run-layer already works** — poly schedules execute end-to-end on prod (restored by the story.5081 I/O recovery at 2026-10-12 01:06Z, not by this story's code). What is actually broken is lane ISOLATION (the production scheduler-worker executes candidate-lane work via `TEMPORAL_CUSTODIED_NAMESPACES`) and OBSERVABILITY (nobody can ask which worker/SHA/namespace serves a queue — an entire evening was lost to mis-attribution for exactly this reason). Derek hard-rejected the bespoke proof-harness approach (PR #2690 closed; task.5239 back to needs_design) — do not revive script-based probe suites.

## Goal

- Candidate-lane schedules and chat run on candidate substrate only; production's worker never polls candidate/preview namespaces (`TEMPORAL_CUSTODIED_NAMESPACES` removed — PR #2691).
- One authenticated command (`pnpm temporal:health`, PR #2689) returns exact worker source SHA + image digest + server-observed Workflow/Activity pollers per namespace/queue.
- E2E validation for #2691: flight to candidate-a at exact PR head, then the LIVE REPRO flips — Derek's poly-test every-5-min schedule (created 08:21:37Z 2026-10-12) stops being executed by the `env="production"` scheduler-worker stream in Loki and is executed by the candidate-lane worker instead; `/version` on the flighted operator candidate matches PR head SHA.
- E2E validation for #2689: flighted candidate serves authed `GET /api/v1/temporal/health` with fresh pollers and worker SHA/digest matching the flight's artifact identities.
- Both PRs merge only via operator `POST /api/v1/vcs/merge` after a posted /validate-candidate scorecard. Flight via `POST /api/v1/vcs/flight {nodeRef:{nodeId,sourceSha}}` (operator nodeId `4ff8eac1-4eba-4ed0-931b-b1fe4f64713d`).

## Start By Reading

- [docs/spec/substrate-temporal.md](../../docs/spec/substrate-temporal.md) — the authoritative model (one pooled generic worker per lane; node-direct schedule CRUD).
- [docs/spec/scheduler.md](../../docs/spec/scheduler.md) — invariants; note inv. 12: workflowId = `${scheduleId}-${scheduledStart}` (prefix-match, never equality).
- [services/scheduler-worker/src/worker.ts](../../services/scheduler-worker/src/worker.ts) — `TEMPORAL_CUSTODIED_NAMESPACES` cross-polling (the disease, ~line 316).
- [.github/actions/materialize-compute-workload/action.yml](../../.github/actions/materialize-compute-workload/action.yml) ~line 127 — `control_env_for` substrate conflation (what #2691 fixes).
- PR #2691 diff + PR body (two-axis split: control_env pays/reconciles; DEPLOYMENT_ENVIRONMENT picks Temporal/Redis/LiteLLM/worker).
- Dolt design (one diagram): https://cognidao.org/knowledge/inbox/contrib-flock-leader-conductor-21b270e3 — open, Derek merges.

## Current State

- MERGED: PR #2692 — reverted the flight-probe gate (#2661/#2669/#2671) that 404'd against prod and had broken EVERY candidate flight since Oct-10 00:19Z ([bug.5448](https://cognidao.org/work/items/bug.5448)). Fleet CI is unblocked; re-land requires promoting the prod endpoint FIRST.
- OPEN, CI green, cannot flight: PR #2691 (head c1ff7ca7) and PR #2689 (head dbf1a7e7). **Blocker:** candidate-a-operator ArgoCD is force-synced to pinned rev `63d2fc11` every ~2.5 min by the story.5081 recovery machinery — every flight fails at verify. Confirm with Loki: `{service="argocd-application-controller",env="candidate-a"} |= "Partial sync operation"`. Ask Derek/vm-dev session to lift the pin.
- CLOSED: PR #2690 (hard-rejected), #2688/#2687 (superseded). [task.5239](https://cognidao.org/work/items/task.5239) = needs_design with salvaged findings in its summary.
- Live ghost: Temporal-only orphan schedule `382c612f` (poly-brain, every minute, 255+ runs since 04:08Z, executed by the PROD worker, invisible in both poly UIs) — bug filed ~05:40Z+08:25Z; needs an admin Temporal kill and a registry-vs-Temporal reconcile pass.
- Unexplained CI seam: flight run 38199369663→38202487825 era — `prepare-substrate-deploy-branch` once promoted stale digest `1bcedfe` while decide resolved `1da434e` (ImagePullBackOff). Re-check on your first flight; suspect `scripts/ci/promote-k8s-image.sh` input wiring.
- Worktrees on this machine: `/tmp/bug5447-worktree` (#2691), `/tmp/pr2689-worktree` (detached, #2689), `/tmp/pr2690-worktree` (closed PR; contains unmerged workflowId/Loki-retry fixes worth salvaging into whatever proof design replaces it).

## Design / Implementation Target

1. Runtime substrate derives from `DEPLOYMENT_ENVIRONMENT` only; `control_env` keeps compute pay/reconcile + DB custody. No production token or namespace ever reaches candidate workloads (PR #2691 encodes this — verify, don't re-derive).
2. Production worker polls exactly its own namespace. Candidate worker polls every candidate node UUID queue (already true — renderer needed no fix).
3. Health endpoint stays pure observability per the hub's `node-observability-finish-pass` contract (adversarial review PASSED after one fix: event names from `EVENT_NAMES` registry, never inline).
4. Schedule-lifecycle proof (task.5239) must be redesigned inside existing test/validation layers — explicitly NOT a standalone .mjs harness; Derek rejected that on principle.
5. Never claim schedule behavior from worker log counts alone: Loki events ≠ persisted ledger rows ≠ UI rows; attribute a scheduleId to a lane/actor before reporting (tonight's hard lesson — see cancelled bug.5450/5451 correction notes).

## Next Actions / Risks

- [ ] Get the candidate-a pin lifted (Derek / story.5081 session), then flight #2691 at exact head and watch the live repro flip (before/after Loki streams).
- [ ] /validate-candidate scorecard on #2691 → operator merge → re-flight #2689 → health proof → merge.
- [ ] Verify Derek's poly-test every-5-min schedule's first runs: which worker executes it TODAY (expected: production — that's the repro; after #2691: candidate).
- [ ] Admin-kill ghost schedule 382c612f; design the Temporal-vs-registry reconcile.
- [ ] Redesign task.5239 proof per rejection; salvage findings from `/tmp/pr2690-worktree` last commit.
- Risks: the story.5081 session actively heals candidate-a — coordinate, don't fight it; GHCR digest seam may re-fail flights; node-template prod scheduled run `15e3a1c8` stuck in `running` (07:58Z) still needs its own bug.
