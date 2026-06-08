---
id: spec.target-substrate-reconciliation
type: spec
title: Target Substrate Reconciliation
status: draft
trust: draft
summary: Design contract for the narrow per-target substrate reconciler that makes nodeRef candidate flights self-heal catalog-derived runtime substrate before digest promotion without reviving legacy secret bridges or broad infra deploys.
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
- Caddy live config, runtime DB inventory, ESO ExternalSecret sync, and
  Postgres/Doltgres databases can still be missing.

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
- [Production Operator ESO Cutover](../runbooks/production-operator-eso-cutover.md)
  - current production direction: OpenBao + ESO replaces the legacy app secret
    bridge; cleanup is delayed for rollback, not kept as a design option.
- [Node BaaS Architecture](./node-baas-architecture.md) - node-owned intent vs
  operator-owned managed substrate.
- [Databases](./databases.md) and [Knowledge Data Plane](./knowledge-data-plane.md)
  - Postgres vs Doltgres split and per-node database independence.
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
- Do not write secret values from app flight. The reconciler may apply
  ExternalSecret objects and trigger ESO refresh, but OpenBao value writes stay
  in the secrets lane. It must not recreate the legacy plain-Secret bridge.
- Do not read pod-consumed DB role passwords from GitHub env secrets. DB role
  credentials are OpenBao-owned; missing OpenBao read access or missing values
  are loud substrate failures.
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

The script must not accept pod secret values or DB role password values as
inputs. The only allowed secret read for DB provisioning is the VM-local OpenBao
read path described in `secrets-management.md` Invariant 15:
`kubectl create token db-provisioner` -> OpenBao Kubernetes auth
`<env>-db-reader` -> read the DB credential keys already used by ESO for the
target service. If that read path is absent, sealed, unauthorized, or missing
keys, the DB row fails. There is no GitHub-secret fallback.

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
- `row_count`, `failed_row_count`, and `failed_rows` for quick Loki/Grafana
  inspection;
- `error_code` on every failed row. The code is stable and low-cardinality;
  human text stays in `message`;
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

| Row                  | Reconcile behavior                                                                                                                                                                                             | Proof                                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| AppSet               | Apply only `infra/k8s/argocd/<env>-<target>-applicationset.yaml` from `APP_SOURCE_DIR`; keep the #1577 lane isolation behavior.                                                                                | `kubectl -n argocd get applicationset cogni-<env>-<target>`.                                                                     |
| Argo Application     | Wait after AppSet apply for Argo to materialize the per-target Application before checking downstream objects.                                                                                                 | `kubectl -n argocd get application <env>-<target>`.                                                                              |
| DNS                  | Upsert `<target>-test.<root>` to the env apex VM IP using `reconcile-node-dns.sh` logic, scoped to the target when practical.                                                                                  | Cloudflare A record equals apex origin IP.                                                                                       |
| Edge env             | Ensure `/opt/cogni-template-edge/.env` has the derived `<TARGET>_DOMAIN` or primary `<TARGET>_UPSTREAM` line.                                                                                                  | File contains expected key/value.                                                                                                |
| Caddyfile            | Ensure committed/generated Caddyfile is present on the VM and contains the target route/NodePort.                                                                                                              | File contains host placeholder and `host.docker.internal:<node_port>`.                                                           |
| Caddy live config    | Recreate or reload Caddy only when edge env or Caddyfile hash changes. Prefer the existing `docker compose up -d --force-recreate caddy` pattern from `deploy-infra.sh`, scoped to Caddy.                      | Admin API config contains host and NodePort.                                                                                     |
| Namespace            | Ensure `cogni-<env>` exists.                                                                                                                                                                                   | `kubectl get namespace`.                                                                                                         |
| ExternalSecret       | Apply the target's declared ExternalSecret object from Git, annotate for force-sync when supported, and wait for Ready/Synced. Do not write OpenBao values and do not create `<target>-node-app-secrets`.      | `ExternalSecret Ready=True`; synced k8s Secret exists; Deployment consumes `<target>-env-secrets`.                               |
| Deployment/Service   | Wait for Argo-created Deployment and Service before enforcing the secret contract. This prevents cold-start false negatives immediately after AppSet apply.                                                    | Deployment exists; Service exists and later assertion checks the catalog NodePort.                                               |
| Postgres DB          | Create the catalog-derived app DB if absent, using OpenBao-sourced role credentials for any set-once role creation. Do not alter pod-consumed role passwords.                                                  | `SELECT 1 FROM pg_database WHERE datname = <db>`.                                                                                |
| Doltgres DB          | Create the catalog-derived knowledge DB if absent (`cogni_<target>` -> `knowledge_<target>`), using OpenBao-sourced role credentials for any set-once role creation. Do not alter pod-consumed role passwords. | `SELECT 1 FROM doltgres pg_database WHERE datname = <knowledge_db>` and the DB is reachable through the target's `DOLTGRES_URL`. |
| Runtime DB inventory | Update `COGNI_NODE_DBS` in `/opt/cogni-template-runtime/.env` to include the catalog-derived DB name.                                                                                                          | Runtime env includes the DB.                                                                                                     |

The first implementation may reuse narrow functions factored out of
`deploy-infra.sh`, but it must not call `deploy-infra.sh` wholesale. Shared code
should move into `scripts/ci/lib/target-substrate.sh` only when it removes real
duplication. Keep the workflow thin.

### Secret Boundary

