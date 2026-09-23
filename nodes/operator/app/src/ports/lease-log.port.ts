// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/lease-log.port`
 * Purpose: IO seams for the lease-log pump (bug.5240) — reading one lease's provider log
 *   window and pushing labeled streams to Loki. Typed here so the pump feature and the HTTP
 *   adapters meet at a port, never at each other.
 * Scope: Types only. Polling policy, label assignment and cursor custody live in the feature;
 *   HTTP mechanics live in the adapters.
 * Invariants:
 *   - NO_TIMESTAMP_ON_THE_WIRE: provider lease logs carry no timestamps; consumers must
 *     assign them (see the pump's tail-merge). The port does not pretend otherwise.
 *   - SCOPED_CREDS_ONLY: the reader takes a caller-supplied ephemeral logs-scoped JWT per
 *     call; no credential is constructor-state, so a leaked adapter instance holds nothing.
 * Side-effects: none (types only)
 * Links: features/compute/lease-log-pump/lease-log-pump.ts,
 *   adapters/server/compute/provider-proxy-logs.adapter.ts,
 *   adapters/server/observability/loki-push.adapter.ts, bug.5240, task.5144
 * @public
 */

/** One provider lease-logs entry. `name` is the emitting pod/replica; no timestamp exists. */
export interface ProviderLeaseLogLine {
  readonly name: string;
  readonly message: string;
}

/** Reads one lease's current log window through the provider (proxy) with an ephemeral JWT. */
export interface ProviderLeaseLogReaderPort {
  read(input: {
    readonly providerHostUri: string;
    readonly providerAccount: string;
    readonly dseq: string;
    readonly gseq: number;
    readonly oseq: number;
    readonly token: string;
    readonly tail: number;
  }): Promise<readonly ProviderLeaseLogLine[]>;
}

/** One Loki push stream: fixed labels + ordered `[tsNs, line]` values. */
export interface LeaseLogStream {
  readonly labels: Readonly<Record<string, string>>;
  readonly values: readonly (readonly [string, string])[];
}

/** Pushes labeled streams to Loki. One call = one push request; batching is the caller's. */
export interface LeaseLogPushPort {
  push(streams: readonly LeaseLogStream[]): Promise<void>;
}
