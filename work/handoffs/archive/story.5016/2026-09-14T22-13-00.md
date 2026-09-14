---
id: story.5016.handoff
type: handoff
work_item_id: story.5016
status: active
created: 2026-09-14
updated: 2026-09-14
branch: main
last_commit: e6f585b125
---

# Handoff: Akash v0 — one useful Crossplane-owned node

## Mission

Pickup: you own getting **one fresh, disposable, Crossplane-owned Akash node** born and proven useful. The entire org is blocked on Akash CI/CD flowing; every other Akash workstream is explicitly parked behind this. The substrate is built and merged — XComputeWorkload XRD + Composition, a private Akash transaction actuator, node-bound spend receipts, a migration gate, an isolated wallet secret plane, and a single Spawn seam. What remains is the live proof chain, and it is currently stuck one credential-write away from the actuator's first breath.

## Goal

- **End state:** a brand-new disposable node is created through Crossplane (`create -> observe -> update -> close`), never imported, with cost rows grouped by immutable `node_id`. The 12 legacy zero-user fixtures are NOT repaired or migrated.
- **The gate before that (story.5016 step 12), and your first real milestone:** on candidate-a, the actuator pod is healthy, ESO projects its credential, and an `OBSERVE` returns `{found:false}` instead of a connection error.
- **candidate-a flight proof:** flight through the operator (`POST /api/v1/vcs/flight` with the full 40-hex SHA — never a personal `gh` dispatch), then poll `https://test.cognidao.org/version` until `.buildSha` equals the flighted SHA **exactly**. `/version.buildSha` is the only deploy ground truth; CI conclusions and workflow "success" both lie here (proven twice tonight).
- **Developer-unblock gate (step 14):** exact public SHA, DNS/TLS, deep readiness, empty-birth operational + knowledge schemas, Temporal, one real LLM completion, request-correlated app log, and zero SSH / console clicks / manual deploy scripts.

## Start By Reading

