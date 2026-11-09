# repo-spec · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @Cogni-DAO
- **Status:** stable

## Purpose

Pure parsing and typed extraction for `.cogni/repo-spec.yaml` — the governance-managed configuration for a Cogni node. Shared between the Next.js app (`src/`) and the Temporal `scheduler-worker` service. Contains Zod schemas, a pure `parseRepoSpec()` function, and typed accessor functions for extracting config sections.

## Pointers

- [Node vs Operator Contract](../../docs/spec/node-operator-contract.md)
- [Packages Architecture](../../docs/spec/packages-architecture.md)

## Boundaries

```json
{
  "layer": "packages",
  "may_import": [],
  "must_not_import": [
    "app",
    "features",
    "ports",
    "core",
    "adapters",
    "shared",
    "services"
  ]
}
```

**External deps:** `zod` (schema validation), `yaml` (YAML parsing), `ajv` (pass 1 of the workload-manifest check: the vendored Score v1b1 JSON schema).

## Public Surface

- **Exports:**
  - `parseRepoSpec(input: string | unknown): RepoSpec` — Pure parse function (accepts YAML string or pre-parsed object)
  - `extractPaymentConfig(spec, chainId)` — Maps payment config with chain validation
  - `extractGovernanceConfig(spec)` — Maps governance schedules + ledger config
  - `extractLedgerConfig(spec)` — Extracts ledger config (requires scope identity)
  - `extractLedgerApprovers(spec)` — Lowercased EVM approver addresses
  - `extractKnowledgeConfig(spec)` — Node-local knowledge DB + Cogni-owned DoltHub mirror declaration
  - `extractNodeId(spec)` — Node identity UUID
  - `extractNodes(spec)` — Node registry entries (operator-only, returns `[]` for non-operator specs)
  - `extractNodePath(spec, nodeId)` — Resolve a node UUID to its registered relative path; returns `null` on miss (caller decides fallback)
  - `extractNodeServices(spec)` — Provider-neutral app-tier service declaration; omission resolves to the legacy one-public-app default, while named runtime profiles opt services into operator-wired app or private workflow-Worker contracts
  - `nodeWorkloadSpecSchema` / `NodeWorkloadSpec` — the blue/green deploy spec a node-deploy release stores (task.5400): `app` | `state`, digest-pinned image, `expose` (http host | tcp global), `bindings`, required `exclusive`, `health`. Repo-spec no longer carries workloads.
  - Secrets catalog (bug.5254): `SecretsCatalogEntrySchema` / `SecretsCatalogFileSchema` are the ONE catalog entry schema (the operator loader imports them). `parseNodeSecretsCatalog(text, {nodeSlug, serviceNames})` checks a sovereign node's `.cogni/secrets-catalog.yaml` (pass 1 schema, pass 2 node policy; throws `SecretsCatalogError` without echoing values); `catalogSecretKeysFor(entries, service)` returns the keys an entry's `workloads` sends to that service. `NODE_SECRETS_CATALOG_PATH`. The catalog is the ONLY node secret declaration: repo-spec `secret_refs` (top level and per service) is retired, and `parseRepoSpec` refuses it with the fixed `RETIRED_SECRET_REFS_MESSAGE` (it points at `.cogni/secrets-catalog.yaml` `workloads`), never stripping it.
  - Workload manifests (story.5137, hub `workload-manifest`): `parseWorkloadManifest(text, file?)` runs pass 1 (the vendored, commit-pinned Score v1b1 schema, `src/vendor/score-v1b1.schema.ts`, `SCORE_V1B1_SOURCE`) and pass 2 (Cogni policy refuse-list); `lowerWorkloadManifest(m)` / `lowerWorkloadManifests(files)` accept 1–8 containers with a unique public entry selected by the route target/readiness port; private companions require bounded qualification annotations. They lower `.cogni/workloads/<name>.yaml` to `NodeWorkloadSpec[]` (cross-file: ids unique, ids differ from workload names). Supported dependencies: `postgres` class `dedicated` (→ a `state` workload named by its id, from `POSTGRES_DEDICATED_PROFILE_V1`) and `route`; anything else throws `WorkloadManifestError` with `unsupported_dependency_type`. `checkWorkloadDirectoryEntries(entries)` refuses any `.cogni/workloads` entry that is not a `*.yaml` file; a manifest over `MAX_WORKLOAD_MANIFEST_BYTES` (64 KiB) is refused before parsing. Placement (story.5141): `cogni.dev/placement-countries` and `cogni.dev/placement-countries-<env>` (`PLACEMENT_ENVS`) are checked in pass 2; `placementCountriesOf(m)` returns `{default?, byEnv}` and `resolvePlacementCountries(p, env)` picks one env's set; `lowerWorkloadManifests(files, {env})` puts it on the app as `placement.requiredCountryCodes`. Constants: `WORKLOAD_MANIFEST_DIR`, `WORKLOAD_MANIFEST_SUFFIX`, `MAX_WORKLOAD_MANIFESTS`, `DATA_BEARING_DEPENDENCY_TYPES`
  - Runtime profile secret contracts: `COGNI_NODE_APP_V1_REQUIRED_SECRET_KEYS` and `COGNI_WORKFLOW_WORKER_V1_REQUIRED_SECRET_KEYS`; `resolveRuntimeProfileSecretRefs({runtimeProfile})` returns a profile's implied keys (keys beyond the profile come from the catalog)
  - `buildNodeBundleTagRef(...)` / `verifyNodeBundleManifest(...)` — shared pure OCI publication identity and single-payload validation, reused by registry readers
  - `buildNodeArtifactBundle(...)` / `resolveNodeArtifactBundle(...)` — Pure exact-set source-SHA→digest bundle assembly and atomic resolution
  - `extractOwningNode(spec, paths)` — Paths → owning domain. Returns `single | conflict | miss`. Operator is a sovereign domain (catches `nodes/operator/**`, `packages/`, `.github/`, root configs); cross-domain mixing returns `conflict`. On `conflict`, the result also carries `operatorPaths` + `operatorNodeId` so downstream formatters can render the diagnostic without re-classifying. Bounded ride-along carve-out via `rideAlongApplied` flag (currently `pnpm-lock.yaml`, `work/**`, `docs/**`, `.claude/skills/**`, exact single-node-scope policy maintenance files, and the fast-check root app Vitest config exception). Mirrors `tests/ci-invariants/classify.ts` per spec § Single-Domain Scope.
  - `resolveRulePath(owningNode)` — Single source of truth for "where do this domain's `.cogni/rules/` live." Returns `<owningNode.path>/.cogni/rules` for every `single`-kind result — operator and sovereign nodes alike, no special case. Throws on `conflict`/`miss`. Routing code (e.g. `fetchPrContextActivity`) calls this rather than building paths inline.
  - `extractScopeId(spec)` — Scope identity UUID (throws if missing)
  - `extractChainId(spec)` — Numeric chain ID from governance section
  - Zod schemas: `repoSpecSchema`, `nodeRegistryEntrySchema`, `creditsTopupSpecSchema`, `governanceScheduleSchema`, etc.
  - Types: `RepoSpec`, `NodeRegistryEntry`, `InboundPaymentConfig`, `GovernanceConfig`, `GovernanceSchedule`, `LedgerConfig`, `LedgerPoolConfig`
