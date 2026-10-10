// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/authorization-core/adapters/openfga-authorization`
 * Purpose: AuthorizationPort implementation backed by OpenFGA check calls.
 * Scope: Maps Cogni authz actions to OpenFGA relations and performs direct or actor/subject dual checks. Resolves a stable store name to OpenFGA's generated store id when configured. Does not read env vars.
 * Invariants: AUTHZ_FAIL_CLOSED_WITH_DISTINCTION; OpenFGA is the sole permission/delegation source; no local role policy.
 * Side-effects: IO (OpenFGA SDK check calls)
 * Links: docs/spec/rbac.md, https://openfga.dev/docs/getting-started/setup-sdk-client
 * @public
 */

import {
  ConsistencyPreference,
  CredentialsMethod,
  OpenFgaClient,
} from "@openfga/sdk";

import {
  AUTHZ_GRANT_NOT_EXPIRED_CONDITION,
  type AuthorizationPort,
  type AuthzCheckParams,
  type AuthzCheckOptions,
  type AuthzDecision,
  type AuthzMutationOptions,
  type AuthzRelationTuple,
  type AuthzSubcheck,
  type AuthzWriteDecision,
  authzUserResource,
  relationForAuthzAction,
} from "../index";

export interface OpenFgaCheckRequest {
  readonly user: string;
  readonly relation: string;
  readonly object: string;
  readonly context?: Readonly<Record<string, unknown>>;
}

export interface OpenFgaCheckOptions {
  readonly consistency?: ConsistencyPreference;
}

export interface OpenFgaCheckResponse {
  readonly allowed?: boolean;
}

export interface OpenFgaCheckClient {
  check(
    request: OpenFgaCheckRequest,
    options?: OpenFgaCheckOptions
  ): Promise<OpenFgaCheckResponse>;
}

export interface OpenFgaWriteClient extends OpenFgaCheckClient {
  write?(
    body: {
      readonly writes?: AuthzRelationTuple[];
      readonly deletes?: Array<
        Pick<AuthzRelationTuple, "user" | "relation" | "object">
      >;
    },
    options?: {
      readonly conflict?: {
        readonly onDuplicateWrites?: "error" | "ignore";
        readonly onMissingDeletes?: "error" | "ignore";
      };
    }
  ): Promise<unknown>;
  writeTuples(
    tuples: AuthzRelationTuple[],
    options?: {
      readonly conflict?: {
        readonly onDuplicateWrites?: "error" | "ignore";
      };
    }
  ): Promise<unknown>;
  deleteTuples(
    tuples: Array<Pick<AuthzRelationTuple, "user" | "relation" | "object">>,
    options?: {
      readonly conflict?: {
        readonly onMissingDeletes?: "error" | "ignore";
      };
    }
  ): Promise<unknown>;
}

export interface OpenFgaStore {
  readonly id: string;
  readonly name: string;
}

export interface OpenFgaStoreClient extends OpenFgaCheckClient {
  listStores(options?: {
    readonly name?: string;
    readonly pageSize?: number;
    readonly continuationToken?: string;
  }): Promise<{ readonly stores?: readonly OpenFgaStore[] }>;
  createStore(request: {
    readonly name: string;
  }): Promise<{ readonly id: string }>;
}

export interface OpenFgaAuthorizationAdapterConfig {
  readonly apiUrl: string;
  readonly storeId?: string;
  readonly storeName?: string;
  readonly authorizationModelId?: string;
  readonly apiToken?: string;
  readonly timeoutMs?: number;
  /**
   * Per-attempt deadline for write/delete, ms (default 5000). Deliberately separate
   * from `timeoutMs`: checks are hot-path and must fail fast, writes are cold-path
   * and must not fail a human's one-and-only click.
   */
  readonly writeTimeoutMs?: number;
  /**
   * Retries for write/delete on a DEFINITIVELY-TERMINATED transient failure (default 2).
   * A timeout (our own abandon-not-cancel deadline) is never retried — it would race the
   * in-flight write and manufacture a 409 (bug.5082).
   */
  readonly writeMaxRetries?: number;
  /** Fixed backoff between write retries, ms (default 100 — matches OpenFGA SDK). */
  readonly writeRetryBackoffMs?: number;
  /** Trusted server clock used for conditional grant evaluation. */
  readonly now?: () => Date;
  readonly client?: OpenFgaCheckClient;
  readonly storeClient?: OpenFgaStoreClient;
}

