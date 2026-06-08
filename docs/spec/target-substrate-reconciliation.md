---
id: spec.target-substrate-reconciliation
type: spec
title: Target Substrate Reconciliation
status: draft
trust: draft
summary: Design contract for the narrow per-target substrate reconciler that makes nodeRef candidate flights self-heal catalog-derived runtime substrate before digest promotion.
read_when: Designing or reviewing candidate-flight target substrate changes, nodeRef flight, node formation launch E2E, per-node DNS/edge/DB/secret reconciliation, or changes around assert-target-substrate.sh.
implements: []
owner: derekg1729
created: 2026-06-08
verified: null
tags:
  - ci-cd
  - deployment
  - node-formation
  - substrate
---

# Target Substrate Reconciliation

## Context

PR #1577 makes `candidate-flight.yml` stop running hidden broad infra mutation
from the app flight path. That is the right boundary: app flight promotes a
proven artifact digest and verifies the target. It must not run
`deploy-infra.sh` as a surprise side effect.

But a pure read-only assertion is not enough for the node-wizard goal:

> A newly formed node publishes a child image, the operator deploy PR merges,
> and `nodeRef { nodeId, sourceSha }` flight to `candidate-a` makes
> `https://<slug>-test.cognidao.org/version` serve that `sourceSha` without
> privileged manual bridge work.

The observed `coulditbe` failure split the planes correctly:

- child source CI can fail to publish `image_repository:sha-<sourceSha>`;
- DNS can be reconciled successfully;
- Caddy live config, runtime DB inventory, k8s Secret/ExternalSecret, and node
  database can still be missing.

The first row belongs to the source repo CI repair. The remaining rows are
operator-owned deploy substrate. They need a narrow, idempotent per-target
reconciler before `assert-target-substrate.sh` and before app digest promotion.

## References

- [CI/CD Pipeline Flow](./ci-cd.md) - Axioms 4, 11, 16, 18, 19, and 21.
- [Node CI/CD Contract](./node-ci-cd-contract.md) - source-owned artifacts,
  operator-owned deploy plane, and target substrate assertion.
- [Secrets Management Contract](./secrets-management.md) - OpenBao/ESO
  invariants, especially pod `envFrom`, `ExternalSecret`, and DB credential
  source-of-truth rules.
- [Secrets Classification](./secrets-classification.md) - A/B/D/G routing
  boundaries.
- [`cicd-secrets-expert`](../../.claude/skills/cicd-secrets-expert/SKILL.md) -
  operational checklist for secret value handling.
- [`devops-expert`](../../.claude/skills/devops-expert/SKILL.md) - workflow and
  deploy-plane anti-patterns.
- [`node-wizard-expert`](../../.claude/skills/node-wizard-expert/SKILL.md) -
  node launch handoff contract.

## Goal

Make `nodeRef` candidate flight self-heal the catalog-derived substrate needed
for one target, then prove it by serving `/version.buildSha == sourceSha`.

The successful E2E path is:

1. Source repo builds and publishes `image_repository:sha-<sourceSha>`.
2. Operator parent deploy PR containing catalog, overlay, AppSet, Caddy route,
   and submodule pin is merged.
3. Candidate flight dispatches for `{ node_slug, source_sha }`.
4. Target substrate reconcile mutates only the narrow substrate for that
   target/environment.
5. `assert-target-substrate.sh` passes as a read-only proof.
6. Candidate flight promotes only the target digest to
   `deploy/candidate-a-<target>`.
7. Argo sync and endpoint verification pass for that target.
8. `/validate-candidate` scorecard is posted with workflow URL, candidate URL,
   buildSha proof, and Loki evidence for the reconcile.

## Non-Goals

- Do not reintroduce `deploy-infra.sh` into `candidate-flight.yml`.
- Do not rebuild source artifacts in the operator repo.
- Do not provision a new VM or bootstrap OpenBao/ESO from this lane. Missing
  environment substrate remains a loud failure with a pointer to
  `provision-env.yml`.
- Do not write secret values from app flight. The reconciler may create or
  apply Secret/ExternalSecret objects and may trigger ESO refresh, but OpenBao
  value writes stay in the secrets lane.
- Do not make `type=service` or `type=infra` pretend to be `type=node`.
  Service and infra target contracts need explicit branches.
