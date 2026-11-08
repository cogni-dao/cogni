---
name: test-expert
description: Authoritative reference for the cogni-template test pyramid and production-like e2e test topology — enforcement vs test layers, vitest configs, infra prereqs, GitHub/DoltHub test org boundaries, the cogni-operator-test app, what agents can/can't run locally, coverage tracking, and the non-obvious gotchas that bite every time. Use this skill whenever the user is writing a new test, asking "which layer does this belong in", debugging a flaky test, hitting CWD/env-loading issues, deciding between unit/component/stack/external, running any `pnpm test:*` or `pnpm arch:check` / `pnpm lint` command, working with testcontainers, touching fake adapters or `APP_ENV=test`, troubleshooting skip-gates, seeing errors from `.env.test` not loading, wondering about coverage or whether a test will run in CI, or trying to decide whether to run stack/e2e locally vs defer to CI. Also trigger when the user mentions mocking the database, Privy/GitHub App construction errors in tests, the smee proxy, `pnpm test:smee`, validating the agent API, the candidate/test GitHub App, `cogni-test-org`, `cogni-test-nodes`, node-formation flight testing, or anything that smells like test-environment setup. Short-circuits the usual "spelunk through docs + configs" lookup.
---

# test-expert

Route the work through [operator-architect](https://cognidao.org/knowledge/operator-architect) first; this skill adds the test pyramid and e2e topology rules on top of it.

Reference desk for writing and debugging tests in this monorepo. Leads with the matrix; gotchas follow because half of test failures here trace back to one of eight repeated mistakes.

There are two distinct things people lump together as "tests":

- **Enforcement** — static checks run in CI that fail builds when rules are violated (typecheck, lint, dep-cruiser, format, doc invariants).
- **Test layers** — vitest (+ Playwright) suites that exercise code behavior.

The matrix below separates them because their tradeoffs, speeds, and fix patterns are different.

## Enforcement matrix (not vitest — static checks)

| Check           | Command                  | What it enforces                                         | Fix when it fails                           |
| --------------- | ------------------------ | -------------------------------------------------------- | ------------------------------------------- |
| **Typecheck**   | `pnpm typecheck`         | TS types across workspace                                | Fix the type, don't `any`-cast              |
| **Lint**        | `pnpm lint`              | Biome + ESLint rules                                     | `pnpm lint:fix` auto-fixes most             |
| **Format**      | `pnpm format:check`      | Prettier + Biome format                                  | `pnpm format` auto-fixes                    |
| **Arch**        | `pnpm arch:check`        | `.dependency-cruiser.cjs` layer / entry-point boundaries | Refactor the import, don't disable the rule |
| **Docs**        | `pnpm check:docs`        | AGENTS.md headers, metadata, work-item index             | Fix the frontmatter                         |
| **Root layout** | `pnpm check:root-layout` | Project root structure invariants                        | Move the misplaced file                     |

All of the above run in `ci.yaml`. **`pnpm check` / `check:fast` / `check:fast:fix` are resource-heavy and default to NO — clarify permission first (AGENTS.md, Local execution safety).** Default to the single enforcement command for your touched surface (`pnpm lint` / `biome check <path>`, `pnpm typecheck`) and let CI run the full bundle. Run the aggregate `check:fast:fix` → `check:fast` → `check` sequence only when the human explicitly asks you to verify locally this session — worth asking for when the change is complex and your confidence in clean CI is low (and a heavy run can crash a device that is also running sibling agents).

## Test layer matrix (vitest + Playwright)

| Layer              | Config                                   | Tests live in                   | Proves                                                                                                                                                                      | Infra needed                                               | Command                       | In PR CI?                                                                                                                                                                                          |
| ------------------ | ---------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Unit**           | `nodes/operator/app/vitest.config.mts`   | `tests/unit/`                   | Pure logic, no I/O                                                                                                                                                          | None                                                       | `pnpm test:unit`              | ✅ — the CI `unit` job runs `scripts/ci/run-unit-tests.sh`: affected-only on a PR, full in the merge queue                                                                                         |
| **Meta**           | same                                     | `tests/meta/`                   | Doc / spec invariants                                                                                                                                                       | None                                                       | `pnpm test:meta`              | ✅                                                                                                                                                                                                 |
| **Contract**       | same                                     | `tests/contract/`               | Zod shapes vs route handlers                                                                                                                                                | None (in-memory)                                           | `pnpm test:contract`          | ✅                                                                                                                                                                                                 |
| **Ports**          | same                                     | `tests/ports/`                  | Every adapter implements its port                                                                                                                                           | None                                                       | (in `pnpm test:app`)          | ✅                                                                                                                                                                                                 |
| **Security**       | same                                     | `tests/security/`               | Auth, RLS, injection guards                                                                                                                                                 | None                                                       | (in `pnpm test:app`)          | ✅                                                                                                                                                                                                 |
| **Arch (meta)**    | root `vitest.config.mts`                 | `tests/arch/`                   | _Enforcement itself hasn't been weakened_ — spawns `depcruise` against arch-probe fixtures to prove rules still catch violations                                            | None (subprocess)                                          | `pnpm test:arch`              | ✅                                                                                                                                                                                                 |
| **Lint (meta)**    | root `vitest.config.mts`                 | `tests/lint/`                   | Verifies lint-rule config hasn't been weakened — same meta-test pattern as `tests/arch/`. Catches an LLM disabling an ESLint/Biome rule to make a PR pass.                  | None                                                       | `pnpm test:lint`              | ✅                                                                                                                                                                                                 |
| **Component**      | `vitest.component.config.mts`            | `tests/component/*.int.test.ts` | Adapter ↔ real Postgres                                                                                                                                                    | Testcontainers (Docker)                                    | `pnpm test:component`         | ✅                                                                                                                                                                                                 |
| **Stack (single)** | `vitest.stack.config.mts`                | `tests/stack/`                  | Full HTTP through one node                                                                                                                                                  | `dev:stack:test` or `docker:test:stack`                    | `pnpm test:stack:dev`         | ❌ — `stack-test.yml` is `workflow_dispatch` only. Run it by hand.                                                                                                                                 |
| **Stack (multi)**  | `vitest.stack-multi.config.mts`          | `tests/stack/`                  | Cross-node isolation / routing                                                                                                                                              | No script starts it. `dev:stack:full:test` does not exist. | `pnpm test:stack:multi`       | ❌ — no CI job runs it                                                                                                                                                                             |
| **External**       | `vitest.external.config.mts`             | `tests/external/` (non-money)   | Real 3rd-party APIs                                                                                                                                                         | GH App creds, Ollama, optional `pnpm test:smee`            | `pnpm test:external`          | ❌                                                                                                                                                                                                 |
| **External money** | `vitest.external-money.config.mts`       | `tests/external/money/`         | Real on-chain + real OpenRouter spend                                                                                                                                       | Funded wallet, `dev:stack` running, OpenRouter key         | `pnpm test:external:money`    | ❌ — This lane has no tests today.                                                                                                                                                                 |
| **E2E**            | Playwright (root `playwright.config.ts`) | `e2e/` (repo root)              | Browser black box against a running stack                                                                                                                                   | A deployed env (`TEST_BASE_URL`) or `docker:stack`         | `pnpm e2e:smoke` / `pnpm e2e` | ❌ on a PR. Project `smoke` runs after each operator preview and production deploy (`promote-and-deploy.yml` job `e2e`, `pnpm e2e:smoke`). Project `staging-full` (`pnpm e2e`) runs nowhere in CI. |
| **Env e2e**        | test operator deploy verb                | deployed test-org node          | Production-like pipeline for a test-org node: node CI image `sha-<sha>` → `POST https://test.cognidao.org/api/v1/deploy/workloads` → release `active` → one `/version` read | `cogni-operator-test`, test GH/DoltHub orgs, test fleet    | operator API + GH checks      | 🟡 Partially wired. This is the missing repeatable lane, not a vitest suite. See "Environment e2e test lane" below.                                                                                |

The operator config is `nodes/operator/app/vitest.config.mts`. The root `vitest.config.mts` (plain `pnpm test`) includes only `tests/**`, `packages/*/tests` and `services/*/tests`. It does not run operator tests.

### Meta note on `tests/arch/` + `tests/lint/`

These are intentionally separate from the enforcement commands. `pnpm arch:check` validates the codebase _right now_. `tests/arch/` validates that the enforcement itself still works (i.e., that someone — including an LLM — hasn't quietly weakened the dep-cruiser rules to make a failing PR pass). If `arch:check` passes but `tests/arch/` would fail, that's the signal rules have been neutered. `tests/lint/` uses the same pattern. It exists, and `pnpm test:lint` runs it.

## Tokenomics distribution e2e — the "walk" fork harness (scripts/e2e/)

The full token-distribution loop has a **proven, product-code e2e** most agents don't know exists because it lives in `scripts/e2e/`, not a vitest lane. It is the regression proof for the whole finalize→fold→publish→claim mechanism — reach for it before hand-testing distributions.

| Harness                                             | Proves                                                                                                                                                                                                                                                                                | How                                                                                                                                                                                                                                              | Real $ / prod risk                 |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| `scripts/e2e/finalize-mint-claim.ts`                | **sign → finalize → fold → mint → claim, conservation holds** — drives the REAL `finalizeEpoch` + `buildAndPersistCumulativeDistribution` fold, the persisted manifest, and the vendored 1inch `CumulativeMerkleDrop`. Only the admin EIP-712 signature + orchestration are scripted. | `pnpm test:walk:dev` (anvil Base-fork + real host ledger worker via Temporal). Prereqs: foundry on PATH, `pnpm dev:infra`, a review epoch pinned to the anvil approver (`SEED_APPROVERS=0xf39F…2266 pnpm db:seed`). See `scripts/e2e/README.md`. | None — anvil fork + local DB only. |
| `scripts/e2e/verify-publish-condition-on-fork.ts`   | The scoped `DistributionPublishCondition` answers ERC-165 so `DAO.grantWithCondition` doesn't revert, and `isGranted` allows ONLY the publish shape (positive + negative execute checks).                                                                                             | `pnpm tsx scripts/e2e/verify-publish-condition-on-fork.ts` against a running `scripts/e2e/start-fork.sh`.                                                                                                                                        | None — fork.                       |
| `scripts/e2e/seed-toks2.mts` (+ `SEED_INCREMENT=1`) | Seeds a toks2 review epoch (or an increment folded onto the prior manifest) for the local-UI walk rig.                                                                                                                                                                                | `DATABASE_SERVICE_URL=… pnpm tsx scripts/e2e/seed-toks2.mts`.                                                                                                                                                                                    | None — local DB.                   |

**GAP (known):** these are manual harnesses — `finalize-mint-claim.ts` is now `pnpm test:walk:dev` but NOT yet in CI (`ci.yaml`), and the fork-condition + toks2 rig have no `pnpm test:*` alias. Wiring `test:walk` into a CI lane (needs anvil + temporal + postgres) is the missing repeatable regression gate for tokenomics — same shape as the `env-e2e` gap above. Spec: `docs/spec/tokenomics-distribution.md` (§ "What is proven", § "Local rig vs production").

## What agents can actually run locally

For ~90% of agent sessions, infra-gated lanes are out of reach. Use this split:

**Always available, lightweight (no infra — run freely):**

- `pnpm typecheck`, `pnpm lint` / `biome check <path>`, `pnpm arch:check`, `pnpm check:docs`
- 1–2 specific test files: `pnpm test:app <path/to/file.test.ts>` (operator) or `pnpm test <path>` (root `tests/`, `packages/`, `services/`), `test:meta`, `test:contract`, `test:arch`

**Available but resource-heavy — default to NO, clarify permission first (AGENTS.md, Local execution safety):**

- `pnpm check:fast`, `pnpm check` (full enforcement bundle), the unfiltered `pnpm test` / `test:ci` suite, `pnpm dev` — default to CI for the full sweep; ask for a local run only when the change is complex and CI confidence is low. A heavy run can crash a device that is also running sibling agents.

**Needs Docker running:**

- `pnpm test:component` (spins up testcontainers-postgres per run)
- `pnpm test:external` (testcontainers + external APIs)

**Needs Docker + full stack + secrets — CI does not run these on a PR:**

- `pnpm test:stack:dev` / `:docker` / `:multi` (requires `dev:stack:test` or `docker:test:stack` running, plus `.env.test` populated)
- `pnpm test:external:money` (funded wallet, real $)
- `pnpm e2e` (full docker stack, browser)

**Default agent pattern:** run what you can locally, then push the branch. CI runs the unit, contract and component lanes (plus `test:doltgres-migrate`). CI does not run stack tests on a PR. Stack tests run only by hand. Either ask the human to run `pnpm dev:stack:test` and then run the stack test against it, or dispatch `stack-test.yml`.

## Coverage — the ignored dial

CI collects no coverage. `pnpm test:ci:coverage` writes lcov and a JSON summary to `coverage/`, but no workflow runs it. The Sonar coverage upload was removed from `ci.yaml`. A PR that adds a coverage comment or a coverage-diff gate is a small change, not a new project.

If the user asks "is this covered?" or "what's our coverage look like?", note that `test:ci:coverage` runs the full suite. That is heavy, so get the human's consent first (AGENTS.md, Local execution safety). Then run `pnpm test:ci:coverage` and read the text report or `coverage/lcov.info`.

## Picking the right layer

Use the lightest layer that can prove the assertion — heavier layers cost minutes, not seconds, and a misplaced test burns budget every CI run.

- Pure logic, no I/O → **Unit**.
- Shape of an HTTP request or response → **Contract** (Zod round-trip, no server).
- Adapter ↔ real Postgres/Drizzle behavior → **Component** (testcontainers).
- Full HTTP request going through middleware, auth, services, DB → **Stack (single)**.
- How nodes behave when cross-calling each other → **Stack (multi)**.
- Real GitHub API / Ollama / OpenRouter behavior → **External**.
- Real on-chain transaction or real OpenRouter spend → **External money**.
- Production-like browser-driven black box → **E2E** (only the `smoke` project runs in CI, after operator preview and production deploys).

If the user is about to mock the database, push back — use **Component** with testcontainers instead. Mocked DBs have previously masked broken migrations here; the convention exists for a reason.

## Related but distinct: agent API validation

When the user's question is "does the machine-agent API actually work end-to-end against canary or a local stack?" — that's **validation**, not testing. See `docs/guides/agent-api-validation.md`: a curl-based checklist for discover → register → execute graph → list runs → stream events. It's a human/agent-driven probe, not a CI suite. Point at that guide when the user is validating the agent API surface rather than writing a unit/component/stack test.

## Environment e2e test lane — GitHub App + DoltHub + flight

This is the production-like lane for questions such as "can the operator really birth a node and flight it?" It is not covered by local vitest, stack tests, or Playwright. Treat it as a disposable mini-prod environment driven by the same deploy code.

> The test org mirrors the production tooling. The test operator (`test.cognidao.org`) serves cogni-test-org nodes only and ships them with `POST /api/v1/deploy/workloads`. Keep the test-org tooling in sync with `cogni-dao/cogni`; drift between them breaks the verbs there.

Current test topology:

| Boundary              | Value / rule                                                                                                                                                                           | Source                                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| GitHub App            | `cogni-operator-test` for candidate/test. It must be an env-scoped App, installed on the disposable mint org as **all repositories**, with `workflows:write`.                          | `.claude/skills/git-app-expert/SKILL.md`, `docs/guides/github-app-webhook-setup.md`, `docs/spec/node-ci-cd-contract.md` |
| GitHub mint org       | `cogni-test-org` via `NODE_MINT_OWNER` and `NODE_TEMPLATE_OWNER`. Candidate/preview operators must not mint into `Cogni-DAO`.                                                          | `infra/k8s/overlays/{candidate-a,preview}/operator/kustomization.yaml`                                                  |
| Parent pin repo       | `cogni-test-org/cogni-monorepo` via `NODE_SUBMODULE_PARENT_OWNER` / `NODE_SUBMODULE_PARENT_REPO` for test runs.                                                                        | `infra/k8s/overlays/candidate-a/operator/kustomization.yaml`                                                            |
| DoltHub knowledge org | `cogni-test-nodes` via explicit `DOLTHUB_OWNER`. Production uses `cogni-dao`; non-prod must fail closed rather than silently creating prod knowledge repos.                            | `.claude/skills/database-expert/SKILL.md`, `docs/runbooks/dolthub-remote-bootstrap.md`                                  |
| Control endpoint      | Candidate operator remains `https://test.cognidao.org`. This is where the test App calls operator APIs; it is not a node-workload DNS suffix.                                          | hub `test-fleet-parity-boundary`                                                                                        |
| Deploy target         | Test-org Akash nodes serve at `https://<node>-test.cogni-testing.org` (live: `spawny-boi-test.cogni-testing.org`). Follow the release to `active`, then read `/version.buildSha` once. | hub `test-fleet-parity-boundary`, `nodes/operator/app/src/features/node-deploy/AGENTS.md`                               |
| DNS credential        | The writer token is restricted to the `cogni-testing.org` zone and held by candidate-a OpenBao/ESO, never by `cogni-test-org`.                                                         | hub `test-fleet-parity-boundary`, `.claude/skills/cicd-secrets-expert/SKILL.md`                                         |

Recent PR context to know before changing this lane:

- #1527 added DoltHub knowledge remote bootstrapping and proved `cogni-test-nodes/knowledge-e2e-*` creation through the DoltHub REST/SQL API.
- #1542 made the catalog's `image_repository` authoritative for externally built child node images (`ghcr.io/<owner>/<repo>-node`), removing GHCR inference.
- #1544 hardened publish retries when a child repo already exists from a partial wizard run.

Pareto path for repeatable env e2e:

1. Make the **test org/app contract** explicit and audited first: `cogni-operator-test` installed all-repositories on `cogni-test-org`, `workflows:write`, `administration:write`, webhook to `https://test.cognidao.org/api/internal/webhooks/github`, creds in OpenBao for candidate/test.
2. Keep candidate/test disposable but production-shaped **without copying production identity or credentials**. Workflow/generator behavior should mirror production; owners, Apps, domains, secrets, wallets, and paid-provider accounts remain test-scoped. The test App is wild-west authority only inside the test org.
3. Bind public routing correctly: `NODE_DEPLOY_WORKLOAD_ZONE=cogni-testing.org` for test workloads (the sequencer finds the zone id by name; see `nodes/operator/app/src/features/node-deploy/AGENTS.md`), `FORK_DOMAIN_ROOT=cognidao.org` for the candidate-a shared substrate, and a DNS writer token restricted to `cogni-testing.org` in candidate-a OpenBao. The candidate operator itself remains at `test.cognidao.org`.
4. **Match the current production GHCR contract: deployable child images are public.** Parent CI and Akash providers pull them anonymously; the current SDL renders no registry credentials. [GitHub makes a newly published container package private by default](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry), and the organization `Package Creation · Public` control only permits public packages—it does not change that default. Therefore node birth currently includes an explicit package-visibility flip to public, and the test org mirrors that same operation for every deployable child package. For the first flight, `spawny-boi` being public is sufficient. Private runtime pulls are a future hardening path tracked by `task.5143`, not a prerequisite or description of today's production behavior.
5. Run one synthetic-node smoke path: publish via the operator API, wait for `sha-<childSha>`, call `POST https://test.cognidao.org/api/v1/deploy/workloads` with `env=candidate-a` and that `sourceSha`, follow the release to `active`, read `https://<slug>-test.cogni-testing.org/version` once and assert it reports the old source SHA, then deploy the new SHA under a bounded probe and require zero DNS/TLS/HTTP failures.
6. Only after that exact path is repeatable should preview/prod consume it. Do not call static CI, a merged parent sync, a recorded release, or a 200 from the verb “E2E green”; the public workload must actually serve and update.

### Test-environment parity means behavior, not shared authority

Use this scorecard when someone says the test repo “mirrors production”:

| Must match production                                                                                                                                  | Must be isolated                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| workflow logic, generators, schemas, required gates, operator verbs, the node-deploy sequencer path, image naming, promotion and verification sequence | GitHub App, org/repositories, DNS zone + token, provider/wallet account, DoltHub org, runtime secrets, databases, and destructive authority |

If a test credential can mutate `cognidao.org`, production GitHub repos, production VMs, or a production wallet, the test topology is not isolated. The same holds for a VM shared with a canonical lane: the test fleet's candidate-a control VM is also canonical candidate-a's Postgres and egress host, and each fleet's flight fully replaces that VM's allowlist from its own catalog. Read [`test-fleet-parity-boundary`](https://cognidao.org/knowledge/test-fleet-parity-boundary) and [`lane-is-not-control`](https://cognidao.org/knowledge/lane-is-not-control) before you change test-org deploy lanes or VM reconcilers (bug.5495, task.5270). Do not “seed” production credentials to make it green; fix the missing test substrate or authority boundary.

### How test code reaches the test parent — deliver it directly, never merge-first

The parity table above says _what_ must match; this says _how the code gets there_. Getting these backwards produced a multi-PR detour through `Cogni-DAO/cogni` main during subtask.5007 — slow, and it exercised a forked path instead of the real one. Classify every change into one of two lanes:

| Change                                                                                                                                | Where it's authored                                                    | Delivery path                                                                                                                                                    | Speed                                              |
| ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| **Test-owned** — identity, org/domain/zone config, roster filters, generated appset/overlay state, fixtures, obsolete-fixture removal | Directly in `cogni-test-org/cogni-monorepo` (as `cogni-operator-test`) | Commit straight to the test-parent PR. **Never** route it through a `Cogni-DAO/cogni` main merge.                                                                | Seconds-to-minutes; no canonical dependency        |
| **Shared** — workflow logic, generators, operator verbs, schemas, required gates (destined for production)                            | Originates as a `Cogni-DAO/cogni` PR                                   | Stage the **PR head / exact ref** into the test parent → prove E2E on candidate → **then** merge canonical main → post-merge auto-sync converges the test parent | Bounded by one candidate E2E, not by a merge queue |

**The invariant:** you merge canonical main _because_ you proved the change on candidate — never _in order to_ prove it. Auto-sync (`Cogni-DAO/cogni` → `cogni-test-org/cogni-monorepo`) is a **post-merge convergence** mechanism; it is not a delivery channel for unproven code.

**Anti-pattern that bit subtask.5007** — `canonical main merge → auto-sync → candidate test`. This reverses the candidate-before-merge lifecycle: it puts the irreversible step (main merge) before the proof, and it validates a synced copy rather than the PR head you'll actually ship. Test-only generated state, roster filters, and dead fixtures should have stayed 100% in the test-parent PR.

**Missing platform primitive:** exact-ref/commit staging of a canonical PR head into the test parent. Until it lands, hand-stage the shared PR's head into a test-parent branch (cherry-pick / subtree the exact commit); do **not** merge canonical prerequisites just to make them appear in the test repo. File the gap, don't route around it with a merge.

## Gotchas — these bite repeatedly

1. **`APP_ENV=test` swaps fakes via the DI container.** Fake adapters live in `src/adapters/test/*/fake-*.adapter.ts` and are wired in `src/bootstrap/container.ts` via `serverEnv.isTestMode`. LLM is the exception — it's always real LiteLLM, routed to `mock-openai-api` via `litellm.test.config.yaml`. If a stack/component test is calling a real external service, it's almost always a missing fake wiring in the DI container, not a test bug.

2. **dotenv path-CWD trap.** A vitest config that does `config({ path: ".env.test" })` resolves **relative to CWD**, not the config file. It works when the script runs from repo root. It silently **fails to load** if invoked via `pnpm -F <node> ...` or `turbo run ...` because CWD changes to the node's directory. Symptom: skip-gates think creds are missing, tests blow up at provider construction. Fix pattern:

   ```ts
   const env = config({ path: path.resolve(__dirname, "../../../.env.test") });
   ```

3. **Skip-gate must precede provider construction.** External tests that build Privy/GitHub-App/EVM clients must do so _inside_ `describe.skipIf(!hasCreds)` or a gated `beforeAll`, never at module scope. Module-scope construction throws on missing env → the skip never runs → red test instead of a clean skip. The per-lane rules live in `nodes/operator/app/tests/external/AGENTS.md`.

4. **Testcontainers globalSetup uses `pnpm -w db:migrate:direct`.** The `-w` flag (workspace root) matters. Without it, the migrate script isn't found when globalSetup runs under `pnpm -F <node>`. See `nodes/*/app/tests/component/setup/testcontainers-postgres.global.ts`.

5. **Never mock the database.** In component/stack/external tests, use testcontainers or the real DB. Mocked DBs have concealed production migration bugs here before — the testcontainer overhead is cheap insurance.

6. **Sequence non-parallelism for stateful lanes.** Component + external configs use `sequence: { concurrent: false }` + `pool: forks`, `singleFork: true`. Stateful tests (shared GitHub test repo, single testcontainer DB epoch) race catastrophically in parallel. Don't remove this in a new config.

7. **Check discipline (heavy = default NO — AGENTS.md, Local execution safety).** Default: run `pnpm lint` / `biome check <path>` + `pnpm typecheck` on your touched surface and push; CI runs the full bundle. The aggregate commands are resource-heavy, so run them **only when the human explicitly asks to verify locally this session** — worth asking for when the change is complex and CI confidence is low: `pnpm check:fast:fix` during iteration (auto-fixes format/lint, runs unit tests), `pnpm check:fast` (strict, verify-only — what `.husky/pre-push` runs), and `pnpm check` at most once as the pre-commit gate. `.husky` hooks still fire on the human's own `git push`/`commit`; that is their consent.

8. **Time budgets.** Unit test files <1s. Component 5–30s. Stack 30–90s. External up to 3min (`testTimeout: 30_000` per-test; totals add up). If a test is exceeding these, first suspect missing env (see #2), not genuine slowness.

## When the test is already failing

Triage in this order:

1. **Env loaded?** Check the vitest output header for `[dotenv] injecting env (N)` — if `N=0`, `.env.test` didn't load. See gotcha #2.
2. **Creds asserted before construction?** If the stack trace shows the failure inside a provider constructor, not an assertion, see gotcha #3.
3. **Testcontainer started?** If `db:migrate:direct` errors, see gotcha #4. If migrations ran but DB state is surprising, the globalSetup's test-container epoch may not match expectations — check `testcontainers-postgres.global.ts`.
4. **Shared-state flakiness?** If tests pass solo but fail in the suite, see gotcha #6.
5. **External service reachable?** For external lane: is `pnpm test:smee` running for webhook-dependent tests? Is `OLLAMA_URL` reachable? Is the funded wallet still funded for money tests?
6. **Am I the wrong runner?** If the user is an agent hitting a stack test locally without `dev:stack:test` running, the answer is "ask the human to start it, or dispatch `stack-test.yml`." No CI job runs stack tests on a PR.

## References

- `docs/guides/testing.md` — APP_ENV=test pattern + fake adapter conventions
- `docs/guides/full-stack-testing.md` — stack-test specifics
- `docs/guides/agent-api-validation.md` — machine-agent API validation checklist (validation, not testing)
- `docs/guides/github-app-webhook-setup.md` — per-env GitHub App setup; `cogni-operator-test` is the candidate/test app
- `docs/spec/node-ci-cd-contract.md` — submodule-pinned node CI/CD, test org identity, node-ref flight constraints
- `docs/runbooks/dolthub-remote-bootstrap.md` — `DOLTHUB_OWNER`, DoltHub PAT, and Dolt push credential split
- `work/projects/proj.system-test-architecture.md` — mock-LLM + FakeLlmAdapter strategy
- `nodes/operator/app/tests/external/AGENTS.md` — per-lane invariants for external tests
- `.github/workflows/ci.yaml` — exact CI step list; compare against this matrix if anything above looks wrong
- AGENTS.md, Local execution safety — which checks you may run locally

## Adding a new test — fast recipe

1. Decide layer from the "picking the right layer" list. If unsure, default to the lightest that proves the behavior.
2. Drop the file into that layer's directory with the matching filename pattern (`*.test.ts`, `*.spec.ts`, or `*.int.test.ts` for component).
3. Run the layer's specific command first (`pnpm test:component`, `pnpm test:contract`, etc.), not `pnpm check`. Fastest feedback.
4. If the test needs env or infra, read the relevant config's header TSDoc — every config documents its invariants at the top.
5. If the layer is stack/e2e/money and you're an agent without infra access, do not burn a session on local setup. CI does not run these lanes on a PR. Open the PR, then run the lane by hand (for stack, dispatch `stack-test.yml`) or ask the human to run it.
6. Once the new test passes in isolation (`pnpm test:app <that-file>` for an operator test), lint/typecheck the touched surface and push — CI runs the full bundle. The aggregate `check:fast:fix` → `check:fast` → `check` sequence is resource-heavy and defaults to NO (AGENTS.md, Local execution safety): run it only when the human asks you to verify locally this session — worth asking for when the change is complex and CI confidence is low.

## Driving the TEST operator as an agent (RBAC + credentials)

The **test operator** (`test.cognidao.org`, the `cogni-operator-test` GitHub App) is a **separate principal store** from the **prod operator** (`cognidao.org`). "operator" vs "test operator" is load-bearing — a credential valid on one is NOT valid on the other.

- flock-leader's `COGNI_*_API_KEY` (in `.env.cogni`) authenticates ONLY to the **prod** operator. Verify an agent key with `GET /api/v1/cognition` (200) — NEVER `/users/me` (agent keys always 401 there, which is not proof the key is dead). On `test.cognidao.org` the same key returns **401** (no principal there).
- On the **test** operator, flock-leader's identity is a **wallet session**, not the API key: `~/dev/cogni-template/.local-auth/candidate-a-operator.storageState.json` (Playwright storageState — build a `Cookie:` header from its `cognidao.org` cookies). The `personal-test-users-me.curl` capture **expires** — always confirm a session with `GET /api/v1/users/me` (200) before using it.
- That wallet session authenticates but has **no node grants by default**. Ask for the grant; never assume a key gap.
- `vcs/flight` serves the operator only. For any other node, `refuseNodeOnFlightPromoteLane` returns **409 `node_on_deploy_verb`**. To deploy a test node to candidate-a, request `developer` (`POST https://test.cognidao.org/api/v1/nodes/<id>/access-requests {"role":"developer"}`; `env_manager` also works — bug.5574; the node **owner approves** in the test-operator UI), then call `POST https://test.cognidao.org/api/v1/deploy/workloads`.
- Diagnose by status: **403 `authz_denied`** = authenticated but ungranted → request access; **401** = wrong/absent principal for THIS operator; **400** validation_error = authorized, bad body (400 ≠ 403 — test before claiming a perm gap).
- `GET /nodes` on the test operator returns your owner-scoped registry rows. Do not assume it is empty. `GET /nodes/<slug>` **500s** — use the node UUID.