interface PlannedSubcheck {
  readonly name: "permission" | "delegation";
  readonly user: string;
  readonly relation: string;
  readonly object: string;
  readonly context?: Readonly<Record<string, unknown>>;
}

const DEFAULT_TIMEOUT_MS = 1_500;
// Writes get a LONGER per-attempt deadline than checks. 1500ms is tuned for the
// hot-path check, which runs on nearly every request against a warm connection. A
// write is the opposite: rare, so it routinely pays cold-connection cost (new pool
// entry + a Postgres round trip on OpenFGA's datastore), and retrying under the same
// 1500ms budget just fails three times for the same reason it failed once. Observed
// 2026-08-27 on production: approving a developer on a freshly spawned node returned
// `authz_write_unavailable` after all three attempts crossed 1500ms; the identical
// click succeeded seconds later on a warm connection. Same cold/warm split as the
// identity broker in bug.5063.
// Generous single-attempt deadline. A cold write pays connection-establish + a Postgres
// round trip on OpenFGA's datastore (observed p99 5–10s on the cross-VM Compose hop); the
// deadline must cover ONE cold attempt because a timed-out write is NOT retried (see below).
// Prefer raising this / warming the connection over retrying — retry across our own timeout
// races an un-cancelled in-flight write (bug.5082).
const DEFAULT_WRITE_TIMEOUT_MS = 8_000;
// Writes (approve/deny/revoke) retry a DEFINITIVELY-TERMINATED failure — a thrown transport
// error (ECONNRESET/refused), a returned 5xx/429, or a returned HTTP 409 (OpenFGA's datastore
// serialization conflict from two concurrent writes touching the same tuple) — where the prior
// attempt is provably done and a retry cannot race it. The self-inflicted 409 the incident
// produced (bug.5082, prod 2026-09-01) now heals on the clean retry: the racing writer has
// committed, so `onDuplicateWrites: ignore` no-ops the retry to a 200. Retry recovers the
// end-state; it never ASSUMES it (a 409 does not prove THIS op's intent won — assuming success
// on a delete would fail OPEN on a revoke). Our own `withTimeout` firing is the ONE non-retryable
// failure: `withTimeout` is a `Promise.race` that abandons — never cancels — the underlying
// request, so retrying it is what issues the concurrent duplicate that MADE the 409. Checks stay
// fail-closed-fast (no retry). Default 2 retries ≈ OpenFGA SDK's 3-attempt policy; 100ms backoff.
const DEFAULT_WRITE_MAX_RETRIES = 2;
const DEFAULT_WRITE_RETRY_BACKOFF_MS = 100;

function openFgaClientConfig(
  config: OpenFgaAuthorizationAdapterConfig,
  storeId?: string
): ConstructorParameters<typeof OpenFgaClient>[0] {
  return {
    apiUrl: config.apiUrl,
    ...(storeId !== undefined ? { storeId } : {}),
    ...(config.apiToken !== undefined
      ? {
          credentials: {
            method: CredentialsMethod.ApiToken,
            config: { token: config.apiToken },
          },
        }
      : {}),
    ...(config.authorizationModelId !== undefined
      ? { authorizationModelId: config.authorizationModelId }
      : {}),
  };
}

class StoreNameResolvingOpenFgaClient implements OpenFgaWriteClient {
  private resolvedClient: Promise<OpenFgaCheckClient> | undefined;

  constructor(
    private readonly config: OpenFgaAuthorizationAdapterConfig,
    private readonly storeName: string
  ) {}

  async check(
    request: OpenFgaCheckRequest,
    options?: OpenFgaCheckOptions
  ): Promise<OpenFgaCheckResponse> {
    const client = await this.resolveClient();
    return client.check(request, options);
  }

  async writeTuples(
    tuples: AuthzRelationTuple[],
    options?: {
      readonly conflict?: {
        readonly onDuplicateWrites?: "error" | "ignore";
      };
    }
  ): Promise<unknown> {
    const client = await this.resolveClient();
    if (!isOpenFgaWriteClient(client)) {
      throw new Error("OpenFGA write client unavailable");
    }
    return client.writeTuples(tuples, options);
  }

