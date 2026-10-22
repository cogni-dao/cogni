---
name: third-party-integrator
description: >
  3rd party API integration expert for cogni-template nodes. Use this skill whenever a node needs
  to connect to an external API, add a 3rd party service, wrap an SDK, handle webhooks, or design
  an adapter. Routes the decision between MCP, App Capability, and Port/Adapter patterns using a
  structured decision matrix grounded in the repo's hexagonal architecture. Enforces top-0.1%
  standards: Zod-first contracts, typed error hierarchies, pinned API versions, graceful
  degradation, structured observability, and CI isolation via fake adapters. Trigger this skill
  at the start of any integration work — before writing any client code — including when someone
  says "add Stripe", "integrate GitHub", "connect to a webhook", "wrap this API", or "which
  pattern should I use for this 3rd party service".
---

# Third-Party Integrator

You are integrating a 3rd party API into a cogni-template node. Before writing any code, route to the right architectural pattern using the decision matrix below. The matrix is calibrated to the repo's existing patterns — follow it, don't improvise.

---

## Step 1: Route with the Decision Matrix

Answer the signals that apply. The first strong match wins.

| Signal                                                             | → Pattern                                     |
| ------------------------------------------------------------------ | --------------------------------------------- |
| AI agent graphs need to call this as a tool                        | → **App Capability**                          |
| 3rd party vendor ships their own MCP server                        | → **MCP** (consume it, no adapter code)       |
| You're exposing your system to external AI clients                 | → **MCP** (build it)                          |
| Core business logic depends on this (billing, auth, LLM, payments) | → **Port/Adapter**                            |
| CI must run without hitting the real service                       | → **Port/Adapter** (needs fake adapter)       |
| Multiple providers, same interface (e.g. Polymarket + Kalshi)      | → **App Capability** (aggregation)            |
| Service is optional — system works without it                      | → **App Capability** or optional Port/Adapter |
| Service is required — system fails without it                      | → **Port/Adapter**                            |
| Single callsite, no test isolation needed, trivial surface         | → Thin client (no port)                       |

### When signals conflict

- **Business logic + agent tool** → Port/Adapter first, wrap as Capability. See `vcs.ts` wrapping `GithubVcsAdapter`.
- **Optional + CI isolation** → Port/Adapter with optional wiring (`APP_ENV=test` → fake, else `undefined`-safe).
- **MCP vs Capability** → Capabilities are graph-internal tools; MCP serves external clients. If only your agent graphs call it, Capability wins.

---

## Pattern A: Port/Adapter

Use when: production dependency, test isolation required, hexagonal boundary enforcement.

### Canonical examples in repo

| Service                      | File                                                           |
| ---------------------------- | -------------------------------------------------------------- |
| LiteLLM (LLM)                | `adapters/server/ai/litellm.adapter.ts`                        |
| Langfuse (tracing, optional) | `adapters/server/ai/langfuse.adapter.ts`                       |
| EVM RPC (payments)           | `adapters/server/payments/evm-rpc-onchain-verifier.adapter.ts` |
| Temporal (scheduling)        | `adapters/server/temporal/schedule-control.adapter.ts`         |

### File layout

```
src/
  ports/<domain>.port.ts
  adapters/server/<domain>/
    <service>.adapter.ts          ← implements the port
    <service>.client.ts           ← optional: raw HTTP/SDK client (no port knowledge)
  adapters/test/
    <domain>.fake.ts              ← deterministic fake for CI
  bootstrap/container.ts          ← wire adapter; select test vs prod via APP_ENV
  shared/env/server-env.ts        ← Zod-validated env vars
```

### Port design

```typescript
// src/ports/payments.port.ts

// 1. Pure interface — zero business logic, no adapter imports
export interface PaymentService {
  createIntent(params: CreateIntentParams): Promise<PaymentIntentResult>;
}

// 2. Typed port errors — adapters throw these, features catch them
export class PaymentFailedPortError extends Error {
  constructor(
    public readonly code: PaymentErrorCode,
    message: string
  ) {
    super(message);
    this.name = "PaymentFailedPortError";
  }
}

export type PaymentErrorCode =
  | "INSUFFICIENT_FUNDS"
  | "CARD_DECLINED"
  | "RATE_LIMITED"
  | "PROVIDER_ERROR"
  | "NETWORK_ERROR";

// 3. Type guard — lets feature code match errors without instanceof chains
export function isPaymentFailedPortError(
  e: unknown
): e is PaymentFailedPortError {
  return e instanceof PaymentFailedPortError;
}

// 4. Document invariants — what the port guarantees, not how it works
/**
 * @invariant IDEMPOTENT — same idempotencyKey never double-charges
 * @invariant NO_SECRETS_LEAKED — credentials never appear in returned types
 */
```