The reconciler must respect the secrets specs:

- It may apply an ExternalSecret manifest and wait for ESO.
- It may annotate the ExternalSecret for a force-sync and rely on Reloader or
  the app rollout path to restart pods.
- It must not generate, print, or patch secret values.
- It must not `bao kv put` or `bao kv patch`.
- It must not fix missing OpenBao keys by falling back to GitHub env secrets.
- It must not `ALTER ROLE ... PASSWORD` for pod-consumed DB roles.
- It must not create or update `<target>-node-app-secrets`.

The first implementation should treat ESO as the only acceptable pod secret
contract for nodeRef flight. A target Deployment that still consumes the legacy
`<target>-node-app-secrets` plain Secret fails the secret row with an actionable
message to cut that target to `<target>-env-secrets`. ESO is already live in the
environments this design targets; preserving the bridge in the new reconciler
would recreate the legacy secret operation the platform is actively removing.

If a pod-consumed secret is missing because OpenBao lacks a value, the row fails
with an actionable message pointing to the secrets lane (`pnpm secrets:set`,
the per-operation `secret-set.yml`, or the operator-mediated secret writer).
That is a substrate failure, not an app promotion failure.

### Database Boundary

Postgres and Doltgres are both target-local substrate for node apps:

- Postgres owns operational data (`cogni_<target>`).
- Doltgres owns AI-written / AI-read knowledge (`knowledge_<target>`).

The reconciler must provision both, or fail loudly before app promotion. A node
that has a `/version` endpoint but no Doltgres knowledge DB is not a healthy
node-wizard E2E result.

The DB primitive should be extracted narrowly from the existing
`deploy-infra.sh` / `postgres-init/provision.sh` / `doltgres-init/provision.sh`
logic rather than shelling out to `deploy-infra.sh` wholesale. The extracted
primitive owns:

- confirming base Compose DB services are running;
- adding the target DB to `COGNI_NODE_DBS` without disturbing other entries;
- creating missing Postgres and Doltgres databases idempotently;
- creating DB roles only when absent, with create-time passwords read from
  OpenBao via the `<env>-db-reader` path;
- refusing to alter existing pod-consumed role passwords;
- emitting redacted evidence for each DB row.

Runtime `.env` changes are process inputs, not proof by themselves. When the
reconciler changes `COGNI_NODE_DBS`, it must run the narrow DB provisioners
after the change. It must not restart unrelated Compose services. If a later
implementation finds a Compose service that must reread the inventory, that
restart must be explicitly named and justified in the DB row summary.

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
- target Postgres and Doltgres DB existence plus `COGNI_NODE_DBS` membership;
- target ExternalSecret object/refresh where the manifest already declares the
  ESO secret shape;
- target namespace when the env VM exists.

Unowned and fail-loud:

- missing VM host or SSH key;
- missing env apex DNS;
- missing Cloudflare credentials for nodeRef flight;
- missing Postgres/Caddy/docker/kubectl/OpenBao/ESO base services;
- missing source image `sha-<sourceSha>`;
- missing OpenBao values;
- missing OpenBao `<env>-db-reader` path for DB role credential reads;
- DB credential mismatch requiring password mutation;
- Deployment still consuming legacy `<target>-node-app-secrets`;
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
   - creates missing Postgres DB and DB inventory entry;
   - creates missing Doltgres knowledge DB from the same inventory entry;
   - applies/refreshes ExternalSecret without secret value writes;
   - fails if the Deployment still consumes the legacy plain Secret;
   - fails on missing OpenBao/ESO value;
   - fails on missing OpenBao DB reader path instead of falling back to GitHub
     env secrets;
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
- `reconcile-substrate` succeeds and posts a Loki summary with successful edge,
  ESO, Postgres, Doltgres, and DB inventory rows;
- failed reconcile attempts post the same summary shape with `failed_rows` and
  row `error_code`, and `report-status` describes the pre-promotion substrate
  failure instead of a generic indeterminate result;
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
- summary tells the operator which owning lane fixes it;
- a legacy plain-Secret consumer, missing OpenBao value, or missing
  `<env>-db-reader` path fails without falling back to GitHub env secrets.

## Implementation Decisions

The first implementation keeps the scope intentionally narrow:

1. `reconcile-dns` and `reconcile-appset` remain separate workflow jobs because
   they already have lane-specific concurrency and telemetry. The new
   `reconcile-substrate` job owns the remaining target-local rows.
2. DB provisioning stays in `reconcile-target-substrate.sh` until a second
   reconciler needs the same logic. Helper extraction should happen only when it
   removes real duplication.
3. The OpenBao `<env>-db-reader` path is a prerequisite. Missing reader auth or
   missing OpenBao values fail the app flight before digest promotion.
4. Loki scorecards should query
   `target_substrate_reconcile_summary` by low-cardinality labels and inspect the
   JSON body fields `target`, `status`, `failed_rows`, and row `error_code`.
5. PR #1579 covers candidate-a only. Preview/production wiring should follow
   only after candidate-a proves the contract with a successful nodeRef flight.

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

The two load-bearing clarifications are:

- pod secrets are ESO-only for this path; the reconciler applies and waits on
  `<target>-env-secrets`, and refuses to recreate `<target>-node-app-secrets`;
- database substrate means both Postgres and Doltgres, with DB role credentials
  sourced from OpenBao or not used at all. GitHub env secrets are not a fallback
  source for pod-consumed DB roles.