  async write(
    body: {
      readonly writes?: AuthzRelationTuple[];
      readonly deletes?: Array<
        Pick<AuthzRelationTuple, "user" | "relation" | "object">
      >;
    },
    options?: {
      readonly conflict?: {
        readonly onDuplicateWrites?: "error" | "ignore";
        readonly onMissingDeletes?: "error" | "ignore";
      };
    }
  ): Promise<unknown> {
    const client = await this.resolveClient();
    if (!isOpenFgaReplaceClient(client)) {
      throw new Error("OpenFGA write client unavailable");
    }
    return client.write(body, options);
  }

  async deleteTuples(
    tuples: Array<Pick<AuthzRelationTuple, "user" | "relation" | "object">>,
    options?: {
      readonly conflict?: {
        readonly onMissingDeletes?: "error" | "ignore";
      };
    }
  ): Promise<unknown> {
    const client = await this.resolveClient();
    if (!isOpenFgaWriteClient(client)) {
      throw new Error("OpenFGA write client unavailable");
    }
    return client.deleteTuples(tuples, options);
  }

  private resolveClient(): Promise<OpenFgaCheckClient> {
    this.resolvedClient ??= this.createResolvedClient();
    return this.resolvedClient;
  }

  private async createResolvedClient(): Promise<OpenFgaCheckClient> {
    const rootClient =
      this.config.storeClient ??
      (new OpenFgaClient(
        openFgaClientConfig(this.config)
      ) as OpenFgaStoreClient);
    const { stores = [] } = await rootClient.listStores({
      name: this.storeName,
      pageSize: 1,
    });
    const store = stores.find((candidate) => candidate.name === this.storeName);
    const storeId =
      store?.id ?? (await rootClient.createStore({ name: this.storeName })).id;

    if (this.config.storeClient !== undefined) return this.config.storeClient;

    return new OpenFgaClient(openFgaClientConfig(this.config, storeId));
  }
}

function unavailableCheck(check: PlannedSubcheck): AuthzSubcheck {
  return {
    ...check,
    decision: "deny",
    code: "authz_unavailable",
  };
}

function deniedDecision(
  code: "authz_denied" | "authz_unavailable",
  checks: readonly AuthzSubcheck[],
  reason?: string
): AuthzDecision {
  return {
    decision: "deny",
    code,
    checks,
    ...(reason !== undefined ? { reason } : {}),
  };
}

/**
 * Extract a stable, log-safe cause from an OpenFGA client error. Prefers the HTTP
 * status when present (distinguishes a 4xx model/validation reject from a transport
 * failure), else the error message (e.g. the withTimeout message, ECONNREFUSED).
 */
function errorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const status =
      (error as { statusCode?: unknown; status?: unknown }).statusCode ??
      (error as { status?: unknown }).status;
    if (typeof status === "number") {
      const msg = error instanceof Error ? error.message : String(error);
      return `status=${status} ${msg}`;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

class OpenFgaTimeoutError extends Error {}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation = "request"
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new OpenFgaTimeoutError(
          `OpenFGA ${operation} timed out after ${timeoutMs}ms`
        )
      );
    }, timeoutMs);
  });

  // If the timeout wins, the underlying SDK promise stays pending and may reject
  // later (the slow request usually errors during an outage) — with nothing awaiting
  // it that becomes an unhandledRejection, multiplied per retry attempt. Swallow the
  // loser explicitly.
  promise.catch(() => {});

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Whether an OpenFGA failure is worth retrying. Transient = our own timeout, a
 * 5xx, a 429, or a bare transport error (no HTTP status). A 4xx (model/validation
 * reject, e.g. an unknown relation) is deterministic — retrying only wastes the
 * caller's latency budget, so it fails fast.
 */