- **Subpath `@cogni/repo-spec/testing`** — test-only fixtures; never imported from production code:
  - `TEST_NODE_IDS`, `TEST_NODE_ENTRIES`, `TEST_SCOPE_ID`, `TEST_CHAIN_ID`, `TEST_RECEIVING_ADDRESS`, `TEST_APPROVER_ADDRESS`
  - `buildTestRepoSpec(overrides?)` — parsed `RepoSpec` from minimal-valid input + overrides
  - `buildTestRepoSpecYaml(opts?)` — YAML string variant for tests that round-trip through `parseRepoSpec`
  - `buildTestRule(overrides?)` / `buildTestRuleYaml()` — `Rule` fixture builders

## Ports

- **Uses ports:** none
- **Implements ports:** none
- **Defines ports:** none

## Responsibilities

- This directory **does**: Define repo-spec Zod schemas, parse YAML or objects, extract typed config sections, check and lower workload manifests
- This directory **does not**: Perform file I/O, cache results, import from `src/` or `services/`, access `process.cwd()` or `process.env`

## Usage

```bash
pnpm --filter @cogni/repo-spec typecheck
pnpm --filter @cogni/repo-spec build
```

## Standards

- Pure functions only — no I/O, no side effects, no caching
- REPO_SPEC_AUTHORITY: Single canonical parser for Node and Operator code
- NO_CROSS_IMPORTS: Cannot import from `src/` or `services/`

## Dependencies

- **Internal:** none (standalone package)
- **External:** `zod`, `yaml`, `ajv`

## Change Protocol

- Update this file when public exports change
- Coordinate with node-operator-contract.md spec invariants

## Notes

- `src/shared/config/repoSpec.schema.ts` re-exports from this package so app code uses `@/shared/config` unchanged
- `src/shared/config/repoSpec.server.ts` is a thin I/O wrapper that delegates to this package
- Per PACKAGES_NO_SRC_IMPORTS: This package cannot import from `src/**`
