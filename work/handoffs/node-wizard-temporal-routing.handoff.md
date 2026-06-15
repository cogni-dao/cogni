---
id: node-wizard-temporal-routing
type: handoff
work_item_id: ""
status: active
created: 2026-06-10
updated: 2026-06-10
branch: derekg1729/node-wizard-formation-wiring
last_commit: f1da0dbb72
---

# Handoff: Born-green Temporal routing for node-wizard spawns (PR #1609)

## Mission

Pickup: drive **PR #1609** to green + merge, then prove **a wizard-spawned node is
born with working AI chat across all envs**. A submodule node (e.g. `oss`) was being
dropped from scheduler-worker Temporal routing, so `chat/completions` hung forever —
the last gap to a reproducibly-green node spawn. The fix is implemented; you own
landing it + the E2E proof. This is the graph-execution **substrate** half of the
node-baas model (peer of OpenFGA Authorization #1613, per-env node-set #1607).

## Goal

A node minted by the wizard reaches `chat/completions` success on **candidate-a →
preview → production** with **zero manual scheduler edits**.

**E2E validation (candidate-a):** re-flight `oss` (operator API node-ref flight, or
`candidate-flight.yml -f node_slug=oss -f source_sha=<oss-main-40char>`). After
Argo sync: `curl -s https://oss-test.cognidao.org/version` returns the flighted
`buildSha`; then register an agent and POST `chat/completions` with
`{"graph_name":"poet","model":"gpt-4o-mini",...}` → a **completion comes back**
(it hangs today without the fix). The catalog `node_id` projection must feed
`COGNI_NODE_ENDPOINTS` with **no hand-edit** to the configmap. Repeat on preview
(born-correct #1584) + prod.

## Start By Reading

- `docs/design/node-wizard-formation-wiring.md` — this PR's design (as-built + endgame)
- `docs/spec/node-baas-architecture.md` §BaaS Substrate Map — Graphs = routing substrate
- `scripts/ci/lib/image-tags.sh` — `node_internal_service_endpoint_csv` / `node_billing_endpoint_csv` (is_built_by_this_repo lifted), node_id cache (catalog projection fallback)
- `scripts/ci/render-scheduler-worker-endpoints.sh` — `verify_projection` hard gate + `--check`
- `nodes/operator/app/src/adapters/server/vcs/github-repo-write.ts` — mint splices the endpoint (resolved the `:1184` skip)
- `work/handoffs/manual-edits-ledger.node-wizard-2026-06-10.md` — every session hand-edit + its durable fix

## Current State

- **PR #1609** (one PR, design + code) on `derekg1729/node-wizard-formation-wiring` @ `f1da0dbb72`, rebased on `main` (post #1607 + #1613).
- **Implemented:** lift `is_built_by_this_repo` from both routing CSVs (kept in build selection); `node_id` projection onto **submodule rows only** (7 backfilled: ayo, coulditbe, creative, node-template, oss, pandora, please); `_schema.json` requires node_id when `source_repo` set, forbids it in-repo; hard drift gate (`catalog.node_id == repo-spec.node_id`); `gens/catalog.ts` emits node_id; mint splices via `insertSchedulerEndpoint`; `scheduler-runtime-routing.test.sh` updated + **passing locally**; configmap regenerated (all 10 nodes), drift gate green.
- **CI:** `static` (biome import order) and `unit` (scheduler-runtime-routing test) were red → **both fixed + pushed**. `build (canary)` failed on a **transient Docker Hub flake** (`registry-1.docker.io` timeout) — re-run clears it. CI is re-running now.
- **Not done:** CI fully green, merge, the flight E2E proof on all 3 envs.

## Design / Implementation Target

1. **`is_built_by_this_repo` gates build selection only** — never the routing/billing CSVs. They enumerate every catalog `type:node`.
2. **`node_id` is a drift-gated projection on submodule rows only.** `REPO_SPEC_IS_IDENTITY_SSOT` holds — repo-spec is authority, catalog mirrors; the gate asserts equality (repo-spec wins). In-repo nodes must NOT carry catalog node_id.
3. **NO_SILENT_DROP** — a `type:node` with unresolvable node_id fails the CSV + the drift gate loudly.
4. **Born-green** — the mint emits node_id + splices the endpoint, so a spawn's formation PR is drift-clean and chat works on first flight. No per-node hand-edits.
5. **Don't regress** #1607 (`envs:` per-env node-set) or #1613 (OpenFGA Authorization substrate). Endgame (deferred): converge deploy `envs:` + authz `node:` objects + graph routing onto one **node-registry** membership SSOT (task.5083) with dynamic worker discovery.

## Next Actions / Risks

- [ ] Watch `gh pr checks 1609`; re-run `build (canary)` if it's still the Docker flake (not a logic fail).
- [ ] Merge #1609 through the queue (NOT admin-merge — bug.0443).
- [ ] Flight `oss` to candidate-a (zero scheduler hand-edit) → run the Goal's chat proof → it returns a completion.
- [ ] Promote/flight to preview + prod; confirm `COGNI_NODE_ENDPOINTS` carries oss from the catalog projection at each env.
- [ ] **Revert ledger row 3** — the candidate-a `bao kv patch oss DOLTGRES_URL` hand-patch (TO-REVERT; superseded by the #1584 Doltgres-half cutover, separate work).
- Gotcha: biome static is non-deterministic per-PR (memory `feedback_biome_static_nondeterministic`) — escalations shift on rebase; fix imports with `biome check --write`, don't chase per-finding.
- Gotcha: candidate-a/preview are propped on manual cluster state from this session (ledger) — a re-provision reverts it until the durable fixes (#1607 etc.) fully land.
- Risk: don't admin-merge a CD-affecting PR (no `mq-*` image → un-promotable).