function isTransientError(error: unknown): boolean {
  if (error instanceof OpenFgaTimeoutError) return true;
  if (error && typeof error === "object") {
    const status =
      (error as { statusCode?: unknown; status?: unknown }).statusCode ??
      (error as { status?: unknown }).status;
    if (typeof status === "number") return status >= 500 || status === 429;
  }
  // No HTTP status → transport-level failure (ECONNREFUSED/RESET, DNS) → transient.
  return true;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retry a transient-failing async op with fixed backoff. OpenFGA's own SDKs retry
 * 3× on 429/5xx (min 100ms wait); our hand-rolled `withTimeout` race pre-empts that
 * built-in retry, so we restore it here for idempotent writes. A single cold-path
 * latency spike (connection re-establish — OpenFGA's documented p99 factor) that
 * crosses the per-attempt deadline is masked instead of surfacing a user-facing 503.
 * Only retries when `isTransientError`; deterministic 4xx fail on the first attempt.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  backoffMs: number,
  isRetryable: (error: unknown) => boolean = isTransientError
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === maxRetries || !isRetryable(error)) throw error;
      await sleep(backoffMs);
    }
  }
  throw lastError;
}

/** HTTP status carried by an OpenFGA client error (`.statusCode`), else a hand-set `.status`. */
function httpStatusOf(error: unknown): number | undefined {
  if (error && typeof error === "object") {
    const status =
      (error as { statusCode?: unknown; status?: unknown }).statusCode ??
      (error as { status?: unknown }).status;
    if (typeof status === "number") return status;
  }
  return undefined;
}

/**
 * Retryable ONLY when the prior attempt is provably FINISHED (a response was received or the
 * call threw), so a retry cannot race a still-live request. Two cases and one exception:
 *  - our own `OpenFgaTimeoutError` is NEVER retryable: `withTimeout` is a `Promise.race` that
 *    abandons — never cancels — the in-flight request, so retrying it issues a concurrent
 *    duplicate → HTTP 409 (bug.5082). Fail closed instead.
 *  - HTTP 409 IS retryable: OpenFGA maps a datastore serialization conflict (two concurrent
 *    writes touching the same tuple) to 409; the transaction rolled back and the response
 *    returned, so re-running the single-tuple write is safe and idempotent. On retry the racing
 *    writer has committed, so `onDuplicateWrites`/`onMissingDeletes: ignore` makes it a 200
 *    no-op. This is OpenFGA's prescribed 409 recovery — retry, never assume the end-state (a
 *    409 does NOT prove the tuple converged the way THIS op intended; assuming success on a
 *    delete would fail OPEN on a revoke). Exhausted retries fail closed as `authz_write_unavailable`.
 *  - everything else `isTransientError` already allows (thrown transport error, returned 5xx/429).
 */
function isRetryableWriteError(error: unknown): boolean {
  if (error instanceof OpenFgaTimeoutError) return false;
  return isTransientError(error) || httpStatusOf(error) === 409;
}

export class OpenFgaAuthorizationAdapter implements AuthorizationPort {
  private readonly client: OpenFgaCheckClient;
  private readonly timeoutMs: number;
  private readonly writeTimeoutMs: number;
  private readonly writeMaxRetries: number;
  private readonly writeRetryBackoffMs: number;
  private readonly now: () => Date;

  constructor(config: OpenFgaAuthorizationAdapterConfig) {
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.writeTimeoutMs = config.writeTimeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS;
    this.writeMaxRetries = config.writeMaxRetries ?? DEFAULT_WRITE_MAX_RETRIES;
    this.writeRetryBackoffMs =
      config.writeRetryBackoffMs ?? DEFAULT_WRITE_RETRY_BACKOFF_MS;
    this.now = config.now ?? (() => new Date());
    if (config.client !== undefined) {
      this.client = config.client;
    } else if (config.storeId !== undefined) {
      this.client = new OpenFgaClient(
        openFgaClientConfig(config, config.storeId)
      );
    } else if (config.storeName !== undefined) {
      this.client = new StoreNameResolvingOpenFgaClient(
        config,
        config.storeName
      );
    } else {
      throw new Error("OpenFGA storeId or storeName is required");
    }
  }

  async check(
    params: AuthzCheckParams,
    options?: AuthzCheckOptions
  ): Promise<AuthzDecision> {
    const checks = this.planChecks(params);
    const results = await Promise.all(
      checks.map((check) => this.runCheck(check, options))
    );

    if (results.some((result) => result.code === "authz_unavailable")) {
      return deniedDecision(
        "authz_unavailable",
        results,
        "OpenFGA unavailable"
      );
    }

    if (results.every((result) => result.decision === "allow")) {
      return {
        decision: "allow",
        code: "authz_allowed",
        checks: results,
      };
    }

    return deniedDecision("authz_denied", results, "OpenFGA denied");
  }

