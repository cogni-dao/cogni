---
id: check-full-spec
type: spec
title: "check:full - CI-Parity Test Gate"
status: active
spec_state: draft
trust: draft
summary: Local convenience wrapper that runs the exact same test suite CI runs, with full infrastructure.
read_when: Running or debugging the full CI-parity test gate locally.
owner: derekg1729
created: 2026-02-06
verified: 2026-02-06
tags: [deployment]
---

# check:full - CI-Parity Test Gate

## Context

Local convenience wrapper that runs the exact same test suite CI runs, with full infrastructure. Solves the "works locally, fails in CI" problem by providing deterministic, reproducible test execution.

## Goal

Provide a single command (`pnpm check:full`) that mirrors CI behavior locally — same test order, same infrastructure, deterministic env — so developers can catch CI failures before pushing.

## Non-Goals

- Replacing CI workflows (CI continues to use granular steps for caching, parallelism, and rerun control)
- e2e tests (those are separate via `check:ci`, which may be deprecated)

## Core Invariants

1. **CI_PARITY**: `check:full` runs the same commands in the same order as CI. No divergence between local and CI behavior.

2. **DETERMINISTIC_ENV**: Uses `.env.test`, never reads `.env.local`.

3. **GUARANTEED_TEARDOWN**: Trap-based cleanup on `EXIT INT TERM` ensures teardown even on Ctrl-C.

4. **PORT_CONFLICT_DETECTION**: Fails fast if required ports (55432, 4000) are already in use.

## Design

### Usage

```bash
# Full run (rebuild Docker images)
pnpm check:full

# Fast run (reuse existing images)
pnpm check:full:fast
```

### Execution Sequence

```
1. Pre-flight checks (port 55432, 4000)
2. docker:test:stack (--build or :fast)
3. docker:test:stack:setup (provision + migrate)
4. pnpm test:unit
5. pnpm test:component
6. pnpm test:contract
7. pnpm test:stack:docker
8. docker:test:stack:down (always via trap)
```

### Key Features

- **Trap-based cleanup**: `EXIT INT TERM` ensures teardown even on Ctrl-C
- **Port conflict detection**: Fails fast if ports already in use
- **Deterministic env**: Uses `.env.test`, never reads `.env.local`
- **Same commands as CI**: No divergence between local and CI behavior

### Architecture

```
scripts/check-full.sh        # Orchestrator
├── Pre-flight checks
├── Stack lifecycle management
├── Sequential test execution (same order as CI)
└── Guaranteed teardown (trap)

package.json
├── check:full               # Full build + all tests
├── check:full:fast          # Skip Docker rebuild
├── test:contract            # Contract tests
├── docker:test:stack:down   # Teardown command
└── (reuses existing test:* commands)
```

### Comparison with `check`

| Command      | Time  | Infrastructure | Purpose                                 |
| ------------ | ----- | -------------- | --------------------------------------- |
| `check`      | ~30s  | None           | Fast feedback (lint+type+unit)          |
| `check:full` | ~2min | Full stack     | CI-parity gate (all tests)              |
| `check:ci`   | ~3min | Full stack     | CI + e2e (legacy, consider deprecating) |

### Troubleshooting

#### Port already in use

```bash
# Teardown any running test stack
pnpm docker:test:stack:down

# Or force remove all containers
docker compose -f infra/compose/runtime/docker-compose.dev.yml down -v
```

#### Tests fail but CI passes

- Verify you're on latest main: `git pull origin main`
- Verify `.env.test` matches `.env.test.example`
- Try full rebuild: `pnpm check:full` (not `:fast`)

#### Tests pass but CI fails

- Check if you have uncommitted changes
- Verify all dependencies in `package.json` are committed
- Check if `.env.test` in your branch differs from main

### File Pointers

| File                                           | Purpose                       |
| ---------------------------------------------- | ----------------------------- |
| `scripts/check-full.sh`                        | Orchestrator script           |
| `vitest.config.mts`                            | Unit test config              |
| `vitest.integration.config.mts`                | Integration test config       |
| `vitest.stack.config.mts`                      | Stack test config             |
| `infra/compose/runtime/docker-compose.dev.yml` | Docker compose for test stack |
| `.env.test`                                    | Deterministic test env        |

## Acceptance Checks

**Automated:**

- `pnpm check:full` — runs full CI-parity test suite locally

**Manual:**

1. Verify Ctrl-C during `check:full` triggers teardown (containers removed)
2. Verify running with ports in use fails fast with clear error

## Open Questions

_(none — future CLI enhancements like --only-stack, --watch, --verbose are tracked in proj.cicd-services-gitops.md)_

## Related

- [CI/CD](https://cognidao.org/knowledge/operator-pipeline-contract)
- [Build Architecture](https://node-template.cognidao.org/knowledge/package-build-contract)
