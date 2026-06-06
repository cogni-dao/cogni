# ZDR Integration Test (Pending Infrastructure)

## Status: SKIPPED - Awaiting End-to-End Test Infrastructure

The file `zdr-passthrough.dev.test.ts.skip` contains a **runtime integration test** that verifies ZDR flag passthrough through the full app path.

## Why It's Skipped

This test requires:

- **Real adapters** (`APP_ENV !== 'test'`)
- **LiteLLM container running** with debug logging
- **Docker log inspection** of outbound LiteLLM payloads

Our current test infrastructure (`pnpm test:stack:dev`) forces `APP_ENV=test` and uses fake adapters, making this test incompatible.

## What It Tests

1. Sends chat request through app route with ZDR-enabled model (`claude-sonnet-4.5`)
2. Asserts unique marker appears in LiteLLM container logs
3. Asserts `"provider": { "zdr": true }` appears near marker in logs

## How to Run (Manual, When Infrastructure Ready)

```bash
# 1. Start dev stack with real adapters
pnpm docker:stack

# 2. Rename .skip file to .test.ts
mv tests/stack/ai/zdr-passthrough.dev.test.ts.skip \
   tests/stack/ai/zdr-passthrough.dev.test.ts

# 3. Run with dev stack integration env
RUN_DEV_STACK_TESTS=1 vitest run tests/stack/ai/zdr-passthrough.dev.test.ts
```

## Future Work

When we build end-to-end test infrastructure:

- Create `tests/dev-stack/` folder for dev stack integration tests
- Move `zdr-passthrough.dev.test.ts` there
- Add `pnpm test:dev-stack` command that runs with real adapters
- Gate with `RUN_DEV_STACK_TESTS=1` or similar

## Current Coverage

For now, **ZDR enforcement is validated via config smoke test**:

- `tests/stack/ai/zdr-config.stack.test.ts` - Parses YAML, asserts ZDR flag presence
- Runs in normal `pnpm test:stack:dev` (no docker needed)
- Guards against config regressions

The integration test proves wire behavior but is deferred until we have proper e2e infrastructure.
