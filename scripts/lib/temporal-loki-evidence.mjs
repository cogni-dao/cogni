// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/lib/temporal-loki-evidence`
 * Purpose: Read exact schedule/run evidence from Grafana Cloud Loki.
 * Scope: Reads bounded Grafana queries. Does not write logs or expose credentials.
 * Invariants:
 *   - Queries are pinned to the exact env and scheduler-worker stream. The
 *     stream `node` label is the physical k8s host, never the Cogni node UUID.
 *   - Target nodeId, scheduleId, and graphRunId are line filters and every
 *     returned entry is locally rechecked for all three exact JSON values.
 *   - Query time and result count are bounded.
 *   - Grafana credentials are header-only and never appear in output/errors.
 *   - Missing credentials, malformed responses, and zero hits fail closed.
 * Side-effects: IO (read-only Grafana Cloud Loki request)
 * Links: scripts/lib/temporal-scheduled-probe.mjs,
 *   docs/spec/observability.md#logql-queries, task.5239
 * @public
 */

const DEFAULT_DATASOURCE_UID = "grafanacloud-logs";
const DEFAULT_LIMIT = 100;
const DEFAULT_MAX_RANGE_MS = 15 * 60_000;
const DEFAULT_START_PADDING_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const HARD_MAX_LIMIT = 1_000;
const HARD_MAX_RANGE_MS = 30 * 60_000;
const HARD_MAX_REQUEST_TIMEOUT_MS = 60_000;

export class TemporalLokiEvidenceError extends Error {
  constructor(message, phase) {
    super(message);
    this.name = "TemporalLokiEvidenceError";
    this.phase = phase;
  }
}

function requiredString(value, name, phase = "configuration") {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TemporalLokiEvidenceError(`${name} is required`, phase);
  }
  return value.trim();
}

function boundedPositiveInteger(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TemporalLokiEvidenceError(
      `${name} must be a positive integer`,
      "configuration"
    );
  }
  if (value > maximum) {
    throw new TemporalLokiEvidenceError(
      `${name} must not exceed ${maximum}`,
      "configuration"
    );
  }
  return value;
}

function grafanaBaseUrl(value) {
  const raw = requiredString(value, "GRAFANA_URL");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new TemporalLokiEvidenceError(
      "GRAFANA_URL must be a valid URL",
      "configuration"
    );
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  ) {
    throw new TemporalLokiEvidenceError(
      "GRAFANA_URL must be an HTTP(S) URL without embedded credentials",
      "configuration"
    );
  }
  return raw.replace(/\/+$/, "");
}

function timestampMs(value, name) {
  const result = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(result)) {
    throw new TemporalLokiEvidenceError(
      `${name} must be a valid timestamp`,
      "configuration"
    );
  }
  return result;
}

function toNanoseconds(milliseconds) {
  return (BigInt(Math.trunc(milliseconds)) * 1_000_000n).toString();
}

function logqlString(value) {
  return JSON.stringify(requiredString(value, "LogQL filter"));
}

export function buildTemporalEvidenceQuery({
  environment,
  nodeId,
  scheduleId,
  graphRunId,
}) {
  return `{env=${logqlString(environment)},service="scheduler-worker"} |= ${logqlString(nodeId)} |= ${logqlString(scheduleId)} |= ${logqlString(graphRunId)}`;
}

function containsExactValue(value, expected) {
  if (value === expected) return true;
  if (Array.isArray(value)) {
    return value.some((entry) => containsExactValue(entry, expected));
  }
  if (value && typeof value === "object") {
    return Object.values(value).some((entry) =>
      containsExactValue(entry, expected)
    );
  }
  return false;
}

function exploreUrl({ baseUrl, datasourceUid, query, startMs, endMs }) {
  const url = new URL(`${baseUrl}/explore`);
  url.searchParams.set("schemaVersion", "1");
  url.searchParams.set(
    "panes",
    JSON.stringify({
      temporalEvidence: {
        datasource: datasourceUid,
        queries: [{ refId: "A", expr: query, queryType: "range" }],
        range: {
          from: new Date(startMs).toISOString(),
          to: new Date(endMs).toISOString(),
        },
      },
    })
  );
  return url.toString();
}

function parseLokiResponse(body) {
  if (
    !body ||
    body.status !== "success" ||
    body.data?.resultType !== "streams" ||
    !Array.isArray(body.data.result)
  ) {
    throw new TemporalLokiEvidenceError(
      "Loki query_range returned a malformed response",
      "loki_response"
    );
  }

  const entries = [];
  for (const stream of body.data.result) {
    if (
      !stream ||
      !stream.stream ||
      typeof stream.stream !== "object" ||
      !Array.isArray(stream.values)
    ) {
      throw new TemporalLokiEvidenceError(
        "Loki query_range returned a malformed stream",
        "loki_response"
      );
    }
    for (const value of stream.values) {
      if (
        !Array.isArray(value) ||
        value.length !== 2 ||
        typeof value[0] !== "string" ||
        !/^\d+$/.test(value[0]) ||
        typeof value[1] !== "string"
      ) {
        throw new TemporalLokiEvidenceError(
          "Loki query_range returned a malformed log entry",
          "loki_response"
        );
      }
      let parsed = null;
      try {
        const candidate = JSON.parse(value[1]);
        if (candidate && typeof candidate === "object") parsed = candidate;
      } catch {
        // Plain-text Loki lines remain valid evidence.
      }
      entries.push({
        timestampNs: value[0],
        line: value[1],
        labels: { ...stream.stream },
        ...(parsed ? { parsed } : {}),
      });
    }
  }
  return entries.sort((a, b) => {
    const left = BigInt(a.timestampNs);
    const right = BigInt(b.timestampNs);
    return left === right ? 0 : left < right ? 1 : -1;
  });
}

