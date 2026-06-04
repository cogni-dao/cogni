# tests/\_fakes · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** stable

## Purpose

Deterministic test doubles for unit tests with no I/O dependencies.

## Pointers

- [Unit tests](../unit/)
- [Ports source](../../src/ports/)

## Boundaries

```json
{
  "layer": "tests",
  "may_import": ["ports"],
  "must_not_import": [
    "adapters/server",
    "adapters/worker",
    "features",
    "core",
    "app"
  ]
}
```

## Public Surface

- **Exports:**
  - FakeClock (controllable time for deterministic tests)
  - FakeRng (controllable randomness)
  - FakeTelemetry (no-op telemetry)
  - FakeLlmService (deterministic LLM responses for unit tests)
  - MockAccountService (account/credits test doubles)
  - MockServiceAccountService, MockTreasurySettlement, MockFinancialLedger, MockProviderFunding (payment port test doubles)
  - Test identity fixtures (TEST_USER_ID_1–5, TEST_SESSION_USER_1–5, TEST_WALLET_1–5, testUser(), newTestUserId(), newTestSessionUser())
  - Payment builders (createPaymentAttempt, createIntentAttempt, createPendingAttempt, createCreditedAttempt, createRejectedAttempt, createFailedAttempt, createExpiredIntent, createTimedOutPending)
  - makeTestCtx (RequestContext factory for facade/service tests)
  - Tool test helpers (createTestBoundToolRuntime, createTestToolSource, createEventCollector)
  - Graph executor fakes (createImmediateGraphExecutor, createDelayedReturnGraphExecutor)
  - Request builders (createCompletionRequest, createChatRequest)
  - UsageFact builders (buildInprocUsageFact, buildSandboxUsageFact, buildExternalUsageFact)
  - TEST_GRAPH_NAME constant ("langgraph:poet")
- **Files considered API:** index.ts, ids.ts, payments/fakes.ts, payments/mock-services.ts, ai/fakes.ts, ai/tool-builders.ts, ai/graph-executor-fakes.ts, ai/request-builders.ts, ai/usage-fact-builders.ts, test-context.ts

## Responsibilities

- This directory **does:** provide controllable, deterministic test doubles for ports
- This directory **does not:** perform real I/O or connect to external services

## Usage

```bash
# Import in unit tests
import { FakeClock, FakeRng, FakeTelemetry, makeTestCtx } from "@tests/_fakes"
import { createMockAccountServiceWithDefaults } from "@tests/_fakes"
import { createPaymentAttempt, createIntentAttempt } from "@tests/_fakes"
```

## Standards

- No I/O, no time, no RNG - all controllable
- Minimal and deterministic behavior only

## Change Protocol

- Update this file when **Exports**, **Routes**, or **Env/Config** change
- Bump **Last reviewed** date
- Update ESLint boundary rules if **Boundaries** changed

## Notes

- Keep fakes minimal and deterministic only
- Payment builders provide 8 specialized functions for all PaymentAttempt states
- FakeClock used in payment tests for time-based logic (expiration, timeouts)
- Request builders include graphName by default (required since P0.75); use these instead of manual JSON.stringify
- UsageFact builders produce schema-valid facts for strict (inproc/sandbox) and hints (external) schemas
