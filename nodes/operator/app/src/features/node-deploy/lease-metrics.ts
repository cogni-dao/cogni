// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/lease-metrics`
 * Purpose: Makes "deployed via operator => request metrics in Mimir" a structural property (bug.5641). The operator
 *   publishes every serving lane as a Prometheus HTTP service-discovery target and relays each lane's `/api/metrics`
 *   with that lane's derived token. The env's Alloy scrapes each lane as its own target, so scraping, `up`, limits
 *   and label precedence stay native Prometheus behavior. This is the control-plane counterpart of the lease-log pump.
 * Scope: Token derivation, the SD target shape, lane-path validation and the relay outcome. IO lives in the caller.
 * Invariants:
 *   - ONE_SECRET_TWO_USES: the operator METRICS_TOKEN is both Alloy's bearer for these routes and the HMAC root of every
 *     lane token. Rotating it 401s every lane until its next release (bug.5641 debt).
 *   - NODE_APPS_ONLY: only node-app lanes are listed and relayed. A `worker` release gets no token and no `/api/metrics`.
 *   - TOKEN_IS_DERIVED: a lane's token is `HMAC-SHA256(operator METRICS_TOKEN, "metrics-scrape:v1:<nodeId>:<env>")` in
 *     hex. The sequencer puts it in the lease env as `METRICS_TOKEN`; the operator recomputes it. No node bucket is read,
 *     and one leaked token reaches one node and env only.
 *   - TRUSTED_LABELS_FROM_SD: `node` (repo-spec UUID), `env`, `workload`, `service` and `app` come from the release
 *     store as target labels. Alloy scrapes with `honor_labels = false`, so a tenant copy becomes `exported_<name>`.
 *   - ONE_TARGET_PER_LANE: each lane has its own scrape, timeout, sample limit and `up`. One lane cannot fail another.
 *   - RELAY_IS_OPAQUE: the relay never parses tenant text. A non-200, oversized or unreachable lane is a non-200 relay
 *     response, which Prometheus records as `up = 0`.
 * Side-effects: none
 * Links: app/api/metrics/leases/route.ts, app/api/metrics/leases/[node]/[env]/[workload]/route.ts,
 *   infra/compose/runtime/configs/alloy-config.metrics.alloy, https://cognidao.org/knowledge/lease-metrics-forwarding-design
 * @internal
 */

import { createHmac } from "node:crypto";

/** The path every node app serves its Prometheus exposition on. */
export const LEASE_METRICS_PATH = "/api/metrics";
/**
 * Most lanes one discovery read lists. One operator store holds every env it serves (nodes x envs x workloads). A read
 * past the bound is refused (503), never a silently short list: an unlisted lane would have no `up` to alert on.
 */
export const MAX_LEASE_LANES = 1000;
/** Relay deadline per lane. Alloy's scrape timeout for the job is longer. */
export const LEASE_SCRAPE_TIMEOUT_MS = 8_000;
/** Largest relayed body, in bytes. A body at the cap is refused as too large. Alloy's `body_size_limit` matches. */
export const LEASE_SCRAPE_MAX_BYTES = 2_000_000;
/** The `app` label of every lane series. Operator analytics sum `app="cogni-template"`, so a lane never joins them. */
export const LEASE_APP_LABEL = "cogni-node";
/** The relay route prefix. A lane's path is `<prefix>/<node>/<env>/<workload>`. */
export const LEASE_RELAY_PREFIX = "/api/metrics/leases";

const TOKEN_MESSAGE_PREFIX = "metrics-scrape:v1";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ENV_RE = /^[a-z][a-z0-9-]{0,31}$/;
const WORKLOAD_RE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

/** The scrape token of one lane. Same inputs always give the same token. */
export function deriveLeaseMetricsToken(
  root: string,
  nodeId: string,
  env: string
): string {
  // Trimmed like the sequencer's file read, so the relay and the lease derive from the same bytes.
  return createHmac("sha256", root.trim())
    .update(`${TOKEN_MESSAGE_PREFIX}:${nodeId}:${env}`, "utf8")
    .digest("hex");
}

export interface LeaseScrapeLane {
  readonly nodeId: string;
  readonly env: string;
  readonly workload: string;
  readonly host: string;
}

export interface LeaseLaneKey {
  readonly nodeId: string;
  readonly env: string;
  readonly workload: string;
}

/** The relay path params, or null when any is malformed. Checked before any store read. */
export function parseLeaseLaneKey(params: {
  readonly node: string;
  readonly env: string;
  readonly workload: string;
}): LeaseLaneKey | null {
  if (
    !UUID_RE.test(params.node) ||
    !ENV_RE.test(params.env) ||
    !WORKLOAD_RE.test(params.workload)
  )
    return null;
  return { nodeId: params.node, env: params.env, workload: params.workload };
}

/** One Prometheus HTTP service-discovery target group. */
export interface HttpSdTargetGroup {
  readonly targets: readonly string[];
  readonly labels: Readonly<Record<string, string>>;
}

/**
 * The HTTP SD document: one group per lane. The target is the lane's public host, which Alloy keeps as `instance`
 * and then replaces with its own route to this operator; `__metrics_path__` selects the lane's relay.
 */
export function leaseScrapeTargets(
  lanes: readonly LeaseScrapeLane[]
): HttpSdTargetGroup[] {
  return lanes.map((lane) => ({
    targets: [lane.host],
    labels: {
      __metrics_path__: `${LEASE_RELAY_PREFIX}/${lane.nodeId}/${lane.env}/${lane.workload}`,
      node: lane.nodeId,
      env: lane.env,
      workload: lane.workload,
      service: "app",
      app: LEASE_APP_LABEL,
    },
  }));
}

/** Bounded reason a relay did not return the lane's exposition. */
export type LeaseRelayReason =
  | "unauthorized"
  | "not_configured"
  | "http_error"
  | "timeout"
  | "network"
  | "invalid_target"
  | "too_large";

export type LeaseFetchResult =
  | {
      readonly kind: "response";
      readonly status: number;
      readonly body: string;
    }
  | { readonly kind: "unreachable"; readonly code: string };

export type LeaseRelayOutcome =
  | { readonly ok: true; readonly body: string }
  | {
      readonly ok: false;
      readonly reason: LeaseRelayReason;
      readonly status?: number | undefined;
    };

/** Classify one lane fetch. Only a complete 200 body is relayed; everything else is a bounded reason. */
export function classifyLeaseFetch(
  result: LeaseFetchResult,
  maxBytes: number = LEASE_SCRAPE_MAX_BYTES
): LeaseRelayOutcome {
  if (result.kind === "unreachable") {
    const reason: LeaseRelayReason =
      result.code === "timeout" || result.code === "invalid_target"
        ? result.code
        : "network";
    return { ok: false, reason };
  }
  const { status, body } = result;
  if (status === 200) {
    // A body at the cap was cut: relaying it would ship a truncated exposition.
    if (Buffer.byteLength(body, "utf8") >= maxBytes)
      return { ok: false, reason: "too_large", status };
    return { ok: true, body };
  }
  if (status === 401 || status === 403)
    return { ok: false, reason: "unauthorized", status };
  // The node app answers 500 "METRICS_TOKEN not configured" until a release made with a token.
  if (status === 500 && body.includes("METRICS_TOKEN"))
    return { ok: false, reason: "not_configured", status };
  return { ok: false, reason: "http_error", status };
}