  async writeRelation(
    tuple: AuthzRelationTuple,
    options?: AuthzMutationOptions
  ): Promise<AuthzWriteDecision> {
    return this.writeRelations([tuple], options);
  }

  async writeRelations(
    tuples: readonly AuthzRelationTuple[],
    options?: AuthzMutationOptions
  ): Promise<AuthzWriteDecision> {
    const client = this.client;
    if (!isOpenFgaWriteClient(client)) {
      return {
        decision: "failure",
        code: "authz_write_unavailable",
        reason: "OpenFGA write client unavailable",
      };
    }

    try {
      await withRetry(
        () =>
          withTimeout(
            client.writeTuples([...tuples], {
              conflict: { onDuplicateWrites: "ignore" },
            }),
            this.writeTimeoutMs,
            "write"
          ),
        this.writeMaxRetries,
        this.writeRetryBackoffMs,
        isRetryableWriteError
      );
      if (options?.confirm === "higher_consistency") {
        return this.confirmRelations(tuples, true);
      }
      return { decision: "success", code: "authz_write_success" };
    } catch (error) {
      // Surface the underlying cause (timeout vs connection-refused vs OpenFGA 4xx).
      // A bare `catch {}` here turns every write failure into an indistinguishable
      // `authz_write_unavailable`, which forces deep spelunking during an outage.
      return {
        decision: "failure",
        code: "authz_write_unavailable",
        reason: `OpenFGA write unavailable: ${errorMessage(error)}`,
      };
    }
  }

  async deleteRelation(
    tuple: AuthzRelationTuple,
    options?: AuthzMutationOptions
  ): Promise<AuthzWriteDecision> {
    return this.deleteRelations([tuple], options);
  }

  async deleteRelations(
    tuples: readonly AuthzRelationTuple[],
    options?: AuthzMutationOptions
  ): Promise<AuthzWriteDecision> {
    const client = this.client;
    if (!isOpenFgaWriteClient(client)) {
      return {
        decision: "failure",
        code: "authz_write_unavailable",
        reason: "OpenFGA write client unavailable",
      };
    }

    try {
      await withRetry(
        () =>
          withTimeout(
            client.deleteTuples(tuples.map(tupleKeyWithoutCondition), {
              conflict: { onMissingDeletes: "ignore" },
            }),
            this.writeTimeoutMs,
            "delete"
          ),
        this.writeMaxRetries,
        this.writeRetryBackoffMs,
        isRetryableWriteError
      );
      if (options?.confirm === "higher_consistency") {
        return this.confirmRelations(tuples, false);
      }
      return { decision: "success", code: "authz_write_success" };
    } catch (error) {
      return {
        decision: "failure",
        code: "authz_write_unavailable",
        reason: `OpenFGA delete unavailable: ${errorMessage(error)}`,
      };
    }
  }

  async replaceRelation(
    tuple: AuthzRelationTuple,
    options?: AuthzMutationOptions
  ): Promise<AuthzWriteDecision> {
    const client = this.client;
    if (!isOpenFgaReplaceClient(client)) {
      return {
        decision: "failure",
        code: "authz_write_unavailable",
        reason: "OpenFGA write client unavailable",
      };
    }

    try {
      await withRetry(
        () =>
          withTimeout(
            client.write(
              {
                deletes: [tupleKeyWithoutCondition(tuple)],
                writes: [tuple],
              },
              {
                conflict: {
                  // Never acknowledge a retained older condition as success.
                  // The server applies this delete+write as one transaction.
                  onDuplicateWrites: "error",
                  onMissingDeletes: "ignore",
                },
              }
            ),
            this.writeTimeoutMs,
            "replace"
          ),
        this.writeMaxRetries,
        this.writeRetryBackoffMs,
        isRetryableWriteError
      );
      if (options?.confirm === "higher_consistency") {
        return this.confirmRelations([tuple], true);
      }
      return { decision: "success", code: "authz_write_success" };
    } catch (error) {
      return {
        decision: "failure",
        code: "authz_write_unavailable",
        reason: `OpenFGA replace unavailable: ${errorMessage(error)}`,
      };
    }
  }

