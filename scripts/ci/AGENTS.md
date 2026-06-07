# ci · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

CI/CD automation scripts and configuration documentation for multiple pipeline systems.

## Pointers

- [build.sh](build.sh): Build Docker images
- [deploy.sh](deploy.sh): Deploy to infrastructure

## Boundaries

```json
{
  "layer": "scripts",
  "may_import": [],
  "must_not_import": ["*"]
}
```

## Public Surface

- **Exports:** none
- **CLI (if any):** `build.sh`, `push.sh`, `deploy.sh`, `deploy-infra.sh`, `test-image.sh`, `promote-k8s-image.sh`, `flight-preview.sh`, `set-preview-review-state.sh`, `create-release.sh`, `validate-dsns.sh`, `ensure-temporal-namespace.sh`, `compute_migrator_fingerprint.sh`, `check-gitops-manifests.sh`, `check-gitops-service-coverage.sh`, `loki_push.sh`, `fetch_github_job_logs.sh`, `healthcheck-openclaw.sh`, `seed-pnpm-store.sh`, `detect-affected.sh`, `build-and-push-images.sh`, `write-build-manifest.sh`, `resolve-pr-build-images.sh`, `promote-build-payload.sh`, `promote-preview-seed-main.sh`, `aggregate-rollup.sh`, `aggregate-decide-outcome.sh`, `resolve-cell-state.sh`, `report-candidate-status.sh`, `wait-for-candidate-ready.sh`, `smoke-candidate.sh`, `wait-for-argocd.sh`, `wait-for-in-cluster-services.sh`, `verify-buildsha.sh`, `update-source-sha-map.sh`, `provision-grafana-postgres-datasources.sh`, `workflow-check.mjs`, `sync-node-template-fork-pr.sh`
- **Env/Config keys:** `IMAGE_NAME`, `IMAGE_TAG`, `APP_IMAGE`, `MIGRATOR_IMAGE`, `COGNI_REPO_URL`, `COGNI_REPO_REF`, `PLATFORM`, `GHCR_PAT`, `CHERRY_AUTH_TOKEN`, `TF_VAR_*`, `POSTGRES_ROOT_USER`, `POSTGRES_ROOT_PASSWORD`, `APP_DB_USER`, `APP_DB_PASSWORD`, `APP_DB_SERVICE_USER`, `APP_DB_SERVICE_PASSWORD`, `APP_DB_READONLY_USER`, `APP_DB_READONLY_PASSWORD`, `APP_DB_NAME`, `DB_BACKUP_INTERVAL_SECONDS`, `DB_BACKUP_RETENTION_DAYS`, `GRAFANA_URL`, `GRAFANA_SERVICE_ACCOUNT_TOKEN`, `GRAFANA_PDC_SIGNING_TOKEN`, `GRAFANA_PDC_HOSTED_GRAFANA_ID`, `GRAFANA_PDC_CLUSTER`, `GRAFANA_PDC_NETWORK_ID`, `GRAFANA_PDC_NETWORK_UUID`, `LOKI_URL`, `LOKI_USER`, `LOKI_TOKEN`, `INTERNAL_OPS_TOKEN`, `LOG_FILE`, `JOB_NAME`, `LABELS`, `GITHUB_TOKEN`, `GITHUB_REPOSITORY`, `GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT`, `GITHUB_JOB`, `OUTPUT_FILE`, `TARGETS`, `TURBO_BIN`, `TURBO_SCM_BASE`, `TURBO_SCM_HEAD`, `PR_NUMBER`, `HEAD_SHA`, `RUN_ID`, `RUN_ATTEMPT`, `WORKFLOW_NAME`, `REF_NAME`, `GHCR_USERNAME`, `GHCR_TOKEN`, `IMAGES_FILE`, `MANIFEST_FILE`, `PAYLOAD_FILE`, `OVERLAY_ENV`, `SLOT`, `LEASE_FILE`, `STATUS_URL`, `TTL_MINUTES`, `STATE`, `DESCRIPTION`, `TARGET_URL`, `CONTEXT`, `DOMAIN`, `MAX_ATTEMPTS`, `SLEEP_SECONDS`, `VM_HOST`, `DEPLOY_ENVIRONMENT`, `EXPECTED_SHA`, `EXPECTED_BUILDSHA`, `NODES`, `SOURCE_SHA_MAP`, `ARGOCD_SYNC_VERIFIED`, `MAP_FILE`, `MAP_SCRIPT`, `PROMOTED_APPS`, `ARGOCD_TIMEOUT`, `ACTIVE_SYNC_AFTER`, `SSH_OPTS`, `SSH_KEY`, `CI_SSH_RETRY_ATTEMPTS`, `ROLLOUT_TIMEOUT`, `TEMPLATE_REPO`, `BASE_BRANCH`, `PR_TITLE`, `WATCH`, `WORK_ROOT`
- **Files considered API:** `scripts/*.sh`, `workflow-check.mjs`