- **`story.5016` work item `outcome`** — the authoritative numbered checklist (items 1-14) and every binding decision. "Step N" always means that list. Read it before anything else.
- Knowledge: `akash-actuator-wallet-cutover` (one wallet, one ACTIVE writer), `akash-cicd-pareto-scope` (scaling/lease boundary), `node-substrate-health-checklist` (the canonical 20-row gate).
- Skills: `akash-node-expert` (Akash runtime canon + live traps), `cicd-secrets-expert` (secret authority model), `node-wizard-scorecard` (being made Akash-aware in #2216).
- Specs: `docs/spec/cicd-platform-boundary.md` (**the CI/CD freeze — CI does not enforce it, review does**), `docs/spec/secrets-management.md` (the three write entry points).
- Code: `infra/crossplane/xcomputeworkload/{xrd,composition}.yaml`; `nodes/operator/app/src/features/compute/akash-tx/` (actuator, migration gate, wallet resolver); `nodes/operator/app/src/shared/db/akash-tx-allocations.ts`; `infra/k8s/base/akash-tx-actuator/`.

## Current State

- `main` = `e6f585b125`. **preview** serves it. **production** is far behind at `6bad39af` and deliberately untouched.
- **Merged:** flight-lane SIGPIPE fix (bug.5139); actuator (#2203); XRD+Composition (#2207); actuator runtime (#2209); migration gate (#2208); `node_id` receipts (#2210); Composition identity (#2213); Spawn seam + `substrateHost` (#2206); legacy controller removed from candidate-a (#2212); wallet secret plane (#2211); operator-API platform-service secret write (#2214).
- **Open:** #2215 (pins the public `AKASH_ACTUATOR_ACCOUNT_ID`) — CI green, flighted, not merged. #2216 (Akash-aware wizard scorecard) — CLEAN, not merged.
- **candidate-a** serves `38d3fea5` and currently has **zero Akash writers** — the legacy controller is gone and the actuator has never started. This is the intended cutover window.
- **BLOCKED — the actuator will not start.** `MountVolume.SetUp failed ... references non-existent secret key: AKASH_ACTUATOR_CONSOLE_API_KEY`. The credential was written successfully (`200`, v2) at 21:05, a flight ran `node-substrate` (materialize) at 21:22, ESO reconciled cleanly at 21:38, and the key was gone. The same volume's `source: agent` keys mount fine — only the human key vanished. **This is `bug.5016` (route silently reverts `source: human` keys on reconcile, returns 200) confirmed live on a platform-service path.**
- **Unblocking it needs Derek**: re-paste the same Akash Console key into the gitignored `.env.akash-actuator.local` (chmod 600). The value must never enter chat, argv, a log, or a PR.
- **Five merged PRs were never proven on candidate-a** — #2209, #2210, #2211, #2206, #2212 were merged on CI-green alone, skipping flight -> validate -> merge. They are live on preview, absent from production. An independent reviewer/validator has been asked to cover them. Treat them as unproven.

## Design / Implementation Target

1. **One wallet, ONE ACTIVE writer.** Same Akash Console account; the legacy key was revoked and a fresh one minted. A second Console account was proposed and rejected — it recreates the split-brain the cutover removes. v0 is **candidate-a only**: one actuator + one ledger per environment means preview/production would be additional independent writers on the same wallet.
2. **The actuator never holds two wallet credentials.** Separation is asserted at boot against a non-secret pinned account id, never a byte-comparison requiring both keys.
3. **The wallet credential never re-enters the broad `cogni/<env>/operator` bucket** — the public operator app consumes that entire bucket via `dataFrom: extract`. It lives at `cogni/<env>/akash-tx-actuator/*` behind its own ExternalSecret.
4. **Every paid mutation persists `{node_id, env, XR UID/generation, idempotency key}` BEFORE contacting Akash.** Columns are NOT NULL, so an unattributable receipt is unreachable. `node_id` is deliberately not a FK to the registry — spend evidence must outlive a purged node row.
5. **Crossplane owns generic reconciliation** (watches, retries, backoff, status, finalizers, composition). Cogni owns only Akash transaction mapping, custody, and the typed workload contract. **No new bespoke controller. No dual-writer. No compatibility layer.**
6. **The legacy ComputeWorkload controller is FROZEN and scheduled for deletion** (tasks 5097/5098). Add no capability to it. `#2197`'s cost work must move to the actuator seam, not merge into the controller.
7. **CI/CD freeze holds:** no new inline decision logic in `candidate-flight.yml` / `promote-and-deploy.yml` `run:` blocks. Search `scripts/ci/lib/` for an existing primitive before writing any shell.
8. **Do not repair the legacy 12 fixtures.** Their readiness, logging, and zero-drop rollout are parked unless the fresh Crossplane node reproduces the failure.

## Next Actions / Risks

- [ ] **Ask Derek to re-paste the Console key**, then write it via `POST /api/v1/nodes/<operatorId>/secrets {env:"candidate-a", key, value, service:"akash-tx-actuator"}` — **after** the last flight, or materialize erases it again. Shred the file after.
- [ ] Merge #2215 (account id) and #2216 (scorecard) through **flight -> /validate-candidate -> merge**, not CI-green.
- [ ] Step 12: actuator healthy -> ESO projection -> `OBSERVE {found:false}`.
- [ ] Step 13: mint exactly ONE disposable node. Never spin a second to "retry" without closing the first.
- [ ] Get `bug.5016` fixed (owned by the secrets dev) — until then **every human-value write is provisional** and must be re-verified after any reconcile.

**Gotchas that cost real time tonight:**
- **A single negative Loki sweep is NOT evidence of absence.** Two false findings came from this. Confirm with a second, differently-shaped query; prefer `| json | field="value"` over text regexes (`.` matches any char, so `compute.reconcile` never matches `compute_workload_reconciled`).
- **A promote/flight can report all-green and change nothing** — if the SHA does not move, no lease mutates and env is never rewritten. Verify `/version.buildSha`, never the workflow conclusion.
- **Manifest-only and trusted-workflow-YAML PRs genuinely cannot self-prove premerge** (no image at that head; `workflow_dispatch` runs YAML from `main`). That exception is real but narrow — it does **not** cover app code. Do not stretch it.
- **`runtime.logPush` (bug.5127) is carried by the XRD but not emitted**, and Akash app logs do not reach Loki at all. Step 14's request-correlated log cannot pass yet; declare it blocked rather than inferring from silence.
- Migration `0046` adds NOT NULL columns with no default — it requires `akash_tx_allocations` to be empty. Reasoned, never observed.
- OpenFGA stores are **per environment**: a grant approved on the production operator does not reach candidate-a.