- Do not add wizard-persisted CI state. The wizard emits launch facts; GitHub,
  GHCR, operator flight, Argo, and `/version` remain the live state sources.

## Design

### New Script

Add `scripts/ci/reconcile-target-substrate.sh`.

Inputs:

| Env var                                      | Meaning                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| `TARGET`                                     | Catalog target name. Required.                                            |
| `DEPLOY_ENVIRONMENT`                         | `candidate-a` initially; env-shaped for preview/prod reuse.               |
| `APP_SOURCE_DIR`                             | Checked-out operator app source carrying catalog and generated manifests. |
| `COGNI_CATALOG_ROOT`                         | Catalog root, defaulting to `$APP_SOURCE_DIR/infra/catalog`.              |
| `VM_HOST`, `SSH_OPTS`                        | VM access for candidate-a runner-owned reconcile.                         |
| `DOMAIN`, `FORK_DOMAIN_ROOT`                 | Host derivation, same helpers as `image-tags.sh` / DNS reconcile.         |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID` | DNS only; absence is a hard failure for nodeRef flight.                   |
| `SUBSTRATE_RECONCILE_SUMMARY_FILE`           | JSON summary artifact path.                                               |

The script reads `infra/catalog/$TARGET.yaml`, dispatches by `.type`, and
implements only `type=node` in the first PR.

Exit contract:

| Code | Meaning                                                                                                                        |
| ---- | ------------------------------------------------------------------------------------------------------------------------------ |
| `0`  | Reconcile completed and all owned rows converged.                                                                              |
| `1`  | Reconcile failed or an owned row could not converge.                                                                           |
| `2`  | Target type is unsupported by this reconciler. This must surface as a skipped or failed job intentionally, never silent green. |

The script emits one JSON summary with:

- `type: "target_substrate_reconcile_summary"`;
- `status: "success" | "failure" | "unsupported"`;
- `target`, `target_type`, `deploy_env`, `node_source_sha`, `head_sha`,
  `run_id`, `status_url`;
- per-row states: `unchanged`, `created`, `updated`, `refreshed`, `failed`,
  `unsupported`;
- redacted evidence only. No secret values, DSNs, tokens, or private keys.

Push the summary to Loki using the existing `loki-push` action with
low-cardinality labels:

```text
workflow=candidate-flight kind=target_substrate_reconcile slot=candidate-a
```

Do not put target names, SHAs, domains, or failure text in labels. They belong
inside the JSON body.

### Node Reconcile Rows

For `type=node`, the reconciler owns these rows:

| Row                   | Reconcile behavior                                                                                                                                                                        | Proof                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| AppSet                | Apply only `infra/k8s/argocd/<env>-<target>-applicationset.yaml` from `APP_SOURCE_DIR`; keep the #1577 lane isolation behavior.                                                           | `kubectl -n argocd get applicationset cogni-<env>-<target>`.           |
| DNS                   | Upsert `<target>-test.<root>` to the env apex VM IP using `reconcile-node-dns.sh` logic, scoped to the target when practical.                                                             | Cloudflare A record equals apex origin IP.                             |
| Edge env              | Ensure `/opt/cogni-template-edge/.env` has the derived `<TARGET>_DOMAIN` or primary `<TARGET>_UPSTREAM` line.                                                                             | File contains expected key/value.                                      |
| Caddyfile             | Ensure committed/generated Caddyfile is present on the VM and contains the target route/NodePort.                                                                                         | File contains host placeholder and `host.docker.internal:<node_port>`. |
| Caddy live config     | Recreate or reload Caddy only when edge env or Caddyfile hash changes. Prefer the existing `docker compose up -d --force-recreate caddy` pattern from `deploy-infra.sh`, scoped to Caddy. | Admin API config contains host and NodePort.                           |
| Namespace             | Ensure `cogni-<env>` exists.                                                                                                                                                              | `kubectl get namespace`.                                               |
| ExternalSecret/Secret | Ensure the target's declared ExternalSecret object exists, trigger a refresh if supported, and wait for Ready/Synced. Do not write OpenBao values.                                        | `ExternalSecret Ready=True` and Deployment-consumed Secret exists.     |
| Postgres DB           | Create the catalog-derived app DB if absent; do not alter pod-consumed role passwords.                                                                                                    | `SELECT 1 FROM pg_database WHERE datname = <db>`.                      |
| Runtime DB inventory  | Update `COGNI_NODE_DBS` in `/opt/cogni-template-runtime/.env` to include the catalog-derived DB name.                                                                                     | Runtime env includes the DB.                                           |

The first implementation may reuse narrow functions factored out of
`deploy-infra.sh`, but it must not call `deploy-infra.sh` wholesale. Shared code
should move into `scripts/ci/lib/target-substrate.sh` only when it removes real
duplication. Keep the workflow thin.

### Secret Boundary

The reconciler must respect the secrets specs:

- It may apply an ExternalSecret manifest and wait for ESO.
- It may create a k8s Secret only for the legacy plain-Secret bridge if that is
  already the current live contract for the target/environment.
- It must not generate, print, or patch secret values.
- It must not `bao kv put` or `bao kv patch`.
- It must not fix missing OpenBao keys by falling back to GitHub env secrets.
- It must not `ALTER ROLE ... PASSWORD` for pod-consumed DB roles.

If a pod-consumed secret is missing because OpenBao lacks a value, the row fails
with an actionable message pointing to the secrets lane. That is a substrate
failure, not an app promotion failure.

### Workflow Integration

In `candidate-flight.yml`, after #1577:

```text
decide
  -> reconcile-dns          # may be folded into reconcile-target later
  -> reconcile-appset       # may be folded into reconcile-target later
  -> reconcile-substrate    # new target-shaped mutation
  -> assert-substrate       # read-only proof from #1577
  -> flight                 # digest promotion only
  -> verify-candidate       # Argo, readiness, smoke, buildSha
