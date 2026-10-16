---
name: test-expert
description: Authoritative reference for the cogni-template test pyramid and production-like e2e test topology — enforcement vs test layers, vitest configs, infra prereqs, GitHub/DoltHub test org boundaries, the cogni-operator-test app, what agents can/can't run locally, coverage tracking, and the non-obvious gotchas that bite every time. Use this skill whenever the user is writing a new test, asking "which layer does this belong in", debugging a flaky test, hitting CWD/env-loading issues, deciding between unit/component/stack/external, running any `pnpm test:*` or `pnpm arch:check` / `pnpm lint` command, working with testcontainers, touching fake adapters or `APP_ENV=test`, troubleshooting skip-gates, seeing errors from `.env.test` not loading, wondering about coverage or whether a test will run in CI, or trying to decide whether to run stack/e2e locally vs defer to CI. Also trigger when the user mentions mocking the database, Privy/GitHub App construction errors in tests, the smee proxy, `pnpm test:smee`, validating the agent API, the candidate/test GitHub App, `cogni-test-org`, `cogni-test-nodes`, node-formation flight testing, or anything that smells like test-environment setup. Short-circuits the usual "spelunk through docs + configs" lookup.
---

# test-expert

> The contract lives in the hub, not here. This file is only the trigger.

Fetch and follow the [node test contract](https://cognidao.org/knowledge/node-test-contract) before writing, placing, or debugging a test — it holds the enforcement and test-layer matrices, what agents can run locally, the walk harness, the environment e2e lane, the gotchas, and the new-test recipe:

```bash
# COGNI_NODE_API_KEY is the saved node-agent key from .env.cogni.
curl -fsS --max-time 20 -H "Authorization: Bearer $COGNI_NODE_API_KEY" \
  https://cognidao.org/api/v1/knowledge/node-test-contract | jq -er .content
```

For the production-like test fleet (`cogni-test-org`, `cogni-operator-test`, `cogni-test-nodes`, `cogni-testing.org`), also recall [test-fleet-parity-boundary](https://cognidao.org/knowledge/test-fleet-parity-boundary). Related ids, pending publication: `test-fleet-lane-vms`, `test-fleet-env-wiring`.

## The axioms (hold even if the hub is unreachable)

- **Local command budget.** `pnpm check`, `pnpm check:fast` (and `:fix`), `pnpm dev`, and the unfiltered `pnpm test` / `test:ci` suite require the human's explicit consent this session. Run freely: `pnpm lint` / `biome check <path>`, `pnpm typecheck`, and at most 1–2 specific test files. Default proof is CI + flight (AGENTS.md).
- **Lightest layer that proves the assertion.** Unit for pure logic, contract for request/response shape, component (testcontainers) for adapter ↔ Postgres, stack only for full HTTP through middleware/auth/DB.
- **Never mock the database.** Use component tests with testcontainers; mocked DBs have masked broken migrations here.
- **Test fleet mirrors behavior, never authority.** Same generators, gates, verbs, and promotion path as production; never production Apps, repos, DNS, wallets, or secrets.

If recall fails, report it and retry; do not restore copied prose to this file. Refine the hub entry instead.
