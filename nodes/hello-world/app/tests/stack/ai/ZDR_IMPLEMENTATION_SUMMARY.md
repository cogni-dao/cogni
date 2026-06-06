# OpenRouter ZDR (Zero Data Retention) Implementation

## Phase 1: Enforcement + Config Smoke Test ✅

### Files Changed

| File                                              | Change                                                    |
| ------------------------------------------------- | --------------------------------------------------------- |
| `infra/compose/configs/litellm.config.yaml`       | Added `extra_body.provider.zdr: true` to Anthropic models |
| `infra/compose/runtime/docker-compose.dev.yml`    | Added `LITELLM_LOG=DEBUG` (dev only)                      |
| `tests/stack/ai/zdr-config.stack.test.ts`         | **New** - Config smoke test (runs in CI)                  |
| `tests/stack/ai/zdr-passthrough.dev.test.ts.skip` | **Skipped** - Integration test (needs e2e infra)          |
| `tests/stack/ai/ZDR_INTEGRATION_TEST.md`          | Documentation for deferred integration test               |

### What Was Implemented

#### 1. ZDR Enforcement (Config-Only)

**Models with ZDR enabled** (Claude Sonnet 4.5, Claude Opus 4.5):

```yaml
litellm_params:
  model: openrouter/anthropic/claude-sonnet-4.5
  api_key: "os.environ/OPENROUTER_API_KEY"
  extra_body:
    provider:
      zdr: true # OpenRouter Zero Data Retention flag
```

**What this does**:

- LiteLLM merges `extra_body.provider.zdr: true` into outbound request
- OpenRouter routes request only to ZDR-compliant endpoints
- Provider commits to not logging/training on prompts/completions

**No app code changes** - enforcement is config-only ✅

#### 2. Config Smoke Test

**Test**: `tests/stack/ai/zdr-config.stack.test.ts`

**Runs**: Normal CI/stack tests (`pnpm test:stack:dev`)

**Validates**:

- ✅ ZDR models have `extra_body.provider.zdr === true`
- ✅ Non-ZDR models do NOT have the flag
- ✅ No docker/adapters needed

**Guards against**: Config regressions (someone removes ZDR flag by accident)

#### 3. Debug Logging (Dev Only)

**File**: `docker-compose.dev.yml`

**Added**: `LITELLM_LOG=DEBUG` to litellm service

**Security note**: Only enabled in dev, never prod. Logs may expose prompts.

### What Was Deferred (Phase 2)

#### Integration Test (Awaiting E2E Infrastructure)

**File**: `zdr-passthrough.dev.test.ts.skip`

**What it tests**:

- Full app path: chat endpoint → LiteLLM → logs
- Unique marker + ZDR flag in outbound payload
- Requires real adapters + docker log inspection

**Why skipped**:

- Current `pnpm test:stack:dev` forces `APP_ENV=test` (fake adapters)
- No infrastructure for dev stack integration tests yet
- Manual run possible but not automated

**See**: `ZDR_INTEGRATION_TEST.md` for details

---

## Verification

### Config Test (Automated)

```bash
pnpm test:stack:dev -- tests/stack/ai/zdr-config.stack.test.ts
```

✅ Passes in CI

### Runtime Test (Manual, Optional)

```bash
# 1. Start dev stack with real adapters
pnpm docker:stack

# 2. Rename .skip file
mv tests/stack/ai/zdr-passthrough.dev.test.ts.skip \
   tests/stack/ai/zdr-passthrough.dev.test.ts

# 3. Run manually
RUN_DEV_STACK_TESTS=1 vitest run tests/stack/ai/zdr-passthrough.dev.test.ts
```

---

## How ZDR Works

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌────────────┐
│  Client  │ ──► │   App    │ ──► │ LiteLLM  │ ──► │ OpenRouter │
└──────────┘     └──────────┘     └──────────┘     └────────────┘
                      │                 │
                 Request:          Merged:
                 { model,          { model,
                   messages }        messages,
                                     provider: { zdr: true } }
                                              ▲
                                    From litellm.config.yaml
                                    extra_body.provider.zdr
```

**Enforcement**: Config-only (LiteLLM proxy handles merge)
**Validation**: Config smoke test (guards regressions)
**Future**: Integration test when e2e infra ready

---

## Next Steps (Not Yet Implemented)

**Phase 2: UI Badge** (Optional)

1. Add `is_zdr: true` to `model_info` in config
2. Add `isZdr: boolean` to contract
3. Extract in model catalog
4. Display "Private (ZDR)" badge in ModelPicker (blue text)

**Current decision**: Phase 1 only (enforcement). Badge deferred.