### Adapter implementation

```typescript
// src/adapters/server/payments/stripe.adapter.ts

export class StripeAdapter implements PaymentService {
  constructor(
    private readonly client: Stripe,
    private readonly log: Logger
  ) {}

  async createIntent(params: CreateIntentParams): Promise<PaymentIntentResult> {
    const start = Date.now();
    this.log.info({
      event: "stripe.createIntent.start",
      idempotencyKey: params.idempotencyKey,
    });

    try {
      const intent = await this.client.paymentIntents.create({
        amount: params.amountCents,
        currency: params.currency,
        idempotency_key: params.idempotencyKey,
      });
      this.log.info({
        event: "stripe.createIntent.ok",
        intentId: intent.id,
        durationMs: Date.now() - start,
      });
      return {
        id: intent.id,
        status: "pending",
        clientSecret: intent.client_secret,
      };
    } catch (e) {
      // Translate all SDK errors to port errors — never let SDK exceptions escape
      const code =
        e instanceof Stripe.errors.StripeCardError
          ? "CARD_DECLINED"
          : "PROVIDER_ERROR";
      this.log.error({
        event: "stripe.createIntent.error",
        code,
        durationMs: Date.now() - start,
      });
      throw new PaymentFailedPortError(
        code,
        e instanceof Error ? e.message : "unknown"
      );
    }
  }
}
```

**Non-negotiable adapter rules:**

1. **Translate all errors** — 3rd party SDK exceptions never cross the port boundary
2. **Log at boundary** — one structured event per outbound call: start, ok/error, durationMs
3. **No business logic** — adapters map shapes and handle errors only
4. **Client injected via constructor** — never instantiated inside the adapter
5. **Pin the API version** — never rely on SDK defaults
6. **Set timeouts** — every outbound call needs a timeout (`AbortSignal.timeout(ms)` or SDK-level config); default Node `fetch` is unbounded
7. **Parse every response** — route all 3rd party response bodies through Zod `.safeParse()` before returning; see API Discovery §4

### Fake adapter for CI

```typescript
// src/adapters/test/payments.fake.ts

export class FakePaymentService implements PaymentService {
  readonly intents: CreateIntentParams[] = []; // inspectable in tests

  async createIntent(params: CreateIntentParams): Promise<PaymentIntentResult> {
    this.intents.push(params);
    return {
      id: `fake-${params.idempotencyKey}`,
      status: "pending",
      clientSecret: "fake",
    };
  }
}
```

Fakes are deterministic. They record calls. No randomness unless testing retry/failure paths.

### Container wiring

```typescript
// src/bootstrap/container.ts

// Required
paymentService: new StripeAdapter(new Stripe(serverEnv.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" }), log),

// Optional — wire undefined if creds missing; features must null-check
langfuse: serverEnv.LANGFUSE_SECRET_KEY
  ? new LangfuseAdapter({ secretKey: serverEnv.LANGFUSE_SECRET_KEY })
  : undefined,

// Test vs prod selection
onChainVerifier:
  serverEnv.APP_ENV === "test"
    ? new FakeOnChainVerifier()
    : new EvmRpcOnChainVerifierAdapter(evmClient),
```

### Env var pattern

```typescript
// src/shared/env/server-env.ts
STRIPE_SECRET_KEY: z.string().min(1),                    // required
STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),     // optional feature gate
STRIPE_API_VERSION: z.string().default("2024-06-20"),    // explicit version pin
```

---

## Pattern B: App Capability

Use when: AI graph tools need access to an external service, especially optional or aggregated providers.

### Canonical examples in repo

| Service                          | File                                   |
| -------------------------------- | -------------------------------------- |
| Polymarket + Kalshi (aggregated) | `bootstrap/capabilities/market.ts`     |
| GitHub VCS                       | `bootstrap/capabilities/vcs.ts`        |
| Web search                       | `bootstrap/capabilities/web-search.ts` |
| Prometheus metrics               | `bootstrap/capabilities/metrics.ts`    |

### Capability factory pattern

