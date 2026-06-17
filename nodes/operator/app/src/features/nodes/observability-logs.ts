// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/nodes/observability-logs`
 * Purpose: The security core of the node-pinned log-read PROXY (task.5025 / north-star ②).
 *   Builds the LogQL the operator runs on a dev's behalf, **forcing** the stream selector to
 *   `{env=…, service="app", node="<nodeId>"}` so a dev can only ever read their own node's logs —
 *   the per-node OpenFGA check (in the route) gates WHO, this builder gates REACH.
 * Scope: Pure — no network, no auth, no env. The route does auth/RBAC; the adapter does IO.
 * Invariants:
 *   - ENV_FROM_CANONICAL: the env set is the shared `FLIGHT_ENVS` (the envs a node deploys to) — NOT a
 *     local copy. Adding a deploy env updates one place; this proxy follows automatically.
 *   - SELECTOR_IS_FORCED: the node + service + env selector is constructed here, never dev-supplied.
 *   - FILTER_IS_PIPELINE_ONLY: the optional dev `filter` is appended as a LogQL pipeline and MUST NOT
 *     contain a stream selector — braces `{`/`}` are rejected so a dev cannot open a second selector
 *     (e.g. `} or {node="other"}`) to widen scope.
 *   - APP_ONLY_ENVELOPE: `service` is fixed to `app` because the node app pod is the ONLY log source
 *     carrying the per-node `node` label today. Shared-infra services (scheduler-worker, temporal,
 *     litellm) are NOT node-attributable yet (they bind no `nodeId`), so they are deliberately out of
 *     scope — surfacing them here would leak cross-node lines. See docs/spec/grafana-observability-access.md
 *     §"Node-dev log scope envelope".
 * Side-effects: none (pure)
 * Links: docs/spec/grafana-observability-access.md, ./flight-status (FLIGHT_ENVS), task.5025
 * @public
 */

import type { FlightEnv } from "@/ports";
import { FLIGHT_ENVS, isFlightEnv } from "./flight-status";

export { FLIGHT_ENVS, type FlightEnv, isFlightEnv };

/** The only Loki `service` that carries the per-node `node` label today (the node's app pod). */
export const NODE_SCOPED_SERVICE = "app";

/** Max length of a dev-supplied pipeline filter (defensive bound, not a real LogQL limit). */
export const MAX_FILTER_LENGTH = 512;

/** Thrown when the dev-supplied filter would breach the node pin (→ HTTP 400). */
export class ObservabilityQueryError extends Error {
  readonly code = "invalid_filter";
  constructor(message: string) {
    super(message);
    this.name = "ObservabilityQueryError";
  }
}

/**
 * Build the node-pinned LogQL query. The selector is forced to this node's app stream; `filter`
 * (if any) is a LogQL pipeline appended after it and validated to contain no stream selector.
 */
export function buildNodeScopedLogQL(input: {
  readonly env: FlightEnv;
  readonly nodeId: string;
  readonly filter?: string | undefined;
}): string {
  const selector = `{env=${quote(input.env)}, service=${quote(NODE_SCOPED_SERVICE)}, node=${quote(input.nodeId)}}`;

  const filter = (input.filter ?? "").trim();
  if (filter === "") return selector;

  if (filter.length > MAX_FILTER_LENGTH) {
    throw new ObservabilityQueryError(
      `filter exceeds ${MAX_FILTER_LENGTH} chars`
    );
  }
  if (filter.includes("{") || filter.includes("}")) {
    throw new ObservabilityQueryError(
      "filter must be a LogQL pipeline (no stream selector / braces)"
    );
  }
  return `${selector} ${filter}`;
}

/** Double-quote a LogQL label value, escaping `\` and `"`. */
function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