/**
 * Build the callback consumed by `proveScheduledLangGraph`.
 *
 * Credentials default to the two canonical Grafana environment variables,
 * while dependency overrides keep the adapter unit-testable.
 */
export function createTemporalLokiEvidenceReader(options = {}) {
  const baseUrl = grafanaBaseUrl(options.grafanaUrl ?? process.env.GRAFANA_URL);
  const token = requiredString(
    options.token ?? process.env.GRAFANA_SERVICE_ACCOUNT_TOKEN,
    "GRAFANA_SERVICE_ACCOUNT_TOKEN"
  );
  const datasourceUid = requiredString(
    options.datasourceUid ?? DEFAULT_DATASOURCE_UID,
    "datasourceUid"
  );
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new TemporalLokiEvidenceError(
      "fetch implementation is required",
      "configuration"
    );
  }
  const now = options.now ?? (() => Date.now());
  if (typeof now !== "function") {
    throw new TemporalLokiEvidenceError(
      "now must be a function",
      "configuration"
    );
  }
  const limit = boundedPositiveInteger(
    options.limit ?? DEFAULT_LIMIT,
    "limit",
    HARD_MAX_LIMIT
  );
  const maxRangeMs = boundedPositiveInteger(
    options.maxRangeMs ?? DEFAULT_MAX_RANGE_MS,
    "maxRangeMs",
    HARD_MAX_RANGE_MS
  );
  const startPaddingMs = boundedPositiveInteger(
    options.startPaddingMs ?? DEFAULT_START_PADDING_MS,
    "startPaddingMs",
    HARD_MAX_RANGE_MS
  );
  const requestTimeoutMs = boundedPositiveInteger(
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    "requestTimeoutMs",
    HARD_MAX_REQUEST_TIMEOUT_MS
  );

  return async function readLokiEvidence(input) {
    const environment = requiredString(
      input?.target?.environment,
      "target.environment"
    );
    const nodeId = requiredString(input?.target?.nodeId, "target.nodeId");
    const scheduleId = requiredString(input?.scheduleId, "scheduleId");
    const graphRunId = requiredString(input?.graphRunId, "graphRunId");
    const scheduledAtMs = timestampMs(input?.scheduledAt, "scheduledAt");
    const endMs = now();
    if (!Number.isFinite(endMs) || endMs <= scheduledAtMs) {
      throw new TemporalLokiEvidenceError(
        "current time must be after scheduledAt",
        "configuration"
      );
    }
    const startMs = Math.max(
      scheduledAtMs - startPaddingMs,
      endMs - maxRangeMs
    );
    const query = buildTemporalEvidenceQuery({
      environment,
      nodeId,
      scheduleId,
      graphRunId,
    });
    const requestUrl = new URL(
      `${baseUrl}/api/datasources/proxy/uid/${encodeURIComponent(datasourceUid)}/loki/api/v1/query_range`
    );
    requestUrl.searchParams.set("query", query);
    requestUrl.searchParams.set("start", toNanoseconds(startMs));
    requestUrl.searchParams.set("end", toNanoseconds(endMs));
    requestUrl.searchParams.set("limit", String(limit));
    requestUrl.searchParams.set("direction", "backward");

    let response;
    try {
      response = await fetchImpl(requestUrl, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch {
      throw new TemporalLokiEvidenceError(
        "Loki query_range request failed",
        "loki_request"
      );
    }
    if (!response?.ok) {
      throw new TemporalLokiEvidenceError(
        `Loki query_range failed with HTTP ${response?.status ?? "unknown"}`,
        "loki_request"
      );
    }

    let body;
    try {
      body = await response.json();
    } catch {
      throw new TemporalLokiEvidenceError(
        "Loki query_range returned invalid JSON",
        "loki_response"
      );
    }
    const entries = parseLokiResponse(body).filter(
      (entry) =>
        entry.parsed?.nodeId === nodeId &&
        containsExactValue(entry.parsed, scheduleId) &&
        containsExactValue(entry.parsed, graphRunId)
    );
    if (entries.length === 0) {
      throw new TemporalLokiEvidenceError(
        "Loki returned no entry correlated by nodeId, scheduleId, and graphRunId",
        "loki_no_hit"
      );
    }

    return {
      entries,
      query,
      sourceUrl: exploreUrl({
        baseUrl,
        datasourceUid,
        query,
        startMs,
        endMs,
      }),
      range: {
        start: new Date(startMs).toISOString(),
        end: new Date(endMs).toISOString(),
      },
    };
  };
}