```typescript
// src/bootstrap/capabilities/market.ts

export function createMarketCapability(env?: {
  KALSHI_API_KEY?: string;
  KALSHI_API_SECRET?: string;
}): MarketCapability {
  const providers: MarketProviderPort[] = [];

  // Always-on provider (public API, no creds required)
  providers.push(new PolymarketAdapter());

  // Credential-gated provider — degrades gracefully if missing
  if (env?.KALSHI_API_KEY && env?.KALSHI_API_SECRET) {
    providers.push(
      new KalshiAdapter({
        apiKey: env.KALSHI_API_KEY,
        apiSecret: env.KALSHI_API_SECRET,
      })
    );
  }

  return {
    async listMarkets(params) {
      // Partial failure is better than total failure
      const results = await Promise.allSettled(
        providers.map((p) => p.listMarkets(params))
      );
      return results
        .filter(
          (r): r is PromiseFulfilledResult<Market[]> => r.status === "fulfilled"
        )
        .flatMap((r) => r.value);
    },
  };
}
```

**Rules:**

1. **`Promise.allSettled` for aggregation** — partial results beat no results
2. **Credentials stay out of tool args** — resolved at bootstrap, never passed through tool calls
3. **Factory pattern** — capability is created once at bootstrap, not per-request
4. **Graceful degradation** — capability works with zero optional providers

---

## Pattern C: MCP

### Consuming a 3rd party MCP server

When the vendor ships their own MCP server (Grafana, Linear, GitHub, Stripe):

1. Add to Claude Code `settings.json` under `mcpServers` with env var config
2. Document in `docs/guides/<service>-mcp-setup.md`
3. Access via `mcp__<server>__<tool>` naming convention
4. No adapter code required

### Building an MCP server (exposing tools to external AI clients)

MCP is a delivery layer — same rules as `app`. Dep-cruiser enforces:

```
mcp → mcp, features, ports, contracts, bootstrap   ✓
mcp → core, adapters, app                          ✗
```

```typescript
// src/mcp/tools/payments.ts

server.tool(
  "payments__create_intent",
  createIntentContract.input.shape, // Zod from contracts — never re-declare
  async (args) => {
    const input = createIntentContract.input.parse(args); // validate at boundary
    const result = await feature.createPaymentIntent(input);
    return createIntentContract.output.parse(result); // validate output too
  }
);
```

---

## API Discovery Protocol

Before writing any code, establish exactly what you're wrapping.

### 1. Find the canonical source (in priority order)

1. **Official typed SDK** — check npm for `@<vendor>/sdk`. Prefer SDK over raw HTTP.
2. **OpenAPI/Swagger spec** — generate types: `pnpm dlx openapi-typescript <url> -o src/types/<vendor>.d.ts`
3. **REST docs** — hand-write Zod schemas against the documented shapes

### 2. Map the contract surface before implementing

| Dimension            | What to capture                           |
| -------------------- | ----------------------------------------- |
| Auth                 | API key / OAuth2 / App JWT / HMAC webhook |
| Rate limits          | Burst + sustained + per-endpoint          |
| Pagination           | Cursor / offset / page-based              |
| Webhook verification | HMAC-SHA256 is standard                   |
| API versioning       | Exact version string to pin               |
| Error codes          | Enumerate 4xx/5xx semantics               |

### 3. Write the Zod contract first

```typescript
// src/contracts/http/<domain>.contract.ts
// MAY ONLY IMPORT: z, other contracts, shared types

export const createIntentInput = z.object({
  amountCents: z.number().int().positive(),
  currency: z.enum(["usd", "eur"]),
  idempotencyKey: z.string().uuid(),
});

export const createIntentOutput = z.object({
  id: z.string(),
  status: z.enum(["pending", "succeeded", "failed"]),
  clientSecret: z.string().nullable(),
});

export type CreateIntentInput = z.infer<typeof createIntentInput>;
export type CreateIntentOutput = z.infer<typeof createIntentOutput>;
```

Contract → Port → Adapter → Container. Always in that order.

### 4. Validate inbound responses at the adapter boundary (stable context envelopes)

The contract Zod schemas serve double duty: they describe your outbound shapes **and** they must parse every 3rd party response body. Never spread a raw SDK type directly into your return value — always route it through Zod.

```typescript
// adapter receives raw SDK response
const raw = await this.client.someEndpoint(params);

// Parse through Zod at the adapter boundary before anything else uses the data
const parsed = myResponseSchema.safeParse(raw);
if (!parsed.success) {
  this.log.error({
    event: "vendor.someEndpoint.parse_error",
    issues: parsed.error.issues,
  });
  throw new VendorPortError(
    "VALIDATION_FAILED",
    "Unexpected response shape from vendor"
  );
}

return parsed.data;
```

This is what "stable context envelope" means in practice: **the shape the rest of your system sees never silently mutates when the vendor updates their API**. A breaking vendor change becomes an explicit `VALIDATION_FAILED` error with a structured log, not a `TypeError: cannot read property X of undefined` two layers deep.

