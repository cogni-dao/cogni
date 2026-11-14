// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/analytics/capture`
 * Purpose: PostHog product analytics capture wrapper — single entry point for all server-side event capture.
 * Scope: Provides capture() helper with required field enforcement, batching, and safe defaults. Does not own PostHog infrastructure.
 * Invariants:
 *   - Every event includes distinct_id, session_id, environment, app_version
 *   - No PII (emails, raw tokens, secrets) in properties
 *   - No unbounded nested blobs — properties are flat and typed
 *   - Graceful degradation: capture never throws; logs warning on failure
 *   - Server-side only (minimal HTTP batch client, no posthog-node dependency)
 * Side-effects: IO (HTTP to PostHog API)
 * Notes: Supports both self-hosted PostHog and PostHog Cloud via POSTHOG_HOST + POSTHOG_API_KEY env vars.
 * Links: docs/analytics/events.v0.md, https://node-template.cognidao.org/knowledge/posthog-capture-contract
 * @public
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Required identity fields for every analytics event. */
export interface CaptureIdentity {
  /** Canonical user ID (users.id UUID). Use stable anon ID for unauthenticated events. */
  userId: string;
  /** Session identifier for grouping events within a user session. */
  sessionId: string;
  /** Tenant/billing account ID. Null for system-level events. */
  tenantId?: string | null;
  /** OTel trace ID for cross-system correlation. */
  traceId?: string | null;
}

/** Flat, typed event properties. No nested blobs. */
export type CaptureProperties = Record<
  string,
  string | number | boolean | null | undefined
>;

/** Full capture call parameters. */
export interface CaptureParams {
  /** Namespaced event name (e.g., "cogni.auth.signed_in"). */
  event: string;
  /** Identity fields. */
  identity: CaptureIdentity;
  /** Flat, typed properties specific to this event. */
  properties?: CaptureProperties;
}

// ---------------------------------------------------------------------------
// Client singleton
// ---------------------------------------------------------------------------

/**
 * PostHog client interface — minimal contract for capture + shutdown.
 * Matches posthog-node API surface but allows in-memory stub for tests.
 */
export interface PostHogClient {
  capture(params: {
    distinctId: string;
    event: string;
    properties?: Record<string, unknown>;
    timestamp?: Date;
  }): void;
  shutdown(): Promise<void>;
}

/** In-memory buffer entry for when PostHog is not configured. */
export interface BufferedEvent {
  event: string;
  distinctId: string;
  properties: Record<string, unknown>;
  timestamp: Date;
}

let _client: PostHogClient | null = null;
let _appVersion: string | null = null;
let _environment: string | null = null;

/** Buffer for events captured before client is initialized, or when PostHog is disabled. */
const _buffer: BufferedEvent[] = [];
const MAX_BUFFER_SIZE = 1000;

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

export interface AnalyticsConfig {
  /** PostHog API key (project API key). */
  apiKey: string;
  /** PostHog host URL (e.g., "http://localhost:8000" or "https://us.i.posthog.com"). */
  host: string;
  /** Git SHA or version tag for app_version property. */
  appVersion: string;
  /** Deployment environment (local|preview|staging|prod). */
  environment: string;
  /** Optional: inject a custom PostHog client (for testing). */
  client?: PostHogClient;
  /** Batch flush interval in ms. Default: 5000. */
  flushIntervalMs?: number;
}

/**
 * Initialize the analytics client.
 * Must be called once at app startup (e.g., in instrumentation.ts or container init).
 * Idempotent — subsequent calls are no-ops.
 */
export function initAnalytics(config: AnalyticsConfig): void {
  if (_client !== null) {
    return; // Already initialized
  }

  _appVersion = config.appVersion;
  _environment = config.environment;

  if (config.client) {
    // Test/custom client injection
    _client = config.client;
  } else {
    // Lazy import to avoid pulling posthog-node into the module graph
    // when analytics is disabled. Uses the HTTP API wrapper.
    _client = createHttpClient(config);
  }

  // Flush buffered events
  for (const buffered of _buffer) {
    _client.capture({
      distinctId: buffered.distinctId,
      event: buffered.event,
      properties: buffered.properties,
      timestamp: buffered.timestamp,
    });
  }
  _buffer.length = 0;
}

/**
 * Check if analytics is initialized.
 */