## Responsibilities

- This directory **does**: Provide CI-agnostic deployment automation with artifact capture and documentation
- This directory **does not**: Contain pipeline YAML definitions or application logic

## Usage

Minimal local commands:

```bash
scripts/build.sh
scripts/push.sh
scripts/deploy.sh
scripts/loki_push.sh  # Push logs to Loki (requires LOKI_URL, LOKI_USER, LOKI_TOKEN, LOG_FILE, JOB_NAME, LABELS)
scripts/fetch_github_job_logs.sh  # Fetch job logs from GitHub Actions API (requires GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_JOB, OUTPUT_FILE)
```

## Standards

- Provider-agnostic scripts callable from any CI system
- Environment variable based configuration with sensitive value protection
- Fail-fast with clear error messages and artifact capture

## Dependencies

- **Internal:** `../../infra/provision/cherry/app/`
- **External:** Docker, OpenTofu, git, curl, jq

## Change Protocol

- Update this file when **script interfaces** or **environment variables** change
- Bump **Last reviewed** date
- Coordinate with actual pipeline definitions in /.github/workflows/

## Notes

- Scripts designed to be called from GitHub Actions or Jenkins
- Keep actual YAML pipelines in repository root .github/ directory
- `build.sh` builds both APP_IMAGE (runner target) and MIGRATOR_IMAGE (migrator target)
- Tag coupling: MIGRATOR_IMAGE = IMAGE_NAME:IMAGE_TAG-migrate
- `detect-affected.sh` mirrors the repo's turbo-aware SCM base/head selection and maps changed paths onto deployable image targets via each catalog entry's `path_prefix:` field (`CATALOG_IS_SSOT`, ci-cd.md axiom 16). Treats `infra/catalog/<target>.yaml` as target-scoped so new-node PRs flight only that node; lockfile changes ride with the selected node unless they are lockfile-only/global; shared `packages/*` changes use Turbo's package-level affected graph and map affected package names back to catalog image targets; catalog schema/loader changes and `scripts/ci/lib/image-tags.sh` remain global build inputs.
- `workflow-check.mjs` validates the GitHub Actions surface agents depend on: canonical `.yaml` CI filenames, removed legacy aliases, and which workflows are manually dispatchable.
- `sync-node-template-fork-pr.sh <owner/repo> <branch>` refreshes an open node-template fork PR branch from `cogni-test-org/node-template`, auto-resolves the known stale `ci.yaml` image-name conflict in favor of the template, runs the fork's workflow invariant when present, pushes, and prints PR/check links.
- `lib/image-tags.sh` is a thin shim that populates `ALL_TARGETS` / `NODE_TARGETS` and resolves image tags, node ports, DB names, and endpoint CSVs by reading `infra/catalog/*.yaml` at source time via the pre-installed `yq`. **Node IDs come from `nodes/<name>/.cogni/repo-spec.yaml`, not the catalog** (`REPO_SPEC_IS_IDENTITY_SSOT`, ci-cd.md axiom 16); `default_node_id` returns the `is_primary_host` node's `node_id` for `COGNI_DEFAULT_NODE_ID`. Repo-root-relative resolution; `COGNI_CATALOG_ROOT` overrides the catalog root for fixtures + the pre-merge birth flow, and the repo-spec tree is derived from it.
- `next-free-node-port.sh` owns the scarce per-VM k8s `node_port` (NodePort 30000–32767). Default mode prints the next free port (`max(node_port)+100`, ~x00 stride) — the scaffolder (`scripts/setup/scaffold-node.sh`) defaults `$3` to it so minting a node needs no hand-picked value. `--check` asserts cross-file `node_port` uniqueness (inexpressible in pure JSON-schema) and runs in `pr-build.yml` alongside `check-jsonschema --schemafile infra/catalog/_schema.json`; a clash fails the build (CATALOG_IS_SSOT, ci-cd.md axiom 16). Tested by `scripts/ci/tests/next-free-node-port.test.sh`; aliases `pnpm node-port:next` / `pnpm check:node-port-unique`.
- `build-and-push-images.sh` is the PR-build entrypoint for affected image pushes; workflows should pass resolved targets, not inline Docker command graphs
- `write-build-manifest.sh` writes the canonical build artifact consumed by later candidate-flight automation
- `resolve-pr-build-images.sh` resolves digest refs from the deterministic PR tag convention when candidate-flight needs the current pushed image set
- `promote-build-payload.sh` translates a resolved image payload into overlay mutations via `promote-k8s-image.sh`, writes `promoted_apps=<csv>` to `$GITHUB_OUTPUT` incrementally after each successful promotion (trap EXIT guarantees the exit-time write even on abort — bug.0328), and merges per-app `source_sha` into `.promote-state/source-sha-by-app.json`. Map-write failures are `::warning::` annotations; total map-write failure exits non-zero so provenance decay cannot silently persist.
- `report-candidate-status.sh` posts the terminal commit-status check on a PR head from `candidate-flight.yml`. The pre-matrix lease primitives (`acquire-candidate-slot.sh`, `release-candidate-slot.sh`, `infra/control/candidate-lease.json`) were retired in task.0376; per-node `concurrency: flight-<env>-<node>` is the lease (`BRANCH_HEAD_IS_LEASE`).
- `aggregate-rollup.sh <env>` (task.0376) computes `current-sha = git merge-base $(deploy/<env>-<node> tips)` and merges per-node `source-sha-by-app.json` entries into the rollup, preserving unaffected entries (`CURRENT_SHA_IS_MERGE_BASE` + `ROLLUP_MAP_PRESERVES_UNAFFECTED`). Called by `promote-and-deploy.yml`'s `aggregate-{preview,production}` job; rebase-retries on push contention.
- `resolve-cell-state.sh` (task.0376; Axiom 19 enforcement point) is the per-cell precondition gate inside the `verify-deploy` matrix in `promote-and-deploy.yml`. Reads `promoted-${NODE}.txt` + `deploy-sha-${NODE}.txt` from the cell artifact, hard-fails on missing artifact (Axiom 14) and on missing `VM_HOST` or empty `deploy_branch_sha` when the cell promoted (Axiom 19). Emits `promoted=` and `deploy_branch_sha=` to `$GITHUB_OUTPUT`. Replaces inline-bash gates that previously skipped silently when the env's `VM_HOST` secret was unseeded.
- `aggregate-decide-outcome.sh` (task.0376; Axiom 19 enforcement point) is the single decision function consumed by both `aggregate-preview` and `aggregate-production` in `promote-and-deploy.yml`. Walks `promoted-*.txt` and `verified-*.txt` markers in `CELLS_DIR`, asserts every promoted cell has a matching verified marker (Axiom 19), and combines that with the four upstream `*_RESULT` env vars to emit `outcome={dispatched|failed}`. `STRICT_FAIL=1` makes a non-`dispatched` outcome a hard exit 1 — used by `aggregate-production` to block the rollup write when an unverified-but-promoted cell slipped past job-level gates. The verified markers are written by `verify-buildsha.sh` when `MARKER_DIR` is set; the matrix uploads them as `cell-verify-<node>` artifacts, and `download-artifact pattern: cell-*` merges them into the same dir as the promoted markers.
- `wait-for-argocd.sh` uses per-invocation `$$.$RANDOM.$RANDOM` suffix on its remote `/tmp/` paths so concurrent matrix cells don't race each other's cleanup (task.0372).
- `wait-for-candidate-ready.sh` scopes `/readyz` polling to `PROMOTED_APPS` when set, matching affected-only candidate-flight matrix cells.
- PLATFORM env: native locally (fast), linux/amd64 in CI
- `deploy.sh` uses checksum-gated restart for LiteLLM: compares SHA256 of config file against stored hash at `/var/lib/cogni/litellm-config.sha256`, restarts only if changed
- `deploy.sh` runs `git-sync` as a bootstrap step before db-provision to populate `/repo` volume for brain tools
- `deploy.sh` sources `seed-pnpm-store.sh` (Step 7.5) to idempotently seed the `pnpm_store` Docker volume from a GHCR store image
- `deploy.sh` uses targeted pulls: only per-deploy images (app, migrator, scheduler-worker) and sandbox `:latest` images (cogni-sandbox-openclaw, pnpm-store) are explicitly pulled. The `:latest` pulls do a manifest check (~2s) and skip download if unchanged. Static/pinned images (postgres, litellm, alloy, temporal, autoheal, nginx, git-sync, busybox) use local Docker cache and are pulled by `compose up -d` only when missing.
- `deploy.sh` SSH connections use `ServerAliveInterval=15 ServerAliveCountMax=12` to prevent broken pipe on long operations
- `COGNI_REPO_URL`, `COGNI_REPO_REF`, `GIT_READ_TOKEN`, and `GIT_READ_USERNAME` are required env vars for deploy.sh, set by CI workflows
- `wait-for-argocd.sh` requires `PROMOTED_APPS` from the caller (no hardcoded default; emit via a decide job or upstream promote step). Acceptance is "EXPECTED_SHA identical-to or ancestor-of `status.sync.revision`" (compare-API ancestry on the VM, falls back to strict equality if `GH_TOKEN`/`GH_REPO` are unset) AND `status.health.status == Healthy`, not the top-level `sync.status`. `EXPECTED_SHA` MUST be a deploy-branch commit. While mismatched: first kick after `ACTIVE_SYNC_AFTER` (default 30s) does hard refresh + hook-sync `kubectl patch`; further kicks every `SYNC_KICK_INTERVAL` (default 45s). `ARGOCD_TIMEOUT` is a per-promoted-app budget. Before trusting rollout status, the promoted app's Deployment resource inside the Argo Application must report `status=Synced`.
