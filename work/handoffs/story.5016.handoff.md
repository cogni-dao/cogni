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

Pickup: you own landing **one fresh, disposable, Crossplane-owned Akash node**, born and proven useful. The whole org is blocked on Akash CI/CD flowing; every other Akash workstream is parked behind this. The substrate is built and merged. The private Akash transaction actuator is **running on candidate-a for the first time** and is one ESO refresh away from verifying its wallet. Your job is to carry it from "wallet verified" to "a node exists that a developer can use", then keep the gate honest.

## Goal

- **End state:** a brand-new disposable node created through Crossplane (`create -> observe -> update -> close`), never imported, with cost rows grouped by immutable `node_id`. The 12 legacy zero-user fixtures are NOT repaired or migrated.
- **Next milestone (step 12):** actuator logs `akash_tx_actuator_wallet_verified` instead of `..._unverified`, then an `OBSERVE` returns `{found:false}` rather than a connection error.
- **candidate-a flight proof:** flight through the operator (`POST /api/v1/vcs/flight`, full 40-hex SHA — never a personal `gh` dispatch), then poll `https://test.cognidao.org/version` until `.buildSha` equals the flighted SHA exactly. `/version.buildSha` is the ONLY deploy ground truth; CI conclusions and workflow "success" both lied repeatedly during this work.
- **Developer-unblock gate (step 14):** exact public SHA, DNS/TLS, deep readiness, empty-birth operational + knowledge schemas, Temporal, one real LLM completion, request-correlated app log, and zero SSH / console clicks / manual deploy scripts.

## Start By Reading