  private planChecks(params: AuthzCheckParams): readonly PlannedSubcheck[] {
    const conditionContext = this.conditionContextForAction(params.action);
    const permission = {
      name: "permission" as const,
      user: params.subjectId ?? params.actorId,
      relation: relationForAuthzAction(params.action),
      object: params.resource,
      ...(conditionContext !== undefined ? { context: conditionContext } : {}),
    };

    if (!params.subjectId) return [permission];

    const subjectDelegation = {
      name: "delegation" as const,
      user: params.actorId,
      relation: relationForAuthzAction("user.act_as"),
      object: authzUserResource(params.subjectId),
    };

    if (params.action !== "billing_account.read") {
      return [permission, subjectDelegation];
    }

    return [
      permission,
      subjectDelegation,
      {
        name: "delegation",
        user: params.actorId,
        relation: relationForAuthzAction("billing_account.act_as"),
        object: params.resource,
        ...(conditionContext !== undefined
          ? { context: conditionContext }
          : {}),
      },
    ];
  }

  private async runCheck(
    check: PlannedSubcheck,
    options?: AuthzCheckOptions
  ): Promise<AuthzSubcheck> {
    try {
      const response = await withTimeout(
        this.client.check(
          {
            user: check.user,
            relation: check.relation,
            object: check.object,
            ...(check.context !== undefined ? { context: check.context } : {}),
          },
          options?.consistency === "higher_consistency"
            ? { consistency: ConsistencyPreference.HigherConsistency }
            : undefined
        ),
        this.timeoutMs,
        "check"
      );

      return {
        ...check,
        decision: response.allowed === true ? "allow" : "deny",
        code: response.allowed === true ? "authz_allowed" : "authz_denied",
      };
    } catch {
      return unavailableCheck(check);
    }
  }

  private conditionContextForAction(
    action: AuthzCheckParams["action"]
  ): Readonly<Record<string, unknown>> | undefined {
    if (
      action !== "billing_account.read" &&
      action !== "billing_account.act_as"
    ) {
      return undefined;
    }
    return { current_time: this.now().toISOString() };
  }

  private async confirmRelations(
    tuples: readonly AuthzRelationTuple[],
    expectedAllowed: boolean
  ): Promise<AuthzWriteDecision> {
    try {
      const responses = await Promise.all(
        tuples.map((tuple) => {
          const conditionContext =
            tuple.condition?.name === AUTHZ_GRANT_NOT_EXPIRED_CONDITION
              ? { current_time: this.now().toISOString() }
              : undefined;
          return withTimeout(
            this.client.check(
              {
                user: tuple.user,
                relation: tuple.relation,
                object: tuple.object,
                ...(conditionContext !== undefined
                  ? { context: conditionContext }
                  : {}),
              },
              { consistency: ConsistencyPreference.HigherConsistency }
            ),
            this.timeoutMs,
            "confirmation"
          );
        })
      );

      if (responses.every((response) => response.allowed === expectedAllowed)) {
        return { decision: "success", code: "authz_write_success" };
      }
      return {
        decision: "failure",
        code: "authz_write_unavailable",
        reason: `OpenFGA confirmation mismatch: expected allowed=${expectedAllowed}`,
      };
    } catch (error) {
      return {
        decision: "failure",
        code: "authz_write_unavailable",
        reason: `OpenFGA confirmation unavailable: ${errorMessage(error)}`,
      };
    }
  }
}

function tupleKeyWithoutCondition(
  tuple: AuthzRelationTuple
): Pick<AuthzRelationTuple, "user" | "relation" | "object"> {
  return {
    user: tuple.user,
    relation: tuple.relation,
    object: tuple.object,
  };
}

function isOpenFgaWriteClient(
  client: OpenFgaCheckClient
): client is OpenFgaWriteClient {
  return "writeTuples" in client && "deleteTuples" in client;
}

function isOpenFgaReplaceClient(
  client: OpenFgaCheckClient
): client is OpenFgaWriteClient &
  Required<Pick<OpenFgaWriteClient, "write">> {
  return isOpenFgaWriteClient(client) && "write" in client;
}