```

Recommended first implementation:

- keep existing `reconcile-dns` and `reconcile-appset` jobs if #1577 merged
  them cleanly;
- add `reconcile-substrate` for the remaining node rows;
- make `assert-substrate` depend on all reconcile jobs;
- make `flight` depend on successful `assert-substrate`;
- keep `verify-candidate` unchanged except for summary/scorecard evidence.

This minimizes the follow-on PR blast radius. A later cleanup can fold
DNS/AppSet into one target-shaped job once the behavior is proven.

Concurrency:

- `reconcile-substrate-candidate-a-<target>` for target-local rows;
- keep DNS writes serialized if using whole-catalog DNS reconcile;
- do not use `cancel-in-progress: true` for substrate mutation.

### Owned vs Unowned Failures

The reconciler should heal only rows that are target-local and catalog-derived.

Owned and mutable:

- target AppSet object;
- target DNS A record;
- target Caddy edge env and route;
- target DB existence and `COGNI_NODE_DBS` membership;
- target ExternalSecret object/refresh where the manifest already declares the
  secret shape;
- target namespace when the env VM exists.

Unowned and fail-loud:

- missing VM host or SSH key;
- missing env apex DNS;
- missing Cloudflare credentials for nodeRef flight;
- missing Postgres/Caddy/docker/kubectl/OpenBao/ESO base services;
- missing source image `sha-<sourceSha>`;
- missing OpenBao values;
- DB credential mismatch requiring password mutation;
- unsupported target type.

This distinction is the core safety property: app flight becomes self-healing
for target birth substrate without becoming a general environment provisioner.

## Implementation Plan

1. Rebase after #1577 merges and keep its `assert-target-substrate.sh`.
2. Add `scripts/ci/reconcile-target-substrate.sh` with `type=node`.
3. Add focused fake-VM tests mirroring
   `scripts/ci/tests/assert-target-substrate.test.sh`:
   - creates missing edge env key;
   - recreates Caddy on env/Caddyfile change;
   - creates missing DB and DB inventory entry;
   - applies/refreshes ExternalSecret without secret value writes;
   - fails on missing OpenBao/ESO value;
   - is idempotent on second run;
   - emits redacted summary JSON.
4. Wire `candidate-flight.yml` with a `reconcile-substrate` job before
   `assert-substrate`.
5. Extend `scripts/ci/workflow-check.mjs` to pin the job ordering and prevent
   `deploy-infra.sh` from returning to `candidate-flight.yml`.
6. Update `docs/spec/ci-cd.md` Axiom 21 and
   `docs/spec/node-ci-cd-contract.md` to replace
   "asserted not provisioned" with the narrower contract:
   target-local substrate is reconciled, broad env substrate is not.
7. Update the relevant skills only after behavior is proven.

## Validation Before Merge

The implementation PR is not merge-ready until it proves both the positive and
negative path on `candidate-a`.

### Static and Unit Proof

Run focused checks only:

```bash
bash scripts/ci/tests/reconcile-target-substrate.test.sh
bash scripts/ci/tests/assert-target-substrate.test.sh
node scripts/ci/workflow-check.mjs
shellcheck scripts/ci/reconcile-target-substrate.sh scripts/ci/assert-target-substrate.sh
```

Do not run broad local check/build sweeps unless reproducing one named failing
check. GitHub CI remains the merge gate.

### Positive NodeRef Flight Proof

Use a real node source repo commit that has a published
`image_repository:sha-<sourceSha>` image. For greenfield validation, create or
reuse a throwaway node whose operator deploy PR has merged.

Dispatch the workflow from the implementation branch ref so the PR's workflow
YAML and scripts run before merge:

```bash
gh workflow run candidate-flight.yml \
  --repo Cogni-DAO/cogni \
  --ref <implementation-branch> \
  -f node_slug=<slug> \
  -f source_sha=<40-char-child-source-sha>