- **`story.5016` work item `outcome`** — authoritative numbered checklist (1-14) and every binding decision. "Step N" always means that list. Read before anything else.
- Knowledge: `akash-actuator-wallet-cutover` (one wallet, one ACTIVE writer), `akash-cicd-pareto-scope`, `node-substrate-health-checklist` (canonical 20-row gate).
- Skills: `akash-node-expert`, `cicd-secrets-expert`, `devops-expert` (CI/CD boundary router), `node-wizard-scorecard` (made Akash-aware in #2216).
- Specs: `docs/spec/cicd-platform-boundary.md` (**the freeze — CI does not enforce it, review does**), `docs/spec/secrets-management.md`.
- Code: `infra/crossplane/xcomputeworkload/{xrd,composition}.yaml`; `nodes/operator/app/src/features/compute/akash-tx/`; `infra/k8s/base/akash-tx-actuator/`; `infra/k8s/overlays/candidate-a/operator/`.

## Current State

- `main` = `e6f585b125`. **preview** serves it. **production** is deliberately behind at `6bad39af`.
- **candidate-a serves `512b0995`** (#2215 rebased onto #2214) and has **ZERO Akash writers other than the actuator** — the legacy controller was removed by #2212. Intended cutover state.
- **STEP 12 IS DONE.** `operator-akash-tx-actuator` is `1/1 Running` and logged `akash_tx_actuator_wallet_verified` (expectedAccountId `akash12eh8xgpeyumar3sk6wp94y0tq9uh62mkezxjmt`) then `akash_tx_actuator_listening` (walletScope `akash-console:candidate-a`, port 8080, allowedProviders 1). It is the ONLY Akash writer on candidate-a. XRD `xcomputeworkloads.compute.cogni.io` ESTABLISHED, Composition `xcomputeworkload-akash` present, **zero XRs — step 13 mints the first**.
- **The credential is proven good, out-of-band:** `GET /v1/user/me` -> 200 `derekg1729`; `GET /v1/wallets` -> 200 `akash12eh8xgpeyumar3sk6wp94y0tq9uh62mkezxjmt`, 7,675,889 uact funded. That address is exactly what `AKASH_ACTUATOR_ACCOUNT_ID` pins, so the assertion will pass once projected.
- Secret is at `cogni/candidate-a/akash-tx-actuator/AKASH_ACTUATOR_CONSOLE_API_KEY` v3, written via the operator API with **no kube**.
- **Open PRs:** #2215 (public account id — CLEAN, flighted, unmerged), #2216 (Akash-aware wizard scorecard — CLEAN), #2217 (ESO `1h -> 1m` on both actuator ExternalSecrets — correct but tangential; merge when convenient, do not block on it).
- **Merged:** bug.5139 flight-lane fix; #2203 actuator; #2207 XRD+Composition; #2209 runtime; #2208 migration gate; #2210 `node_id` receipts; #2213 Composition identity; #2206 Spawn seam + `substrateHost`; #2212 legacy controller removal; #2211 wallet secret plane; #2214 operator-API platform-service write.
- **Five merged PRs were never proven on candidate-a** — #2209, #2210, #2211, #2206, #2212 went in on CI-green alone, skipping flight -> validate -> merge. Live on preview, absent from production. An independent validator was asked to cover them. **Treat as unproven.**
- **Credential hygiene:** the key briefly landed in `cogni/candidate-a/operator` (readable by the public operator app) before the path was corrected. Candidate-a only. **Rotate when convenient.**
- **YOU DO HAVE KUBE + SSH.** Validated env credentials are laptop-local at `~/dev/cogni-template/.local/provision-creds/candidate-a/` — `candidate-a-kubeconfig.yaml`, `candidate-a-vm-key`, OpenBao root. That dir's `README.md` status table is the custody SSoT and carries the current VM IP (candidate-a = `84.32.149.0`). Recall the `provision-env` skill; do NOT hunt `~/.ssh` or guess VM hostnames. This cost ~25 minutes of avoidable waiting here.

## Design / Implementation Target

1. **One wallet, ONE ACTIVE writer.** Same Console account; legacy key revoked, fresh key minted. A second account was proposed and rejected — it recreates the split-brain the cutover removes. v0 is **candidate-a only**: one actuator + one ledger per environment means preview/production would be extra writers on the same wallet.
2. **The actuator never holds two wallet credentials.** Separation is asserted at boot against a non-secret pinned account id, never a byte-comparison requiring both.
3. **The wallet credential never re-enters `cogni/<env>/operator`** — the public app consumes that whole bucket via `dataFrom: extract`. It lives at `cogni/<env>/akash-tx-actuator/*` behind its own ExternalSecret.
4. **Every paid mutation persists `{node_id, env, XR UID/generation, idempotency key}` BEFORE contacting Akash.** Columns are NOT NULL, so an unattributable receipt is unreachable. `node_id` is deliberately not a FK — spend evidence must outlive a purged node row.
5. **Crossplane owns generic reconciliation** (watches, retries, backoff, status, finalizers, composition). Cogni owns only Akash transaction mapping, custody, and the typed workload contract. **No new bespoke controller, no dual-writer, no compatibility layer.**
6. **The legacy ComputeWorkload controller is FROZEN and scheduled for deletion** (tasks 5097/5098). #2197's cost work moves to the actuator seam; it must not merge into the controller.
7. **CI/CD freeze holds:** no new inline decision logic in `candidate-flight.yml` / `promote-and-deploy.yml` `run:` blocks; search `scripts/ci/lib/` for an existing primitive before writing shell.
8. **Do not repair the legacy 12 fixtures** unless the fresh Crossplane node reproduces the failure.

## Next Actions / Risks

- [ ] Step 12: `OBSERVE` returns `{found:false}` rather than connection-refused.
- [ ] Step 13: mint EXACTLY ONE disposable node. Never spin a second to "retry" without closing the first.
- [ ] Merge #2215 and #2216 through **flight -> /validate-candidate -> merge**, never CI-green alone.
- [ ] Ask the secrets dev to land `bug.5016` (route silently reverts `source: human` keys on reconcile, returns 200).

**Gotchas that cost hours here:**
- **Rebase a PR onto main before flighting it.** #2215 was branched before #2214 merged; flighting it silently *downgraded* candidate-a's operator, the route dropped the unknown `service` field, and a wallet credential was misfiled into the public bucket. The route **should reject** an unrecognized field rather than strip it — worth fixing.
- **Always read the `path` in the secret-write response.** A 200 does not mean the intended bucket.
- **A single negative Loki sweep is NOT evidence of absence.** Two false findings came from this. Confirm with a second, differently-shaped query; prefer `| json | field="value"` over text regexes (`.` matches any char, so `compute.reconcile` never matches `compute_workload_reconciled`).
- **A promote/flight can report all-green and change nothing** if the SHA does not move. Verify `/version.buildSha`.
- **Manifest-only and trusted-workflow-YAML PRs genuinely cannot self-prove premerge** — that exception is real but narrow and does NOT cover app code.
- **`runtime.logPush` (bug.5127) is carried by the XRD but not emitted**, and Akash app logs do not reach Loki at all — step 14's request-correlated log must be declared blocked, not inferred from silence.
- Migration `0046` adds NOT NULL columns with no default; it requires `akash_tx_allocations` to be empty. Reasoned, never observed.
- **OpenFGA stores are per-environment** — a grant approved on production does not reach candidate-a.