export function isAnalyticsInitialized(): boolean {
  return _client !== null;
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/**
 * Capture a product analytics event.
 *
 * Enforces required identity fields and merges safe defaults (environment, app_version).
 * Never throws — logs a warning on validation failure and drops the event.
 *
 * @param params - Event name, identity, and properties.
 */
export function capture(params: CaptureParams): void {
  const { event, identity, properties } = params;

  // Validate required fields
  if (!event || typeof event !== "string") {
    logWarn("capture: missing or invalid event name", { event });
    return;
  }
  if (!identity.userId || typeof identity.userId !== "string") {
    logWarn("capture: missing userId", { event });
    return;
  }
  if (!identity.sessionId || typeof identity.sessionId !== "string") {
    logWarn("capture: missing sessionId", { event });
    return;
  }

  const timestamp = new Date();

  // Build merged properties with required envelope fields
  // Event-specific properties first, then envelope fields win (prevent accidental overwrite)
  const mergedProperties: Record<string, unknown> = {
    ...properties,
    // Envelope fields (always present — override any caller collision)
    session_id: identity.sessionId,
    environment: _environment ?? "unknown",
    app_version: _appVersion ?? "unknown",
    // Optional identity fields
    ...(identity.tenantId != null ? { tenant_id: identity.tenantId } : {}),
    ...(identity.traceId != null ? { trace_id: identity.traceId } : {}),
  };

  if (_client) {
    _client.capture({
      distinctId: identity.userId,
      event,
      properties: mergedProperties,
      timestamp,
    });
  } else {
    // Buffer events before initialization (capped to prevent memory leak)
    if (_buffer.length < MAX_BUFFER_SIZE) {
      _buffer.push({
        event,
        distinctId: identity.userId,
        properties: mergedProperties,
        timestamp,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

/**
 * Flush pending events and shut down the analytics client.
 * Call during graceful shutdown.
 */
export async function shutdownAnalytics(): Promise<void> {
  if (_client) {
    await _client.shutdown();
    _client = null;
  }
}

// ---------------------------------------------------------------------------
// Testing helpers
// ---------------------------------------------------------------------------

/**
 * Reset analytics state. For tests only.
 * @internal
 */
export function resetAnalytics(): void {
  _client = null;
  _appVersion = null;
  _environment = null;
  _buffer.length = 0;
}

/**
 * Get the current event buffer (events captured before init or when PostHog is disabled).
 * @internal
 */
export function getBuffer(): readonly BufferedEvent[] {
  return _buffer;
}

// ---------------------------------------------------------------------------
// Minimal HTTP client (no posthog-node dependency)
// ---------------------------------------------------------------------------

/**
 * Minimal PostHog HTTP client with batching.
 * Uses fetch() to send events to PostHog's /capture endpoint.
 * Avoids pulling in posthog-node as a dependency.
 */
function createHttpClient(config: AnalyticsConfig): PostHogClient {
  const batch: Array<{
    event: string;
    properties: Record<string, unknown>;
    timestamp: string;
    distinct_id: string;
  }> = [];
  let flushTimer: ReturnType<typeof setInterval> | null = null;
  const flushIntervalMs = config.flushIntervalMs ?? 5000;
  const host = config.host.replace(/\/$/, "");

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;

    const events = batch.splice(0, batch.length);
    try {
      await fetch(`${host}/batch/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: config.apiKey,
          batch: events,
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // Swallow errors — analytics should never break the app
      logWarn("analytics flush failed", { count: events.length });
    }
  };

  // Start periodic flush
  flushTimer = setInterval(() => {
    flush().catch(() => {});
  }, flushIntervalMs);

  // Unref timer so it doesn't prevent process exit
  if (flushTimer && typeof flushTimer === "object" && "unref" in flushTimer) {
    flushTimer.unref();
  }

  return {
    capture(params) {
      batch.push({
        event: params.event,
        properties: {
          ...params.properties,
          $lib: "cogni-analytics",
        },
        timestamp: (params.timestamp ?? new Date()).toISOString(),
        distinct_id: params.distinctId,
      });

      // Auto-flush at 50 events
      if (batch.length >= 50) {
        flush().catch(() => {});
      }
    },

    async shutdown() {
      if (flushTimer) {
        clearInterval(flushTimer);
        flushTimer = null;
      }
      await flush();
    },
  };
}

// ---------------------------------------------------------------------------
// Internal logging (no Pino dependency in shared layer)
// ---------------------------------------------------------------------------

function logWarn(msg: string, data?: Record<string, unknown>): void {
  // biome-ignore lint/suspicious/noConsole: analytics warnings before logging may be available
  console.warn(`[analytics] ${msg}`, data ?? "");
}