```

This branch-ref dispatch is the pre-merge workflow-source proof. The operator
API remains the sanctioned product entry point for normal agents; this explicit
validation run exists to test changed workflow code before it can be reached
from `main`.

Acceptance:

- `resolve image` finds `image_repository:sha-<sourceSha>`;
- `reconcile-substrate` succeeds and posts a Loki summary;
- `assert-substrate` succeeds;
- no `deploy-infra` job runs;
- `flight` writes only `deploy/candidate-a-<slug>`;
- `verify-candidate` succeeds;
- `https://<slug>-test.cognidao.org/version` returns
  `buildSha == <sourceSha>`;
- `/validate-candidate` scorecard is posted to the PR with workflow URL,
  candidate URL, buildSha proof, and Loki query/result for the reconciler.

### Idempotence Proof

Run the same nodeRef flight a second time from the same branch/ref and
sourceSha.

Acceptance:

- reconciler summary reports mostly `unchanged` or `refreshed`;
- no duplicate DNS records;
- no duplicate DB creation failure;
- no unnecessary Caddy recreate unless the hash changed;
- endpoint still serves the same sourceSha.

### Negative Proof

Run or simulate one unsupported/missing-substrate case without promoting a
digest.

Acceptable options:

- a fixture unit test where OpenBao/ESO value is absent;
- a workflow dispatch for a target type not implemented by the reconciler;
- a candidate-a controlled throwaway target with a missing unowned env
  prerequisite.

Acceptance:

- `reconcile-substrate` or `assert-substrate` fails before `flight`;
- `flight` and `verify-candidate` are skipped or failed by job-level gates;
- no deploy branch digest is promoted for the failed target;
- summary tells the operator which owning lane fixes it.

## Review Questions

Reviewers should decide these before implementation approval:

1. Should `reconcile-dns` and `reconcile-appset` remain separate in the first
   PR, or should `reconcile-target-substrate.sh` own them immediately?
2. For candidate-a, is the live secret contract still legacy
   `<node>-node-app-secrets`, ESO `<node>-env-secrets`, or both during
   transition?
3. Should `reconcile-target-substrate.sh` create missing Postgres DBs directly,
   or should it call a narrow extracted DB provision helper from
   `deploy-infra.sh`?
4. What Loki query should the scorecard standardize for
   `target_substrate_reconcile_summary`?
5. Does this PR cover candidate-a only, or should preview/prod wiring land at
   the same time behind environment inputs?

## Decision

The follow-on PR should build the narrow reconciler and keep #1577's read-only
assertion as the proof gate. The design is not "silent skip" and not "run
deploy-infra from app flight." It is:

```text
reconcile target-local substrate -> assert read-only -> promote digest -> verify endpoint
```

That is the smallest design that satisfies both constraints:

- new nodes become healthy at `candidate-a` without manual VM edits;
- app flight does not become a broad environment provisioner.