---

## Authentication Patterns

### API key (simplest)

```typescript
constructor(private readonly apiKey: string) {}
private headers = () => ({ Authorization: `Bearer ${this.apiKey}` });
```

### OAuth2 client credentials (M2M)

```typescript
private cached?: { value: string; expiresAt: number };
private refreshPromise?: Promise<string>;  // prevent concurrent refreshes

private async getToken(): Promise<string> {
  if (this.cached && Date.now() < this.cached.expiresAt - 30_000) return this.cached.value;
  // Coalesce concurrent refresh requests — only one fetch in flight at a time
  this.refreshPromise ??= this.fetchToken().finally(() => { this.refreshPromise = undefined; });
  return this.refreshPromise;
}

private async fetchToken(): Promise<string> {
  const res = await fetch(`${this.baseUrl}/oauth/token`, {
    method: "POST",
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: this.clientId, client_secret: this.clientSecret }),
    signal: AbortSignal.timeout(10_000),  // never hang forever
  });
  if (!res.ok) throw new MyServicePortError("AUTH_FAILED", `Token fetch failed: ${res.status}`);
  const data = tokenSchema.parse(await res.json());  // parse response — don't trust shape
  this.cached = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return this.cached.value;
}
```

### GitHub App (JWT + installation token)

Use the existing `GithubVcsAdapter` pattern with `@octokit/auth-app`. Octokit handles token refresh automatically — don't roll your own.

### Webhook HMAC verification

```typescript
import { createHmac, timingSafeEqual } from "crypto";

export function verifyWebhookSignature(
  payload: Buffer,
  signature: string,
  secret: string
): boolean {
  const expected = Buffer.from(
    `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`
  );
  const actual = Buffer.from(signature);
  // timingSafeEqual throws RangeError if lengths differ — check first
  if (payload.length === 0 || expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
```

---

## Error Handling

### Three-layer translation model

```
3rd party error (SDK exception, HTTP status)
  → adapter catches → PortError (typed, domain-relevant)
    → feature catches → DomainError or propagates
      → route/MCP catches → HTTP status / MCP error response
```

### Error taxonomy at the port

```typescript
export type IntegrationErrorCode =
  | "RATE_LIMITED" // 429 — back off, retry eligible
  | "AUTH_FAILED" // 401/403 — credentials invalid, do NOT retry
  | "NOT_FOUND" // 404 — resource missing
  | "VALIDATION_FAILED" // 400/422 — our request malformed, do NOT retry
  | "PROVIDER_ERROR" // 5xx — their fault, retry eligible
  | "NETWORK_ERROR"; // timeout/connection reset, retry eligible
```

Only `RATE_LIMITED`, `PROVIDER_ERROR`, `NETWORK_ERROR` are retry-eligible. Never retry auth or validation failures.

---

## Observability

Every adapter boundary must emit structured events. No exceptions.

```typescript
// Log pattern: <service>.<method>.<outcome>
this.log.info({
  event: "stripe.createIntent.start",
  idempotencyKey: params.idempotencyKey,
});

// On success
this.log.info({
  event: "stripe.createIntent.ok",
  intentId: result.id,
  durationMs: Date.now() - start,
});

// On error
this.log.error({
  event: "stripe.createIntent.error",
  code: portError.code,
  durationMs: Date.now() - start,
});
```

**Log field rules:**

- `event` field: `<service>.<method>.<start|ok|error>` (dotted, snake_case)
- `durationMs`: always capture outbound call latency
- No secrets, PII, or raw response bodies

---

## Implementation Checklist

Complete before opening a PR:

- [ ] Decision matrix consulted — correct pattern chosen
- [ ] Zod contract defined in `src/contracts/` (if HTTP boundary crosses app)
- [ ] Port interface defined (Port/Adapter pattern)
- [ ] Fake adapter written (Port/Adapter pattern)
- [ ] All 3rd party errors translated at adapter boundary — no SDK exceptions escape
- [ ] Every inbound response parsed through Zod `.safeParse()` before use (stable context envelope)
- [ ] HTTP timeouts set on every outbound call (`AbortSignal.timeout` or SDK-level config)
- [ ] API version pinned explicitly (not SDK default)
- [ ] Webhook signatures verified via `timingSafeEqual` with length pre-check (if webhook surface)
- [ ] Env vars added to `server-env.ts` with Zod validation + default/optional correct
- [ ] Optional adapter wired as `undefined`-safe in container
- [ ] Structured log emitted at every outbound call (start, ok, error + durationMs)
- [ ] `pnpm check:fast` green in CI (ask the human before running it locally)
